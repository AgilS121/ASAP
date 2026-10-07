use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, RunEvent};

/// Proses Node sidecar (jembatan ke Claude Agent SDK) + path untuk menyalakannya ulang.
struct Sidecar {
    child: Mutex<Option<Child>>,
    node: PathBuf,
    script: PathBuf,
    /// waktu restart terakhir — pengaman supaya sidecar yang crash terus tidak di-restart tanpa henti
    restarts: Mutex<Vec<Instant>>,
}

/// true saat app sedang ditutup → sidecar yang berhenti tidak di-restart.
static EXITING: AtomicBool = AtomicBool::new(false);

/// Port + token sesi yang diumumkan sidecar lewat baris `ADE_READY {...}` di stdout.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
struct SidecarInfo {
    port: u16,
    token: String,
}

#[derive(Default)]
struct SidecarReady(Mutex<Option<SidecarInfo>>);

/// (node, server.mjs). Dev: node sistem + folder sidecar di repo.
/// Rilis: node.exe + sidecar dibawa sebagai resource app → tidak butuh Node / folder repo.
fn sidecar_paths(app: &tauri::App) -> Result<(PathBuf, PathBuf), String> {
    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        return Ok((PathBuf::from("node"), repo.join("sidecar").join("server.mjs")));
    }
    let res = app.path().resource_dir().map_err(|e| format!("resource dir: {e}"))?;
    // resource_dir di Windows bisa berawalan \\?\ — sebagian tool (termasuk node) tidak suka
    let res = PathBuf::from(res.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    Ok((res.join("node").join("node.exe"), res.join("sidecar").join("server.mjs")))
}

fn spawn_sidecar(node: &Path, script: &Path) -> std::io::Result<Child> {
    let mut cmd = Command::new(node);
    // stdin di-pipe tapi tidak pernah ditulis: kalau ADE mati dengan cara apa pun (crash,
    // Task Manager), OS menutup pipe ini dan sidecar keluar sendiri — tidak ada agent yatim.
    cmd.arg(script).stdin(Stdio::piped()).stdout(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// Nyalakan sidecar + thread pembaca stdout-nya. Kalau sidecar berhenti tanpa app ditutup,
/// thread itu menyalakannya lagi (UI menyambung ulang sendiri lewat `sidecar_info`).
fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    let sc = app.state::<Sidecar>();
    let mut child = spawn_sidecar(&sc.node, &sc.script)
        .map_err(|e| format!("gagal start sidecar ({} {}): {e}", sc.node.display(), sc.script.display()))?;
    let stdout = child.stdout.take().expect("stdout sidecar di-pipe");
    *sc.child.lock().unwrap() = Some(child);

    let handle = app.clone();
    std::thread::spawn(move || {
        // terus dibaca sampai sidecar mati, supaya pipe tidak penuh dan memblok node
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(json) = line.strip_prefix("ADE_READY ") {
                if let Ok(info) = serde_json::from_str::<SidecarInfo>(json) {
                    *handle.state::<SidecarReady>().0.lock().unwrap() = Some(info);
                }
            }
        }
        // stdout tertutup = sidecar berhenti
        *handle.state::<SidecarReady>().0.lock().unwrap() = None;
        if EXITING.load(Ordering::SeqCst) {
            return;
        }
        let sc = handle.state::<Sidecar>();
        if let Some(mut old) = sc.child.lock().unwrap().take() {
            let _ = old.wait(); // bereskan proses yang sudah mati
        }
        {
            let mut restarts = sc.restarts.lock().unwrap();
            restarts.retain(|t| t.elapsed() < Duration::from_secs(60));
            if restarts.len() >= 5 {
                eprintln!("ADE: sidecar berhenti 5x dalam 1 menit — tidak di-restart lagi");
                return;
            }
            restarts.push(Instant::now());
        }
        std::thread::sleep(Duration::from_secs(1));
        if let Err(e) = start_sidecar(&handle) {
            eprintln!("ADE: restart sidecar gagal: {e}");
        }
    });
    Ok(())
}

/// UI memanggil ini sampai dapat port + token, baru membuka WebSocket.
#[tauri::command]
fn sidecar_info(ready: tauri::State<SidecarReady>) -> Option<SidecarInfo> {
    ready.0.lock().unwrap().clone()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SidecarReady::default())
        .invoke_handler(tauri::generate_handler![sidecar_info])
        .setup(|app| {
            let (node, script) = sidecar_paths(app)?;
            app.manage(Sidecar { child: Mutex::new(None), node, script, restarts: Mutex::new(Vec::new()) });
            start_sidecar(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                EXITING.store(true, Ordering::SeqCst);
                if let Some(mut child) = app.state::<Sidecar>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}
