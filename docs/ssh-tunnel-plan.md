# SSH SOCKS 隧道功能 — 开发计划

> 在 Clash Verge Rev 基础上新增：通过 SSH 协议在本地开启 SOCKS5 隧道转发，
> 支持录入多个服务器（IP / 端口 / 用户名 / 密码 / 本地 SOCKS 监听端口），
> 由用户在 `clash.yaml` 中以 `socks5` 节点对接本地端口完成流量转发。

## 0. 已确认的设计决策

| 决策点 | 选择 |
| --- | --- |
| SSH 实现方式 | **纯 Rust 库 `russh`**（自带 direct-tcpip 通道；不依赖系统 `ssh`） |
| 与 clash 集成 | **只开隧道，不改 clash 配置**；用户自行在 profile 写 `socks5` 节点指向本地端口 |
| UI 位置 | **新建独立页面**（左侧导航新增「SSH 隧道」） |
| 认证方式 | **仅密码认证**（`authenticate_password`）；密钥 / keyboard-interactive 为后续增强 |
| 状态刷新 | **走事件**（后端 `FrontendEvent::SshTunnelStatusChanged` 主动推送，前端 `listen` 后刷新；不轮询） |
| 断线重连 | **自动重连**：会话断开后固定 **3 秒** 重试，直到用户主动停止 |
| 隧道开关 | **单开关**：`enabled`（持久化的运行意图）——开=立即启动并落盘，关=立即停止并落盘；无每隧道独立自启项 |
| 开机自启 | **复用设置中软件自身的「开机自启」开关**；软件被系统自启拉起后由 `init_ssh_tunnels` 恢复所有 `enabled=true` 的隧道（见 §10.2） |

## 1. 功能目标与边界

**做什么**
- App 内管理多个 SSH 服务器条目。
- 每个服务器启动后在 `127.0.0.1:<本地端口>` 起一个 SOCKS5 监听，流量经 SSH 动态转发到该服务器出口（等价于 `ssh -D`）。
- 每个服务器可单独启停、查看实时状态、设置开机自启。

**不做什么**
- 不自动改写 / 注入 clash 配置。
- 当前 `clash.yaml` 已有 `socks-vmiss → 127.0.0.1:10880`、`socks-evoxt → 127.0.0.1:10881`，正是本功能的对接用法。

**录入字段**：名称、服务器 IP/域名、端口（默认 `22`）、用户名、密码、本地 SOCKS 监听端口。
（无「是否开机自启」字段——卡片上的单开关即运行开关；开机时是否拉起由软件设置里的「开机自启」决定。）

## 2. 数据流 / 架构

```
[ssh.tsx 页面] --invoke--> [cmd/ssh.rs] --> [core/ssh SshManager 单例]
        ^                                          |
        | listen(事件)刷新状态                       | russh 会话 + 本地 SOCKS5 监听
        |   ^                                       |  （断开后固定 3s 自动重连）
   [services/cmds.ts]                              v
        ^                                  远端 SSH 服务器 (direct-tcpip)
        |                                          |
   FrontendEvent::SshTunnelStatusChanged <---------+ 状态迁移时推送

配置持久化: SshManager <-> ssh_tunnels.yaml
           （password 字段 AES-GCM 加密，复用现有 with_encryption 路径）
```

隧道生命周期管理仿照现有 `CoreManager`：单例 + 每隧道一个 supervisor 任务，
用 `arc-swap` / `tokio::sync::Notify` 管理会话与启停。

## 3. 后端改动（逐文件）

| 文件 | 改动 |
| --- | --- |
| `src-tauri/Cargo.toml` | 新增依赖 `russh = "0.54"`。SOCKS5 握手自行实现，不引入额外 socks 库 |
| `src-tauri/src/utils/dirs.rs` | 加 `SSH_CONFIG = "ssh_tunnels.yaml"` 常量 + `ssh_tunnels_path()` |
| `src-tauri/src/config/ssh.rs`（新建） | `ISshServer { uid, name, host, port(默认22), username, password, local_port, enabled }`、`ISshConfig { servers: Vec<ISshServer> }`；`new()` / `save_file()` 复用 `help::read_yaml` / `save_yaml`（已自动走 `with_encryption`）。`password` **必须严格照 `verge.rs:209-216` 的加密字段模式**：`Option<String>` + `serialize_with = "serialize_encrypted"` + `deserialize_with = "deserialize_encrypted"` + `skip_serializing_if = "Option::is_none"` + `default`（不能用裸 `String`，否则与 `deserialize_encrypted` 的 `T::default()` 行为对不上） |
| `src-tauri/src/config/mod.rs` | `mod ssh; pub use ssh::*;` |
| `src-tauri/src/core/ssh.rs`（新建，核心） | `SshManager` 单例（沿用现有 `OnceCell` global 模式，与其它 manager 一致）：`get_servers / upsert_server / delete_server / start(uid) / stop(uid) / restart(uid) / stop_all / start_all_enabled / status_map`；内部句柄表 `Mutex<HashMap<uid, TunnelHandle>>`，`TunnelHandle { cancel: CancellationToken/Notify, task: JoinHandle, status: ArcSwap<TunnelStatus> }`；每隧道 supervisor 任务（见 §5）；`TunnelStatus { Stopped / Connecting / Running / Reconnecting / Error(msg) }`（可序列化给前端）。状态变更时调用 `Handle::send_event(FrontendEvent::SshTunnelStatusChanged)` 推送 |
| `src-tauri/src/core/mod.rs` | `pub mod ssh;` + 重导出 `SshManager` |
| `src-tauri/src/core/handle.rs` + `core/notification.rs` | 新增 `FrontendEvent::SshTunnelStatusChanged`（携带 uid + 新状态，或仅作刷新信号）；前端据此 `listen` 刷新（见 §4） |
| `src-tauri/src/cmd/ssh.rs`（新建） | 命令：`get_ssh_servers`（返回时密码置空）、`save_ssh_server`（增/改，**空密码 = 保留原值**，见 §10.1）、`delete_ssh_server`（删除前先 `stop`）、`start_ssh_tunnel`（启动 + `enabled=true` 落盘）、`stop_ssh_tunnel`（停止 + `enabled=false` 落盘，终态不重连）、`get_ssh_tunnel_status`；统一 `CmdResult` + `StringifyErr` |
| `src-tauri/src/cmd/mod.rs` | `pub mod ssh; pub use ssh::*;` |
| `src-tauri/src/lib.rs` | `generate_handler!` 中登记 6 个新命令 |
| `src-tauri/src/utils/resolve/mod.rs` | `resolve_setup_async` 中新增 `init_ssh_tunnels()`，启动时拉起 `enabled = true` 的隧道；**`resolve_reset_async`（退出路径）中新增 `SshManager::global().stop_all()`**，干净释放监听端口与 SSH 会话 |
| `src-tauri/src/module/lightweight/*` | 空闲降载流程中**不得**回收 SSH 隧道任务（隧道为常驻网络服务）；如有遍历回收逻辑需排除 `SshManager`（见 §10.4） |

## 4. 前端改动（逐文件）

| 文件 | 改动 |
| --- | --- |
| `src/pages/ssh.tsx`（新建） | `BasePage`：服务器卡片列表（名称 / 地址 / 本地端口 / 状态徽标 / 启停单开关 / 编辑 / 删除）+ 右上角「新增」；新增/编辑用 `BaseDialog` + 表单（IP、端口默认 22、用户名、密码、本地端口；**无开机自启项**）；**通过 `listen('verge://...SshTunnelStatusChanged')` 事件刷新状态**（不轮询），首屏与重连兜底各拉一次 `get_ssh_servers` + `get_ssh_tunnel_status`。编辑表单密码框留空 = 不修改原密码（占位提示「留空则不修改」） |
| `src/services/cmds.ts` | 6 个 `invoke` 封装 |
| `src/types/`（类型定义） | `ISshServer` / `ISshTunnelStatus` |
| `src/pages/_routers.tsx` | 注册路由 `/ssh` + 导航项（图标如 `TerminalRoundedIcon`，label `layout.components.navigation.tabs.ssh`） |
| `src/locales/en/ssh.json` + `src/locales/zh/ssh.json`（新建） | 页面文案；并在 `en/index.ts`、`zh/index.ts` 注册命名空间 |
| `src/locales/en/layout.json` + `zh/layout.json` | 新增导航 tab key `ssh`（`en` 是 i18n 类型生成源，必须加） |

> 其余 11 个语言缺失键会回退到 `zh` / `en`；可后续 `pnpm i18n:format` 自动补齐对齐。

## 5. russh + SOCKS5 实现细节（核心难点）

每个隧道一个 supervisor 任务。状态每次变更都通过 `Handle::send_event(FrontendEvent::SshTunnelStatusChanged{uid, status})` 推送前端（取代轮询）：

1. 在 `127.0.0.1:<local_port>` 绑定 `TcpListener`（端口占用时按 §10.3 处理：少量重试，最终失败置 `Error`）。
2. **连接循环（固定 3 秒重试）**：置 `Connecting` → `client::connect` → `authenticate_password`
   - 成功 → 置 `Running`，进入 accept 循环；
   - 失败（连接 / 认证 / 网络错误）→ 置 `Reconnecting`，**等待 3 秒后重连**，循环往复，直到收到取消信号。
   - 取消信号在 3 秒等待期间也要能立即打断（`tokio::select!` 同时 `sleep(3s)` 与 `cancel.cancelled()`）。
3. **accept 循环**：每个进来的 TCP 连接 spawn 一个 handler：
   - 自实现 SOCKS5 握手（仅 no-auth 方法 + `CONNECT` 命令，支持 IPv4 / IPv6 / 域名地址类型）。
   - 解析出目标 `host:port` → `session.channel_open_direct_tcpip(host, port, "127.0.0.1", local_port)` 取得通道。
   - `channel.into_stream()` 后用 `tokio::io::copy_bidirectional` 双向转发。
4. **健康检测 → 触发重连**：`select!` 同时监听取消信号、accept 循环、`keepalive`/会话错误。
   - 会话断开（keepalive 失败 / `channel_open` 报会话级错误 / accept 循环返回会话已关闭）→ **回到第 2 步连接循环**，置 `Reconnecting`，3 秒后重连；期间不影响 `enabled` 持久值。
5. **停止**：用户主动停止时取消 `CancellationToken`/`Notify`，终止 supervisor、accept 循环与所有 in-flight handler，drop 会话与 `TcpListener`，置 `Stopped`。**停止是「终态」**：不再自动重连（区别于第 4 步的断线）。

> 重连为**固定 3 秒**间隔（按本次决策），不做指数退避；只要 `enabled`/运行意图仍在，就持续重试。

服务器主机密钥默认 `check_server_key → Ok(true)`（信任优先；指纹校验为后续可选增强，超出本次范围）。

## 6. 构建与验证

- **前端**：本机有 node / pnpm / tsc → 交付时跑 `pnpm typecheck`（必要时 `pnpm i18n:types`）确保通过。
- **后端**：**当前开发环境无 Rust 工具链（无 `cargo` / `rustc`），无法在此编译验证 Rust 代码。** `russh 0.54` 的 API 会严格按已知版本书写；首次在你本地 `cargo build` 时可能需要对极少量 API 调用做微调。
- 端到端验证：`pnpm dev` → 在页面录入一台 SSH 服务器并启动 → 本地端口出现 SOCKS5 监听 → 在 profile 中以 `socks5` 节点对接 → 流量走通。

## 7. 主要风险

1. **russh API 版本差异（最大风险）**：pin `0.54`，按其 `AuthResult` / `channel_open_direct_tcpip` / `into_stream` 接口书写；`check_server_key` 在 0.54 是 async trait 方法，签名需对准；若本地为其他版本可能需小改。引入 russh 会显著增加编译时间与产物体积（crypto 栈），影响 CI / 打包时长。
2. **加密兼容 / 单机性**：密码走现有 AES-GCM `with_encryption` 路径落盘加密。注意 `.encryption_key` 为**单机随机**，`ssh_tunnels.yaml` 换机器 / 经备份恢复后密码不可解密（与现有 WebDAV 密码同样限制，可接受）——备份功能若纳入此文件需提示用户。
3. **端口冲突 / 启动顺序**：本地端口被占用时报错并体现在隧道状态中；保存期还需做重复 / 占用校验（见 §10.3）。
4. **仅密码认证**：很多服务器禁用 password 认证（只收公钥），首版不支持密钥 / keyboard-interactive，需在 UI / 文档注明。
5. **SOCKS5 无认证**：仅绑 `127.0.0.1`、不做 SOCKS 认证，本机任意进程可使用该端口（安全基线，符合 `ssh -D` 行为）。
6. 不触碰 mihomo / clash 运行逻辑，回归风险低。

## 8. 实施顺序

后端（§3，按 Cargo → dirs → config → core → cmd → lib → resolve 顺序）
→ 前端（§4）
→ `pnpm typecheck`
→ 输出构建 / 验证说明。

## 9. 待确认的可选项

1. 主机密钥校验：现按「信任所有」实现，是否需要做指纹确认？（后续增强）
2. 是否在页面顶部加一段提示/示例，说明如何在 profile 中写 `socks5` 节点对接本地端口？
3. russh 版本锁定 `0.54`（已定）；若你本地已有偏好版本可在此调整。

> 已定结论（本轮）：① 状态刷新走**事件**（非轮询）；② 断线后**固定 3 秒**自动重连；③ 仅密码认证。

## 10. 实现约定（补充细节，避免返工）

### 10.1 密码读回-保存往返
- `get_ssh_servers` 返回时 `password` 一律置空（不下发密文 / 明文到前端）。
- `save_ssh_server` 区分新增 / 编辑：
  - 编辑且传入 `password` 为空 → **保留磁盘上的原密码**（按 `uid` 取旧值回填），不得用空值覆盖。
  - 传入非空 → 视为用户改密，覆盖。
- 前端编辑表单密码框占位「留空则不修改」，新增时为必填。

### 10.2 单开关语义（`enabled` = 运行意图）
- 每隧道**只有一个开关**,对应持久化字段 `enabled`,表示「用户希望此隧道处于运行状态」。
- 行为约定:
  - 开关打开 → `start_ssh_tunnel`,同时 `enabled=true` 落盘。
  - 开关关闭 → `stop_ssh_tunnel`,同时 `enabled=false` 落盘;为终态,不触发 §5 的自动重连。
  - 运行态 `TunnelStatus` 仍是瞬时、不落盘;断线时(非用户关闭)在 `enabled=true` 期间按 §5 固定 3 秒重连。
- **开机自启不在本功能内做**:是否随系统启动完全取决于设置里软件自身的「开机自启」开关。
  - 软件被系统自启(或用户手动)拉起 → `resolve_setup_async` 调 `init_ssh_tunnels()` → `start_all_enabled()` 恢复所有 `enabled=true` 的隧道。
  - 软件未设开机自启 → 开机不拉起软件,隧道自然也不启动;下次手动打开软件时再按 `enabled` 恢复。
  - 即:实际「开机就有隧道」= 软件开机自启 **且** 该隧道 `enabled=true`,无需每隧道单独的自启项。

### 10.3 端口校验
- 保存时校验 `local_port`：与其它条目重复 → 拒绝；与 mihomo 端口（mixed-port 等）冲突 → 拒绝或告警。
- 启动绑定 `TcpListener` 失败（被占用）→ 少量重试后置 `Error(端口占用)`，并经事件反馈到前端。

### 10.4 生命周期接入点
- 启动：`resolve_setup_async` → `init_ssh_tunnels()`（`start_all_enabled`）。
- 退出：`resolve_reset_async` → `SshManager::global().stop_all()`。
- lightweight 空闲降载：隧道任务**豁免**回收，保持常驻。

### 10.5 事件契约
- 新增 `FrontendEvent::SshTunnelStatusChanged`，载荷至少含 `uid` 与新 `TunnelStatus`（或仅作「请刷新」信号，前端再拉 `get_ssh_tunnel_status`）。
- 触发时机：`Connecting / Running / Reconnecting / Error / Stopped` 每次状态迁移即推送。
- 前端 `listen` 该事件后更新对应卡片徽标；并保留首屏一次性拉取作兜底。
