#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const CONFIGS: [&str; 4] = ["vocs.config.ts", "vocs.config.js", "vocs.config.mjs", "vocs.config.mts"];

#[derive(Clone)]
struct ProjectState {
    root: PathBuf,
    pages_dir: String,
    sidebar_source: Option<String>,
}

#[derive(Default)]
struct EditorState {
    project: Mutex<Option<ProjectState>>,
    server: Mutex<Option<Child>>,
    preview_base: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    path: String,
    title: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    root: String,
    pages_dir: String,
    name: String,
    pages: Vec<PageInfo>,
    sidebar_source: Option<String>,
}

fn state_project(state: &EditorState) -> Result<ProjectState, String> {
    state.project.lock().map_err(|e| e.to_string())?.clone().ok_or_else(|| "Connect a Vocs project first.".to_string())
}

fn project_info(project: &ProjectState) -> Result<ProjectInfo, String> {
    Ok(ProjectInfo {
        root: project.root.to_string_lossy().into_owned(),
        pages_dir: project.pages_dir.clone(),
        name: project.root.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        pages: list_pages_for(project)?,
        sidebar_source: project.sidebar_source.clone(),
    })
}

fn list_pages_for(project: &ProjectState) -> Result<Vec<PageInfo>, String> {
    let base = project.root.join(&project.pages_dir);
    let mut found = Vec::new();
    fn walk(base: &Path, dir: &Path, found: &mut Vec<PageInfo>) -> Result<(), String> {
        let entries = match fs::read_dir(dir) { Ok(entries) => entries, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()), Err(e) => return Err(e.to_string()) };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "node_modules" { continue; }
            let path = entry.path();
            if path.is_dir() { walk(base, &path, found)?; }
            else if path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("md") || v.eq_ignore_ascii_case("mdx")) {
                let relative = path.strip_prefix(base).map_err(|e| e.to_string())?.to_string_lossy().replace('\\', "/");
                let title = Path::new(&relative).file_stem().unwrap_or_default().to_string_lossy().replace(['-', '_'], " ");
                found.push(PageInfo { path: relative, title });
            }
        }
        Ok(())
    }
    walk(&base, &base, &mut found)?;
    found.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(found)
}

fn validate_page_path(project: &ProjectState, file: &str) -> Result<PathBuf, String> {
    let relative = Path::new(file);
    if relative.as_os_str().is_empty() || relative.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err("That page path is not allowed.".into());
    }
    let ext = relative.extension().and_then(|v| v.to_str()).unwrap_or("");
    if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("mdx") { return Err("Only .md and .mdx pages can be opened here.".into()); }
    Ok(project.root.join(&project.pages_dir).join(relative))
}

fn load_project(root: PathBuf, app: &AppHandle) -> Result<ProjectState, String> {
    let package_path = root.join("package.json");
    let package_text = fs::read_to_string(&package_path).map_err(|_| "Choose the Vocs project root—the folder containing package.json.".to_string())?;
    let package: serde_json::Value = serde_json::from_str(&package_text).map_err(|_| "Could not read the project's package.json.".to_string())?;
    let has_vocs = ["dependencies", "devDependencies", "peerDependencies"].iter().any(|section| package.get(section).and_then(|v| v.get("vocs")).is_some());
    let config_path = CONFIGS.iter().map(|name| root.join(name)).find(|path| path.is_file());
    if config_path.is_none() && !has_vocs { return Err("This folder does not look like a Vocs project. Choose its root folder (look for vocs.config.ts and package.json).".into()); }

    let config_source = config_path.as_ref().and_then(|p| fs::read_to_string(p).ok());
    let source_dir = config_source.as_deref().and_then(|source| {
        let marker = "srcDir";
        let at = source.find(marker)?;
        let tail = &source[at + marker.len()..];
        let colon = tail.find(':')?;
        let value = tail[colon + 1..].trim_start();
        let quote = value.chars().next()?;
        if quote != '\'' && quote != '"' { return None; }
        let rest = &value[1..];
        let end = rest.find(quote)?;
        Some(rest[..end].trim_start_matches("./").trim_end_matches('/').to_string())
    }).unwrap_or_else(|| "src".into());

    let candidates = [format!("{source_dir}/pages"), "src/pages".into(), "pages".into(), "docs/pages".into()];
    let pages_dir = candidates.iter().find(|candidate| root.join(candidate).is_dir()).cloned().unwrap_or_else(|| format!("{source_dir}/pages"));
    fs::create_dir_all(root.join(&pages_dir)).map_err(|e| format!("Could not create the pages folder: {e}"))?;
    let project = ProjectState { root, pages_dir, sidebar_source: config_source };
    let user_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&user_dir).map_err(|e| e.to_string())?;
    fs::write(user_dir.join("last-project.json"), serde_json::json!({"root":project.root.to_string_lossy(),"pagesDir":project.pages_dir}).to_string()).map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
fn choose_project(app: AppHandle, state: State<'_, EditorState>) -> Result<Option<ProjectInfo>, String> {
    let Some(selection) = app.dialog().file().set_title("Choose your Vocs project folder").blocking_pick_folder() else { return Ok(None); };
    let root = selection.into_path().map_err(|_| "Could not read the selected folder path.".to_string())?;
    let project = load_project(root, &app)?;
    if let Ok(mut server) = state.server.lock() { if let Some(mut child) = server.take() { let _ = child.kill(); } }
    if let Ok(mut preview) = state.preview_base.lock() { *preview = None; }
    let info = project_info(&project)?;
    *state.project.lock().map_err(|e| e.to_string())? = Some(project);
    Ok(Some(info))
}

#[tauri::command]
fn current_project(state: State<'_, EditorState>) -> Result<Option<ProjectInfo>, String> {
    let project = state.project.lock().map_err(|e| e.to_string())?.clone();
    project.map(|p| project_info(&p)).transpose()
}

#[tauri::command]
fn list_pages(state: State<'_, EditorState>) -> Result<Vec<PageInfo>, String> { list_pages_for(&state_project(&state)?) }

#[tauri::command]
fn read_page(state: State<'_, EditorState>, file: String) -> Result<String, String> {
    let project = state_project(&state)?;
    fs::read_to_string(validate_page_path(&project, &file)?).map_err(|e| format!("Could not read {file}: {e}"))
}

#[tauri::command]
fn save_page(state: State<'_, EditorState>, file: String, content: String) -> Result<serde_json::Value, String> {
    let project = state_project(&state)?;
    let target = validate_page_path(&project, &file)?;
    if let Some(parent) = target.parent() { fs::create_dir_all(parent).map_err(|e| e.to_string())?; }
    fs::write(&target, content).map_err(|e| format!("Could not save {file}: {e}"))?;
    Ok(serde_json::json!({"path":file,"absolutePath":target,"pages":list_pages_for(&project)?}))
}

#[tauri::command]
fn open_folder(app: AppHandle, state: State<'_, EditorState>) -> Result<(), String> {
    let project = state_project(&state)?;
    app.opener().open_path(project.root.to_string_lossy().into_owned(), None::<&str>).map_err(|e| e.to_string())
}

#[tauri::command]
fn open_preview(app: AppHandle, url: String) -> Result<(), String> {
    let allowed = url.strip_prefix("http://").is_some_and(|rest| {
        let authority = rest.split('/').next().unwrap_or("");
        let host = authority.split(':').next().unwrap_or("");
        host == "localhost" || host == "127.0.0.1"
    });
    if !allowed { return Err("Only a local Vocs preview can be opened from this app.".into()); }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

fn extract_local_url(line: &str) -> Option<String> {
    for token in line.split_whitespace() {
        let candidate = token.trim_matches(|c: char| !c.is_ascii_alphanumeric() && !matches!(c, ':' | '/' | '.' | '-' | '_'));
        if let Some(rest) = candidate.strip_prefix("http://") {
            if rest.starts_with("localhost:") || rest.starts_with("127.0.0.1:") {
                let trimmed = candidate.trim_end_matches('/');
                return Some(trimmed.replace("localhost", "127.0.0.1"));
            }
        }
    }
    None
}

#[tauri::command]
fn preview(state: State<'_, EditorState>, file: String) -> Result<String, String> {
    let project = state_project(&state)?;
    let _ = validate_page_path(&project, &file)?;
    let base = if let Some(base) = state.preview_base.lock().map_err(|e| e.to_string())?.clone() { base } else {
        if let Ok(mut old) = state.server.lock() { if let Some(mut child) = old.take() { let _ = child.kill(); } }
        let package_text = fs::read_to_string(project.root.join("package.json")).map_err(|_| "Could not read the project package.json.".to_string())?;
        let package: serde_json::Value = serde_json::from_str(&package_text).map_err(|_| "Could not read the project package.json.".to_string())?;
        if package.get("scripts").and_then(|s| s.get("dev")).is_none() { return Err("This Vocs project has no \"dev\" script. Add one (usually \"vocs dev\") or start the docs server yourself.".into()); }
        #[cfg(windows)]
        let mut command = { let mut c = Command::new("cmd"); c.args(["/C", "npm", "run", "dev", "--", "--host", "127.0.0.1"]); c };
        #[cfg(not(windows))]
        let mut command = { let mut c = Command::new("npm"); c.args(["run", "dev", "--", "--host", "127.0.0.1"]); c };
        command.current_dir(&project.root).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(target_os = "macos")]
        { let path = std::env::var("PATH").unwrap_or_default(); command.env("PATH", format!("{path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")); }
        let mut child = command.spawn().map_err(|e| format!("Could not start Vocs: {e}. Make sure Node.js and npm are installed."))?;
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(stdout) = child.stdout.take() { let tx = tx.clone(); thread::spawn(move || for line in BufReader::new(stdout).lines().flatten() { let _ = tx.send(line); }); }
        if let Some(stderr) = child.stderr.take() { let tx = tx.clone(); thread::spawn(move || for line in BufReader::new(stderr).lines().flatten() { let _ = tx.send(line); }); }
        let began = Instant::now();
        let mut detected = None;
        while began.elapsed() < Duration::from_secs(45) {
            while let Ok(line) = rx.try_recv() { if let Some(url) = extract_local_url(&line) { detected = Some(url); break; } }
            if detected.is_some() { break; }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? { return Err(format!("The Vocs dev server exited before starting (code {status}). Check the project's dev script and dependencies.")); }
            thread::sleep(Duration::from_millis(150));
        }
        let base = detected.ok_or_else(|| { let _ = child.kill(); "Vocs did not start within 45 seconds. Check the project's dev script and port.".to_string() })?;
        *state.server.lock().map_err(|e| e.to_string())? = Some(child);
        *state.preview_base.lock().map_err(|e| e.to_string())? = Some(base.clone());
        base
    };
    let route_path = Path::new(&file).with_extension("");
    let mut parts: Vec<String> = route_path.components().filter_map(|c| match c { Component::Normal(value) => Some(value.to_string_lossy().into_owned()), _ => None }).collect();
    if parts.last().map(String::as_str) == Some("index") { parts.pop(); }
    let route = parts.iter().map(|part| encode_segment(part)).collect::<Vec<_>>().join("/");
    Ok(if route.is_empty() { format!("{base}/") } else { format!("{base}/{route}") })
}

fn encode_segment(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') { encoded.push(byte as char); }
        else { encoded.push_str(&format!("%{byte:02X}")); }
    }
    encoded
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(EditorState::default())
        .invoke_handler(tauri::generate_handler![choose_project, current_project, list_pages, read_page, save_page, preview, open_folder, open_preview])
        .setup(|app| {
            let app_handle = app.handle().clone();
            let saved = app.path().app_data_dir().ok().and_then(|dir| fs::read_to_string(dir.join("last-project.json")).ok()).and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
            if let Some(root) = saved.and_then(|v| v.get("root").and_then(|p| p.as_str()).map(PathBuf::from)) {
                if let Ok(project) = load_project(root, &app_handle) { if let Ok(mut slot) = app.state::<EditorState>().project.lock() { *slot = Some(project); } }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event { if let Ok(mut slot) = app.state::<EditorState>().server.lock() { if let Some(mut child) = slot.take() { let _ = child.kill(); } } }
        });
}
