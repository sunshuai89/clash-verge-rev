use crate::{
    config::{deserialize_encrypted, serialize_encrypted},
    utils::{dirs, help},
};
use anyhow::Result;
use clash_verge_logging::{Type, logging};
use serde::{Deserialize, Serialize};
use smartstring::alias::String;

const fn default_ssh_port() -> u16 {
    22
}

/// 单个 SSH SOCKS 隧道服务器条目
#[derive(Default, Debug, Clone, Deserialize, Serialize)]
pub struct ISshServer {
    /// 唯一标识
    pub uid: String,

    /// 显示名称
    pub name: String,

    /// 服务器 IP / 域名
    pub host: String,

    /// SSH 端口，默认 22
    #[serde(default = "default_ssh_port")]
    pub port: u16,

    /// 用户名
    pub username: String,

    /// 密码 (加密存储)，严格沿用 verge.rs 的加密字段模式
    #[serde(
        serialize_with = "serialize_encrypted",
        deserialize_with = "deserialize_encrypted",
        skip_serializing_if = "Option::is_none",
        default
    )]
    pub password: Option<String>,

    /// 本地 SOCKS5 监听端口
    pub local_port: u16,

    /// 运行意图：用户希望此隧道处于运行状态（持久化）
    #[serde(default)]
    pub enabled: bool,
}

/// `ssh_tunnels.yaml` schema
#[derive(Default, Debug, Clone, Deserialize, Serialize)]
pub struct ISshConfig {
    #[serde(default)]
    pub servers: Vec<ISshServer>,
}

impl ISshConfig {
    pub async fn new() -> Self {
        match dirs::ssh_tunnels_path() {
            Ok(path) => match help::read_yaml::<Self>(&path).await {
                Ok(config) => config,
                Err(err) => {
                    logging!(error, Type::Config, "{err}");
                    Self::default()
                }
            },
            Err(err) => {
                logging!(error, Type::Config, "{err}");
                Self::default()
            }
        }
    }

    pub async fn save_file(&self) -> Result<()> {
        let path = dirs::ssh_tunnels_path()?;
        help::save_yaml(&path, self, Some("# SSH Tunnels Config")).await
    }
}
