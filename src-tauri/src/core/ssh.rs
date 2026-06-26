use crate::{
    config::{ISshConfig, ISshServer},
    singleton,
};
use anyhow::{Result, bail};
use arc_swap::ArcSwap;
use clash_verge_logging::{Type, logging};
use russh::client;
use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    net::{Ipv4Addr, Ipv6Addr},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use futures::future;
use tokio::{
    io::{AsyncReadExt as _, AsyncWriteExt as _},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Notify},
    task::JoinHandle,
};

/// 隧道的瞬时运行状态（推送给前端，不落盘）
#[derive(Debug, Clone, Default, Serialize)]
#[serde(tag = "state", content = "message")]
pub enum TunnelStatus {
    #[default]
    Stopped,
    Connecting,
    Running,
    Reconnecting,
    Error(String),
}

/// 隧道实时指标（累计流量 + 最近一次延迟），仅内存
#[derive(Debug)]
struct TunnelMetrics {
    /// 上行累计字节（本地 → 远端）
    up: AtomicU64,
    /// 下行累计字节（远端 → 本地）
    down: AtomicU64,
    /// 最近一次测得的延迟（毫秒），u64::MAX 表示未知
    latency: AtomicU64,
}

impl TunnelMetrics {
    const fn new() -> Self {
        Self {
            up: AtomicU64::new(0),
            down: AtomicU64::new(0),
            latency: AtomicU64::new(u64::MAX),
        }
    }

    fn set_latency(&self, ms: Option<u64>) {
        self.latency.store(ms.unwrap_or(u64::MAX), Ordering::Relaxed);
    }

    fn latency_ms(&self) -> Option<u64> {
        match self.latency.load(Ordering::Relaxed) {
            u64::MAX => None,
            v => Some(v),
        }
    }
}

/// 推送给前端的隧道快照：状态 + 实时指标
#[derive(Debug, Clone, Serialize)]
pub struct TunnelStats {
    pub status: TunnelStatus,
    pub latency_ms: Option<u64>,
    pub up: u64,
    pub down: u64,
}

/// 每隧道日志环形缓冲的最大条数
const MAX_LOGS_PER_TUNNEL: usize = 500;

/// 一条隧道日志（推送给前端，不落盘）
#[derive(Debug, Clone, Serialize)]
pub struct SshLogEntry {
    /// 本地时间，格式 HH:MM:SS
    pub time: String,
    /// 级别：info / warn / error
    pub level: String,
    /// 日志正文
    pub message: String,
}

/// 取消信号：用户主动停止时触发，终态不重连
struct Cancel {
    flag: AtomicBool,
    notify: Notify,
}

impl Cancel {
    fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_waiters();
    }

    fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    async fn cancelled(&self) {
        loop {
            let notified = self.notify.notified();
            if self.flag.load(Ordering::SeqCst) {
                return;
            }
            notified.await;
            if self.flag.load(Ordering::SeqCst) {
                return;
            }
        }
    }
}

struct TunnelHandle {
    cancel: Arc<Cancel>,
    task: JoinHandle<()>,
    status: Arc<ArcSwap<TunnelStatus>>,
    metrics: Arc<TunnelMetrics>,
}

pub struct SshManager {
    /// 运行中的隧道句柄表
    tunnels: Mutex<HashMap<String, TunnelHandle>>,
    /// 内存中的服务器配置（落盘到 ssh_tunnels.yaml）
    config: Mutex<ISshConfig>,
    /// 每隧道的日志环形缓冲（按 uid，仅内存，不落盘）
    logs: Mutex<HashMap<String, VecDeque<SshLogEntry>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            tunnels: Mutex::new(HashMap::new()),
            config: Mutex::new(ISshConfig::default()),
            logs: Mutex::new(HashMap::new()),
        }
    }

    /// 追加一条隧道日志：写入环形缓冲并推送前端事件
    pub async fn append_log(&self, uid: &str, level: &str, message: impl Into<String>) {
        let entry = SshLogEntry {
            time: chrono::Local::now().format("%H:%M:%S").to_string(),
            level: level.to_string(),
            message: message.into(),
        };
        let value = serde_json::to_value(&entry).unwrap_or(serde_json::Value::Null);
        let mut logs = self.logs.lock().await;
        let buf = logs.entry(uid.to_string()).or_default();
        if buf.len() >= MAX_LOGS_PER_TUNNEL {
            buf.pop_front();
        }
        buf.push_back(entry);
        drop(logs);
        // 使用 spawn 发送事件，避免在隧道任务中同步调用 window.emit()，
        // 防止与主线程 WebKit IPC 处理路径竞争内部互斥锁导致死锁。
        let uid = uid.to_string();
        tokio::spawn(async move {
            crate::core::handle::Handle::notify_ssh_tunnel_log(&uid, value);
        });
    }

    /// 读取某隧道的全部历史日志（首屏 / 重开面板兜底）
    pub async fn get_logs(&self, uid: &str) -> Vec<SshLogEntry> {
        self.logs
            .lock()
            .await
            .get(uid)
            .map(|buf| buf.iter().cloned().collect())
            .unwrap_or_default()
    }

    /// 清空某隧道的历史日志
    pub async fn clear_logs(&self, uid: &str) {
        self.logs.lock().await.remove(uid);
    }

    /// 从磁盘加载配置到内存（启动时调用一次）
    pub async fn load_config(&self) {
        let cfg = ISshConfig::new().await;
        *self.config.lock().await = cfg;
    }

    async fn persist(&self) -> Result<()> {
        let cfg = self.config.lock().await.clone();
        cfg.save_file().await
    }

    /// 返回全部服务器（含密码，内部使用；cmd 层负责置空密码）
    pub async fn list_servers(&self) -> Vec<ISshServer> {
        self.config.lock().await.servers.clone()
    }

    /// 查找单个服务器（含密码）
    pub async fn find_server(&self, uid: &str) -> Option<ISshServer> {
        self.config
            .lock()
            .await
            .servers
            .iter()
            .find(|s| s.uid.as_str() == uid)
            .cloned()
    }

    /// 新增 / 更新服务器，并校验本地端口
    pub async fn upsert_server(&self, server: ISshServer) -> Result<()> {
        // 校验本地端口冲突
        {
            let cfg = self.config.lock().await;
            if cfg
                .servers
                .iter()
                .any(|s| s.uid.as_str() != server.uid.as_str() && s.local_port == server.local_port)
            {
                bail!("本地端口 {} 已被其它隧道占用", server.local_port);
            }
        }
        // 与 mihomo 端口冲突校验
        Self::check_mihomo_port_conflict(server.local_port).await?;

        {
            let mut cfg = self.config.lock().await;
            if let Some(existing) = cfg.servers.iter_mut().find(|s| s.uid.as_str() == server.uid.as_str()) {
                *existing = server.clone();
            } else {
                cfg.servers.push(server.clone());
            }
        }
        self.persist().await?;

        // 若隧道正在运行，重启以应用新配置
        if self.is_active(server.uid.as_str()).await {
            self.restart(server.uid.as_str()).await?;
        }
        Ok(())
    }

    async fn check_mihomo_port_conflict(local_port: u16) -> Result<()> {
        let verge = crate::config::Config::verge().await.data_arc();
        let ports = [verge.verge_mixed_port, verge.verge_socks_port, verge.verge_port];
        if ports.into_iter().flatten().any(|p| p == local_port) {
            bail!("本地端口 {} 与 mihomo 端口冲突", local_port);
        }
        Ok(())
    }

    /// 删除服务器（先停止隧道）
    pub async fn delete_server(&self, uid: &str) -> Result<()> {
        self.stop(uid).await?;
        {
            let mut cfg = self.config.lock().await;
            cfg.servers.retain(|s| s.uid.as_str() != uid);
        }
        self.clear_logs(uid).await;
        self.persist().await
    }

    /// 设置运行意图并落盘
    pub async fn set_enabled(&self, uid: &str, enabled: bool) -> Result<()> {
        let mut cfg = self.config.lock().await;
        match cfg.servers.iter_mut().find(|s| s.uid.as_str() == uid) {
            Some(server) => server.enabled = enabled,
            None => bail!("未找到该 SSH 服务器"),
        }
        drop(cfg);
        self.persist().await
    }

    /// 隧道任务是否存活
    async fn is_active(&self, uid: &str) -> bool {
        self.tunnels
            .lock()
            .await
            .get(uid)
            .is_some_and(|h| !h.task.is_finished())
    }

    /// 启动隧道（不修改 enabled 持久值）
    pub async fn start(&self, uid: &str) -> Result<()> {
        let server = self
            .find_server(uid)
            .await
            .ok_or_else(|| anyhow::anyhow!("未找到该 SSH 服务器"))?;

        {
            let mut tunnels = self.tunnels.lock().await;
            if let Some(existing) = tunnels.get(uid)
                && !existing.task.is_finished()
            {
                return Ok(()); // 已在运行
            }

            let cancel = Arc::new(Cancel::new());
            let status = Arc::new(ArcSwap::from_pointee(TunnelStatus::Connecting));
            let metrics = Arc::new(TunnelMetrics::new());
            let task = tokio::spawn(run_tunnel(
                server,
                Arc::clone(&status),
                Arc::clone(&cancel),
                Arc::clone(&metrics),
            ));
            tunnels.insert(
                uid.to_string(),
                TunnelHandle {
                    cancel,
                    task,
                    status,
                    metrics,
                },
            );
        }
        Ok(())
    }

    /// 停止隧道（终态，不重连）
    pub async fn stop(&self, uid: &str) -> Result<()> {
        let handle = self.tunnels.lock().await.remove(uid);
        if let Some(handle) = handle {
            handle.cancel.cancel();
            // 等待 supervisor 退出，最多等待 5 秒。
            // 超时后放弃等待（任务会在 TCP/SSH 超时后自行退出）。
            let _ = tokio::time::timeout(Duration::from_secs(5), handle.task).await;
        }
        Ok(())
    }

    /// 重启隧道
    pub async fn restart(&self, uid: &str) -> Result<()> {
        self.stop(uid).await?;
        self.start(uid).await
    }

    /// 停止所有隧道（退出时调用）
    pub async fn stop_all(&self) {
        let handles: Vec<(String, TunnelHandle)> = {
            let mut tunnels = self.tunnels.lock().await;
            tunnels.drain().collect()
        };
        // 先批量发送取消信号，再并发等待，避免逐个串行等待累积延迟。
        for (_uid, handle) in &handles {
            handle.cancel.cancel();
        }
        let _ = future::join_all(handles.into_iter().map(|(_uid, h)| {
            tokio::time::timeout(Duration::from_secs(5), h.task)
        }))
        .await;
    }

    /// 启动所有 enabled = true 的隧道（开机恢复）
    pub async fn start_all_enabled(&self) {
        let enabled: Vec<String> = self
            .config
            .lock()
            .await
            .servers
            .iter()
            .filter(|s| s.enabled)
            .map(|s| s.uid.to_string())
            .collect();
        for uid in enabled {
            if let Err(e) = self.start(&uid).await {
                logging!(error, Type::Core, "启动 SSH 隧道 [{uid}] 失败: {e}");
            }
        }
    }

    /// 全部隧道当前状态（未运行的为 Stopped）
    pub async fn status_map(&self) -> HashMap<String, TunnelStatus> {
        // 先读完 uid 列表再释放 config 锁，避免同时持有两把锁。
        let uids: Vec<String> = self
            .config
            .lock()
            .await
            .servers
            .iter()
            .map(|s| s.uid.to_string())
            .collect();
        let tunnels = self.tunnels.lock().await;
        uids.into_iter()
            .map(|uid| {
                let status = tunnels
                    .get(uid.as_str())
                    .map(|h| (**h.status.load()).clone())
                    .unwrap_or(TunnelStatus::Stopped);
                (uid, status)
            })
            .collect()
    }

    /// 全部隧道当前状态 + 实时指标（未运行的为 Stopped / 零值）
    pub async fn stats_map(&self) -> HashMap<String, TunnelStats> {
        // 先读完 uid 列表再释放 config 锁，避免同时持有两把锁。
        let uids: Vec<String> = self
            .config
            .lock()
            .await
            .servers
            .iter()
            .map(|s| s.uid.to_string())
            .collect();
        let tunnels = self.tunnels.lock().await;
        uids.into_iter()
            .map(|uid| {
                let stats = match tunnels.get(uid.as_str()) {
                    Some(h) => TunnelStats {
                        status: (**h.status.load()).clone(),
                        latency_ms: h.metrics.latency_ms(),
                        up: h.metrics.up.load(Ordering::Relaxed),
                        down: h.metrics.down.load(Ordering::Relaxed),
                    },
                    None => TunnelStats {
                        status: TunnelStatus::Stopped,
                        latency_ms: None,
                        up: 0,
                        down: 0,
                    },
                };
                (uid, stats)
            })
            .collect()
    }
}

singleton!(SshManager, SSH_MANAGER);

/// 记录一条隧道日志（落入环形缓冲并推送前端），同时写入应用日志
async fn log_tunnel(uid: &str, level: &str, message: impl Into<String>) {
    let message = message.into();
    match level {
        "error" => logging!(error, Type::Core, "SSH 隧道 [{uid}] {message}"),
        "warn" => logging!(warn, Type::Core, "SSH 隧道 [{uid}] {message}"),
        _ => logging!(info, Type::Core, "SSH 隧道 [{uid}] {message}"),
    }
    SshManager::global().append_log(uid, level, message).await;
}

/// 推送状态迁移到前端，并更新句柄内的状态槽
fn set_status(uid: &str, slot: &Arc<ArcSwap<TunnelStatus>>, status: TunnelStatus) {
    slot.store(Arc::new(status.clone()));
    let value = serde_json::to_value(&status).unwrap_or(serde_json::Value::Null);
    logging!(info, Type::Core, "SSH 隧道 [{uid}] 状态: {status:?}");
    // 使用 spawn 发送事件，避免同步调用 window.emit() 与主线程竞争。
    let uid = uid.to_string();
    tokio::spawn(async move {
        crate::core::handle::Handle::notify_ssh_tunnel_status(&uid, value);
    });
}

/// russh 客户端事件处理：默认信任服务器主机密钥
struct Client;

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

enum AcceptEnd {
    Cancelled,
    SessionLost,
}

/// 每隧道的 supervisor 任务
async fn run_tunnel(
    server: ISshServer,
    status: Arc<ArcSwap<TunnelStatus>>,
    cancel: Arc<Cancel>,
    metrics: Arc<TunnelMetrics>,
) {
    let uid: Arc<str> = Arc::from(server.uid.as_str());
    set_status(&uid, &status, TunnelStatus::Connecting);
    log_tunnel(
        &uid,
        "info",
        format!("启动隧道，本地 SOCKS5 端口 {}", server.local_port),
    )
    .await;

    // 延迟探测：周期性测量到 SSH 服务器的 TCP 连接耗时
    let probe = tokio::spawn(latency_probe(
        server.host.to_string(),
        server.port,
        Arc::clone(&metrics),
        Arc::clone(&cancel),
    ));

    let listener = match bind_listener(&uid, server.local_port, &cancel).await {
        Some(listener) => listener,
        None => {
            if cancel.is_cancelled() {
                set_status(&uid, &status, TunnelStatus::Stopped);
                log_tunnel(&uid, "info", "隧道已停止").await;
            } else {
                let msg = format!("本地端口 {} 绑定失败（被占用）", server.local_port);
                log_tunnel(&uid, "error", msg.clone()).await;
                set_status(&uid, &status, TunnelStatus::Error(msg));
            }
            probe.abort();
            return;
        }
    };
    log_tunnel(
        &uid,
        "info",
        format!("本地监听就绪 127.0.0.1:{}", server.local_port),
    )
    .await;

    // 连接循环：固定 3 秒重连，直到用户主动停止
    loop {
        if cancel.is_cancelled() {
            break;
        }
        set_status(&uid, &status, TunnelStatus::Connecting);
        log_tunnel(
            &uid,
            "info",
            format!(
                "正在连接 {}@{}:{} ...",
                server.username, server.host, server.port
            ),
        )
        .await;
        // 使用 select! 使 SSH 连接阶段可被取消信号中断，
        // 避免 TCP 连接超时（最长约 75 秒）阻塞 stop() 调用。
        let connect_result = tokio::select! {
            result = connect_and_auth(&server) => result,
            _ = cancel.cancelled() => break,
        };
        match connect_result {
            Ok(session) => {
                let session = Arc::new(session);
                set_status(&uid, &status, TunnelStatus::Running);
                log_tunnel(&uid, "info", "认证成功，隧道已就绪").await;
                match accept_loop(&uid, &listener, &session, server.local_port, &metrics, &cancel).await {
                    AcceptEnd::Cancelled => break,
                    AcceptEnd::SessionLost => {
                        if cancel.is_cancelled() {
                            break;
                        }
                        // 断线期间延迟不可用
                        metrics.set_latency(None);
                        set_status(&uid, &status, TunnelStatus::Reconnecting);
                        log_tunnel(&uid, "warn", "连接已断开，3 秒后重连").await;
                        if wait_or_cancel(&cancel).await {
                            break;
                        }
                    }
                }
            }
            Err(e) => {
                if cancel.is_cancelled() {
                    break;
                }
                set_status(&uid, &status, TunnelStatus::Reconnecting);
                log_tunnel(&uid, "error", format!("连接失败: {e}；3 秒后重连")).await;
                if wait_or_cancel(&cancel).await {
                    break;
                }
            }
        }
    }

    probe.abort();
    set_status(&uid, &status, TunnelStatus::Stopped);
    log_tunnel(&uid, "info", "隧道已停止").await;
}

/// 周期性测量到 SSH 服务器的 TCP 连接耗时，作为延迟近似值
async fn latency_probe(host: String, port: u16, metrics: Arc<TunnelMetrics>, cancel: Arc<Cancel>) {
    loop {
        if cancel.is_cancelled() {
            break;
        }
        let start = Instant::now();
        let measured = match tokio::time::timeout(
            Duration::from_secs(5),
            TcpStream::connect((host.as_str(), port)),
        )
        .await
        {
            Ok(Ok(_stream)) => Some(start.elapsed().as_millis() as u64),
            _ => None,
        };
        metrics.set_latency(measured);
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(5)) => {}
            _ = cancel.cancelled() => break,
        }
    }
}

/// 绑定本地监听端口，占用时少量重试
async fn bind_listener(uid: &str, local_port: u16, cancel: &Cancel) -> Option<TcpListener> {
    let addr = format!("127.0.0.1:{local_port}");
    for attempt in 0..3u8 {
        if cancel.is_cancelled() {
            return None;
        }
        match TcpListener::bind(&addr).await {
            Ok(listener) => return Some(listener),
            Err(e) => {
                log_tunnel(
                    uid,
                    "warn",
                    format!("绑定 {addr} 失败（第 {} 次）: {e}", attempt + 1),
                )
                .await;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(500)) => {}
                    _ = cancel.cancelled() => return None,
                }
            }
        }
    }
    None
}

/// 等待 3 秒或取消信号；返回 true 表示已取消
async fn wait_or_cancel(cancel: &Cancel) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_secs(3)) => false,
        _ = cancel.cancelled() => true,
    }
}

/// 建立 SSH 会话并完成密码认证
async fn connect_and_auth(server: &ISshServer) -> Result<client::Handle<Client>> {
    let config = Arc::new(client::Config {
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });

    let mut session = client::connect(config, (server.host.to_string(), server.port), Client).await?;
    let password = server.password.clone().unwrap_or_default();
    let result = session
        .authenticate_password(server.username.to_string(), password.to_string())
        .await?;
    if !result.success() {
        bail!("SSH 密码认证失败");
    }
    Ok(session)
}

/// accept 循环 + 会话健康检测
async fn accept_loop(
    uid: &Arc<str>,
    listener: &TcpListener,
    session: &Arc<client::Handle<Client>>,
    local_port: u16,
    metrics: &Arc<TunnelMetrics>,
    cancel: &Cancel,
) -> AcceptEnd {
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return AcceptEnd::Cancelled,
            _ = wait_session_lost(session) => return AcceptEnd::SessionLost,
            accepted = listener.accept() => {
                match accepted {
                    Ok((stream, peer)) => {
                        if session.is_closed() {
                            return AcceptEnd::SessionLost;
                        }
                        let session = Arc::clone(session);
                        let uid = Arc::clone(uid);
                        let metrics = Arc::clone(metrics);
                        tokio::spawn(async move {
                            if let Err(e) = handle_socks(&uid, stream, session, local_port, &metrics).await {
                                log_tunnel(&uid, "warn", format!("来自 {peer} 的连接结束: {e}")).await;
                            }
                        });
                    }
                    Err(e) => {
                        log_tunnel(uid, "warn", format!("接受本地连接出错: {e}")).await;
                    }
                }
            }
        }
    }
}

/// 轮询会话是否已断开
async fn wait_session_lost(session: &client::Handle<Client>) {
    loop {
        if session.is_closed() {
            return;
        }
        tokio::time::sleep(Duration::from_secs(3)).await;
    }
}

/// 自实现 SOCKS5 握手（no-auth + CONNECT），经 SSH direct-tcpip 转发
async fn handle_socks(
    uid: &str,
    mut stream: TcpStream,
    session: Arc<client::Handle<Client>>,
    local_port: u16,
    metrics: &Arc<TunnelMetrics>,
) -> Result<()> {
    // 握手：版本 + 方法协商
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        bail!("非 SOCKS5 请求");
    }
    let n_methods = head[1] as usize;
    let mut methods = vec![0u8; n_methods];
    stream.read_exact(&mut methods).await?;
    if !methods.contains(&0x00) {
        stream.write_all(&[0x05, 0xFF]).await?;
        bail!("客户端不支持 no-auth 方法");
    }
    stream.write_all(&[0x05, 0x00]).await?;

    // 请求头：VER CMD RSV ATYP
    let mut req = [0u8; 4];
    stream.read_exact(&mut req).await?;
    if req[0] != 0x05 {
        bail!("无效的 SOCKS5 请求");
    }
    if req[1] != 0x01 {
        // 仅支持 CONNECT
        socks_reply(&mut stream, 0x07).await?;
        bail!("不支持的 SOCKS5 命令");
    }

    let host = match req[3] {
        0x01 => {
            let mut addr = [0u8; 4];
            stream.read_exact(&mut addr).await?;
            Ipv4Addr::from(addr).to_string()
        }
        0x04 => {
            let mut addr = [0u8; 16];
            stream.read_exact(&mut addr).await?;
            Ipv6Addr::from(addr).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            stream.read_exact(&mut len).await?;
            let mut domain = vec![0u8; len[0] as usize];
            stream.read_exact(&mut domain).await?;
            String::from_utf8_lossy(&domain).into_owned()
        }
        _ => {
            socks_reply(&mut stream, 0x08).await?;
            bail!("不支持的地址类型");
        }
    };

    let mut port_buf = [0u8; 2];
    stream.read_exact(&mut port_buf).await?;
    let port = u16::from_be_bytes(port_buf);

    // 经 SSH 打开 direct-tcpip 通道
    let channel = match session
        .channel_open_direct_tcpip(host.clone(), port as u32, "127.0.0.1", local_port as u32)
        .await
    {
        Ok(channel) => channel,
        Err(e) => {
            log_tunnel(uid, "warn", format!("转发 {host}:{port} 失败: {e}")).await;
            socks_reply(&mut stream, 0x05).await?;
            return Err(e.into());
        }
    };
    log_tunnel(uid, "info", format!("代理连接 → {host}:{port}")).await;

    // 成功应答：BND.ADDR = 0.0.0.0:0
    stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;

    // 双向转发，分方向累计字节数：本地→远端=上行，远端→本地=下行
    let channel_stream = channel.into_stream();
    let (local_read, local_write) = tokio::io::split(stream);
    let (remote_read, remote_write) = tokio::io::split(channel_stream);
    let (up_res, down_res) = tokio::join!(
        copy_counted(local_read, remote_write, &metrics.up),
        copy_counted(remote_read, local_write, &metrics.down),
    );
    up_res?;
    down_res?;
    Ok(())
}

/// 单向复制并累计字节数（写入计数器）
async fn copy_counted<R, W>(mut reader: R, mut writer: W, counter: &AtomicU64) -> std::io::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await?;
        counter.fetch_add(n as u64, Ordering::Relaxed);
    }
    let _ = writer.shutdown().await;
    Ok(())
}

async fn socks_reply(stream: &mut TcpStream, rep: u8) -> std::io::Result<()> {
    stream.write_all(&[0x05, rep, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await
}
