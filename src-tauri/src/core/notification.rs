use crate::utils::window_manager::WindowManager;
use clash_verge_logging::{Type, logging};
use serde_json::json;
use smartstring::alias::String;

use tauri::Emitter as _;

#[derive(Debug)]
pub enum FrontendEvent<'a> {
    RefreshClash,
    RefreshVerge,
    NoticeMessage {
        status: &'a str,
        message: String,
    },
    ProfileChanged {
        current_profile_id: &'a String,
    },
    TimerUpdated {
        profile_index: &'a String,
    },
    ProfileUpdateStarted {
        uid: &'a String,
    },
    ProfileUpdateCompleted {
        uid: &'a String,
    },
    SshTunnelStatusChanged {
        uid: String,
        status: serde_json::Value,
    },
    SshTunnelLogs {
        uid: String,
        entries: Vec<serde_json::Value>,
    },
}

#[derive(Debug)]
pub struct NotificationSystem {}

impl NotificationSystem {
    fn serialize_event(event: FrontendEvent) -> (&'static str, Result<serde_json::Value, serde_json::Error>) {
        match event {
            FrontendEvent::RefreshClash => ("verge://refresh-clash-config", Ok(json!("yes"))),
            FrontendEvent::RefreshVerge => ("verge://refresh-verge-config", Ok(json!("yes"))),
            FrontendEvent::NoticeMessage { status, message } => {
                ("verge://notice-message", serde_json::to_value((status, message)))
            }
            FrontendEvent::ProfileChanged { current_profile_id } => ("profile-changed", Ok(json!(current_profile_id))),
            FrontendEvent::TimerUpdated { profile_index } => ("verge://timer-updated", Ok(json!(profile_index))),
            FrontendEvent::ProfileUpdateStarted { uid } => ("profile-update-started", Ok(json!({ "uid": uid }))),
            FrontendEvent::ProfileUpdateCompleted { uid } => ("profile-update-completed", Ok(json!({ "uid": uid }))),
            FrontendEvent::SshTunnelStatusChanged { uid, status } => {
                ("verge://ssh-tunnel-status", Ok(json!({ "uid": uid, "status": status })))
            }
            FrontendEvent::SshTunnelLogs { uid, entries } => {
                ("verge://ssh-tunnel-log", Ok(json!({ "uid": uid, "entries": entries })))
            }
        }
    }

    pub(crate) fn send_event(event: FrontendEvent) {
        // FrontendEvent 借用了外部数据，无法跨线程移动，必须在调用线程上先序列化。
        let (event_name, Ok(payload)) = Self::serialize_event(event) else {
            return;
        };

        // 关键：window.emit() 必须在主线程上执行。
        //
        // 之前直接在 Tauri 异步运行时工作线程上调用 window.emit()，其内部 Webview::eval
        // 在 macOS 上会阻塞等待主线程执行脚本，且阻塞期间持有 Tauri 内部锁。一旦主线程
        // 正在处理前端 IPC（tauri::ipc::protocol::get → AppManager::get_webview）并等待
        // 同一把锁，二者即形成死锁，整个应用卡死（已由 macOS hang 报告确认）。SSH 隧道在
        // 「全部重启 / 连接中」时高频 emit 状态，叠加前端轮询 invoke，极易命中该死锁窗口。
        //
        // 调度回主线程后：该锁只在主线程上获取、eval 内联执行随即释放，与主线程自身的 IPC
        // 处理天然串行，不再出现工作线程持锁阻塞主线程的情况。
        let app = crate::core::handle::Handle::app_handle();
        let _ = app.run_on_main_thread(move || {
            if let Some(window) = WindowManager::get_main_window()
                && let Err(e) = window.emit(event_name, payload)
            {
                logging!(warn, Type::Frontend, "Event emit failed: {}", e);
            }
        });
    }
}
