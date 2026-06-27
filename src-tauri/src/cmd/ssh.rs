use super::{CmdResult, StringifyErr as _};
use crate::{
    config::ISshServer,
    core::{
        SshManager,
        ssh::{SshLogEntry, TunnelStats, TunnelStatus},
    },
    utils::help,
};
use std::collections::HashMap;

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
