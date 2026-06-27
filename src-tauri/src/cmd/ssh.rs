use super::{CmdResult, StringifyErr as _};
use crate::{
    config::ISshServer,
    core::{
        SshManager,
        ssh::{SshLogEntry, TunnelStats, TunnelStatus},
    },
    utils::help,
};
use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead as _, KeyInit as _},
};
use anyhow::{Result, bail};
use argon2::Argon2;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, time::Duration};

const fn default_ssh_port() -> u16 {
    22
}

/// 导入 / 导出文件中的单条服务器（明文密码，不走加密字段序列化）
#[derive(Debug, Serialize, Deserialize)]
struct SshPlainServer {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    name: String,
    host: String,
    #[serde(default = "default_ssh_port")]
    port: u16,
    username: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    local_port: u16,
    #[serde(default)]
    enabled: bool,
}

/// 导入文件 schema：支持 `servers:` 列表，或裸的服务器列表
#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SshImportFile {
    Wrapped { servers: Vec<SshPlainServer> },
    Bare(Vec<SshPlainServer>),
}

/// 导出文件 schema（始终为 `servers:` 列表形式）
#[derive(Debug, Serialize)]
struct SshExportFile {
    servers: Vec<SshPlainServer>,
}

// ── 口令加密 bundle（方案 A：Argon2id 派生密钥 + AES-256-GCM）──────────────
//
// 导出文件整体就是一个不透明密文 token：魔数前缀 + base64(salt|nonce|密文)，
// 文件中没有任何可读结构。明文 YAML（含密码）被整体加密，口令不入文件，可跨
// 机器移植；只有持有口令者才能解密。salt / nonce 随机生成并拼进密文 token。

/// 加密导出文件的魔数前缀（含格式版本）；后续格式演进改用 `CVSSH2.` 等
const BUNDLE_MAGIC: &str = "CVSSH1.";
/// Argon2id 盐长度
const SALT_LEN: usize = 16;
/// AES-GCM nonce 长度
const NONCE_LEN: usize = 12;

/// 用口令 + 盐派生 32 字节 AES 密钥（Argon2id 默认参数）
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; 32]> {
    let mut key = [0u8; 32];
    Argon2::default()
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow::anyhow!("密钥派生失败: {e}"))?;
    Ok(key)
}

/// 是否为加密导出文件（按魔数前缀判断）
fn is_encrypted_bundle(text: &str) -> bool {
    text.trim_start().starts_with(BUNDLE_MAGIC)
}

/// 将明文 YAML 加密为单个不透明 token 文本
fn encrypt_bundle(plaintext: &str, passphrase: &str) -> Result<String> {
    let mut salt = [0u8; SALT_LEN];
    getrandom::fill(&mut salt).map_err(|e| anyhow::anyhow!("生成盐失败: {e}"))?;
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut nonce).map_err(|e| anyhow::anyhow!("生成 nonce 失败: {e}"))?;

    let key = derive_key(passphrase, &salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
        .map_err(|e| anyhow::anyhow!("加密失败: {e}"))?;

    // 整文件 = 魔数 + base64(salt || nonce || 密文)
    let mut blob = Vec::with_capacity(SALT_LEN + NONCE_LEN + ciphertext.len());
    blob.extend_from_slice(&salt);
    blob.extend_from_slice(&nonce);
    blob.extend_from_slice(&ciphertext);
    Ok(format!("{BUNDLE_MAGIC}{}", STANDARD.encode(blob)))
}

/// 用口令解密 token，返回明文 YAML
fn decrypt_bundle(token: &str, passphrase: &str) -> Result<String> {
    let b64 = token
        .trim()
        .strip_prefix(BUNDLE_MAGIC)
        .ok_or_else(|| anyhow::anyhow!("不是有效的加密配置"))?;
    let blob = STANDARD.decode(b64).map_err(|e| anyhow::anyhow!("密文格式错误: {e}"))?;
    if blob.len() <= SALT_LEN + NONCE_LEN {
        bail!("加密配置已损坏");
    }
    let (salt, rest) = blob.split_at(SALT_LEN);
    let (nonce, ciphertext) = rest.split_at(NONCE_LEN);

    let key = derive_key(passphrase, salt)?;
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key));
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| anyhow::anyhow!("解密失败：口令错误或文件已损坏"))?;
    String::from_utf8(plaintext).map_err(|e| anyhow::anyhow!("明文不是合法 UTF-8: {e}"))
}

/// 获取全部 SSH 服务器（返回时密码一律置空，不下发到前端）
#[tauri::command]
pub async fn get_ssh_servers() -> CmdResult<Vec<ISshServer>> {
    let mut servers = SshManager::global().list_servers().await;
    for server in &mut servers {
        server.password = None;
    }
    Ok(servers)
}

/// 新增 / 编辑 SSH 服务器（空密码 = 保留原值）
#[tauri::command]
pub async fn save_ssh_server(mut server: ISshServer) -> CmdResult<()> {
    let manager = SshManager::global();

    if server.uid.trim().is_empty() {
        server.uid = help::get_uid("ssh").into();
    }

    // 编辑且密码为空 → 按 uid 回填磁盘上的原密码；非空 → 覆盖
    let password_empty = server.password.as_ref().is_none_or(|p| p.is_empty());
    if password_empty {
        if let Some(existing) = manager.find_server(&server.uid).await {
            server.password = existing.password;
        } else {
            server.password = None;
        }
    }

    manager.upsert_server(server).await.stringify_err()
}

/// 删除 SSH 服务器（删除前先停止隧道）
#[tauri::command]
pub async fn delete_ssh_server(uid: String) -> CmdResult<()> {
    SshManager::global().delete_server(&uid).await.stringify_err()
}

/// 启动隧道：运行意图 enabled = true 落盘后启动
#[tauri::command]
pub async fn start_ssh_tunnel(uid: String) -> CmdResult<()> {
    let manager = SshManager::global();
    manager.set_enabled(&uid, true).await.stringify_err()?;
    manager.start(&uid).await.stringify_err()
}

/// 启用并启动全部隧道（前端「全部开启」）：后端单次落盘后逐个启动，
/// 避免前端并发调用 start_ssh_tunnel 并发写配置文件
#[tauri::command]
pub async fn start_all_ssh_tunnels() -> CmdResult<()> {
    SshManager::global().enable_and_start_all().await.stringify_err()
}

/// 重启全部已启用隧道（前端「全部重启」，当全部隧道均已开启时）
#[tauri::command]
pub async fn restart_all_ssh_tunnels() -> CmdResult<()> {
    SshManager::global().restart_all_enabled().await.stringify_err()
}

/// 将一段配置文本（加密 bundle 或明文 YAML）解析为待导入的 SSH 服务器列表。
/// 若文本是加密 bundle，则需要 passphrase 解密；明文则忽略 passphrase。
fn parse_import_text(text: &str, passphrase: Option<&str>) -> Result<Vec<ISshServer>> {
    // 加密导出文件以魔数前缀开头；命中则用口令解密得到明文 YAML，否则按明文处理。
    let plain_yaml = if is_encrypted_bundle(text) {
        let pass = passphrase
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| anyhow::anyhow!("该配置已加密，请输入口令"))?;
        decrypt_bundle(text, pass)?
    } else {
        text.to_string()
    };

    let parsed: SshImportFile =
        serde_yaml_ng::from_str(&plain_yaml).map_err(|e| anyhow::anyhow!("配置解析失败: {e}"))?;
    let raw = match parsed {
        SshImportFile::Wrapped { servers } => servers,
        SshImportFile::Bare(servers) => servers,
    };
    if raw.is_empty() {
        bail!("配置文件中没有可导入的 SSH 服务器");
    }

    let servers = raw
        .into_iter()
        .map(|s| ISshServer {
            uid: help::get_uid("ssh").into(),
            name: if s.name.trim().is_empty() {
                s.host.clone().into()
            } else {
                s.name.into()
            },
            host: s.host.into(),
            port: if s.port == 0 { 22 } else { s.port },
            username: s.username.into(),
            password: s.password.filter(|p| !p.is_empty()).map(Into::into),
            local_port: s.local_port,
            enabled: s.enabled,
        })
        .collect();
    Ok(servers)
}

/// 拉取订阅链接并解析为待导入的 SSH 服务器列表
async fn fetch_import_servers(url: &str, passphrase: Option<&str>) -> Result<Vec<ISshServer>> {
    let text = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?
        .get(url)
        .header("User-Agent", "clash-verge-rev")
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    parse_import_text(&text, passphrase)
}

/// 通过订阅链接导入隧道服务器：清空当前全部配置后写入并按状态启动，返回导入数量。
/// `passphrase` 仅在链接指向加密 bundle 时需要；明文配置可留空。
#[tauri::command]
pub async fn import_ssh_servers(url: String, passphrase: Option<String>) -> CmdResult<usize> {
    let servers = fetch_import_servers(&url, passphrase.as_deref())
        .await
        .stringify_err()?;
    let count = servers.len();
    SshManager::global().import_servers(servers).await.stringify_err()?;
    Ok(count)
}

/// 将当前全部 SSH 服务器（含密码）用口令加密为 bundle，写入用户选择的 `path`，
/// 供托管后订阅导入。文件写入在后端完成，避免前端 fs 插件作用域限制。
#[tauri::command]
pub async fn export_ssh_servers(path: String, passphrase: String) -> CmdResult<()> {
    if passphrase.trim().is_empty() {
        return Err("口令不能为空".into());
    }
    let servers = SshManager::global().list_servers().await;
    if servers.is_empty() {
        return Err("没有可导出的 SSH 服务器".into());
    }

    let export = SshExportFile {
        servers: servers
            .into_iter()
            .map(|s| SshPlainServer {
                name: s.name.to_string(),
                host: s.host.to_string(),
                port: s.port,
                username: s.username.to_string(),
                password: s.password.map(|p| p.to_string()).filter(|p| !p.is_empty()),
                local_port: s.local_port,
                enabled: s.enabled,
            })
            .collect(),
    };

    let plain_yaml = serde_yaml_ng::to_string(&export).stringify_err()?;
    let bundle = encrypt_bundle(&plain_yaml, &passphrase).stringify_err()?;
    tokio::fs::write(&path, bundle).await.stringify_err()
}

/// 停止隧道：运行意图 enabled = false 落盘后停止（终态不重连）
#[tauri::command]
pub async fn stop_ssh_tunnel(uid: String) -> CmdResult<()> {
    let manager = SshManager::global();
    manager.set_enabled(&uid, false).await.stringify_err()?;
    manager.stop(&uid).await.stringify_err()
}

/// 获取全部隧道当前状态
#[tauri::command]
pub async fn get_ssh_tunnel_status() -> CmdResult<HashMap<String, TunnelStatus>> {
    Ok(SshManager::global().status_map().await)
}

/// 获取全部隧道当前状态 + 实时指标（延迟 / 上下行）
#[tauri::command]
pub async fn get_ssh_tunnel_stats() -> CmdResult<HashMap<String, TunnelStats>> {
    Ok(SshManager::global().stats_map().await)
}

/// 获取某隧道的历史日志（首屏 / 重开面板兜底，实时更新走事件）
#[tauri::command]
pub async fn get_ssh_tunnel_logs(uid: String) -> CmdResult<Vec<SshLogEntry>> {
    Ok(SshManager::global().get_logs(&uid).await)
}

/// 清空某隧道的历史日志
#[tauri::command]
pub async fn clear_ssh_tunnel_logs(uid: String) -> CmdResult<()> {
    SshManager::global().clear_logs(&uid).await;
    Ok(())
}
