use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    thread,
};
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
struct TerminalState {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<u64, TerminalSession>>,
}

struct TerminalSession {
    master: Box<dyn MasterPty + Send>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: u64,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalExit {
    session_id: u64,
}

#[tauri::command]
fn terminal_start(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: Option<String>,
    rows: u16,
    cols: u16,
) -> Result<u64, String> {
    let pty_system = native_pty_system();
    let pty_pair = pty_system
        .openpty(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let shell = default_shell();
    let mut command = CommandBuilder::new(shell);
    command.env("TERM", "xterm-256color");

    if let Some(cwd) = cwd.filter(|path| !path.trim().is_empty()) {
        command.cwd(cwd);
    }

    let child = pty_pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    let mut reader = pty_pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pty_pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;

    let session_id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    state
        .sessions
        .lock()
        .map_err(|_| "terminal state lock poisoned".to_string())?
        .insert(
            session_id,
            TerminalSession {
                master: pty_pair.master,
                writer: Mutex::new(writer),
                child: Mutex::new(child),
            },
        );

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let data = String::from_utf8_lossy(&buffer[..size]).to_string();
                    let _ = app.emit("terminal-output", TerminalOutput { session_id, data });
                }
                Err(error) => {
                    let _ = app.emit(
                        "terminal-output",
                        TerminalOutput {
                            session_id,
                            data: format!("\r\n[terminal read error] {error}\r\n"),
                        },
                    );
                    break;
                }
            }
        }

        let _ = app.emit("terminal-exit", TerminalExit { session_id });
    });

    Ok(session_id)
}

#[tauri::command]
fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: u64,
    data: String,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state lock poisoned".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "terminal writer lock poisoned".to_string())?;

    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: u64,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal state lock poisoned".to_string())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| "terminal session not found".to_string())?;

    session
        .master
        .resize(PtySize {
            rows: rows.max(8),
            cols: cols.max(20),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn terminal_close(state: State<'_, TerminalState>, session_id: u64) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "terminal state lock poisoned".to_string())?
        .remove(&session_id);

    if let Some(session) = session {
        if let Ok(mut child) = session.child.lock() {
            let _ = child.kill();
        }
    }

    Ok(())
}

fn default_shell() -> String {
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            terminal_start,
            terminal_write,
            terminal_resize,
            terminal_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
