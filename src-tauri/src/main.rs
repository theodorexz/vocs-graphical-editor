#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State};
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
    let root = fs::canonicalize(&project.root).map_err(|e| format!("Could not resolve the project folder: {e}"))?;
    let base = fs::canonicalize(project.root.join(&project.pages_dir)).map_err(|e| format!("Could not resolve the docs directory: {e}"))?;
    if !base.starts_with(&root) { return Err("The configured docs directory resolves outside the project folder.".into()); }
    let mut found = Vec::new();
    fn walk(base: &Path, dir: &Path, found: &mut Vec<PageInfo>) -> Result<(), String> {
        let entries = match fs::read_dir(dir) { Ok(entries) => entries, Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()), Err(e) => return Err(e.to_string()) };
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") { continue; }
            let file_type = entry.file_type().map_err(|e| e.to_string())?;
            // Don't follow symlinked directories: repositories often link shared
            // workspaces or dependency trees back into the docs tree.
            if file_type.is_symlink() { continue; }
            let path = entry.path();
            if file_type.is_dir() { walk(base, &path, found)?; }
            else if file_type.is_file() && path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("md") || v.eq_ignore_ascii_case("mdx")) {
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
    if !ext.eq_ignore_ascii_case("md") && !ext.eq_ignore_ascii_case("mdx") {
        return Err("Only .md and .mdx pages can be opened here.".into());
    }

    // Lexical checks alone do not protect against a symlink placed inside the
    // docs directory. Resolve the nearest existing ancestor and confirm that
    // it remains beneath the canonical pages root before any read or write.
    let root = fs::canonicalize(&project.root)
        .map_err(|e| format!("Could not resolve the project folder: {e}"))?;
    let base = fs::canonicalize(project.root.join(&project.pages_dir))
        .map_err(|e| format!("Could not resolve the docs directory: {e}"))?;
    if !base.starts_with(&root) {
        return Err("The configured docs directory resolves outside the project folder.".into());
    }
    let target = base.join(relative);
    let mut existing = target.as_path();
    while !existing.exists() {
        existing = existing.parent().ok_or_else(|| "That page path is not allowed.".to_string())?;
    }
    let resolved = fs::canonicalize(existing)
        .map_err(|e| format!("Could not resolve the page path: {e}"))?;
    if !resolved.starts_with(&base) {
        return Err("That page path resolves outside the docs directory.".into());
    }
    if target.exists() {
        let resolved_target = fs::canonicalize(&target)
            .map_err(|e| format!("Could not resolve the page path: {e}"))?;
        if !resolved_target.starts_with(&base) {
            return Err("That page path resolves outside the docs directory.".into());
        }
    }
    Ok(target)
}

fn js_config_tokens(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b.is_ascii_whitespace() { i += 1; continue; }
        if b == b'/' && bytes.get(i + 1) == Some(&b'/') {
            i += 2;
            while i < bytes.len() && bytes[i] != b'\n' { i += 1; }
            continue;
        }
        if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            i += 2;
            while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') { i += 1; }
            i = (i + 2).min(bytes.len());
            continue;
        }
        if b == b'\'' || b == b'"' {
            let quote = b;
            let content_start = i + 1;
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' && i + 1 < bytes.len() { i += 2; }
                else if bytes[i] == quote { break; }
                else { i += 1; }
            }
            let content_end = i;
            if i < bytes.len() { i += 1; }
            let value = String::from_utf8_lossy(&bytes[content_start..content_end])
                .replace("\\'", "'").replace("\\\"", "\"").replace("\\\\", "\\");
            tokens.push(format!("s:{value}"));
            continue;
        }
        if b == b'`' {
            // Templates may contain expressions; treat the whole template as
            // opaque so text inside it cannot masquerade as a config property.
            i += 1;
            while i < bytes.len() {
                if bytes[i] == b'\\' { i = (i + 2).min(bytes.len()); }
                else if bytes[i] == b'`' { i += 1; break; }
                else { i += 1; }
            }
            tokens.push("<template>".into());
            continue;
        }
        if b.is_ascii_alphabetic() || b == b'_' || b == b'$' {
            let start = i;
            i += 1;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_' || bytes[i] == b'$') { i += 1; }
            tokens.push(source[start..i].to_string());
            continue;
        }
        tokens.push((b as char).to_string());
        i += 1;
    }
    tokens
}

fn find_config_object(tokens: &[String]) -> Option<usize> {
    // Only inspect the default-exported Vocs config. This avoids mistaking a
    // helper object or an unrelated defineConfig call for project settings.
    for i in 0..tokens.len().saturating_sub(2) {
        if tokens[i] != "export" || tokens[i + 1] != "default" { continue; }
        match tokens[i + 2].as_str() {
            "{" => return Some(i + 2),
            "defineConfig" if tokens.get(i + 3).map(String::as_str) == Some("(")
                && tokens.get(i + 4).map(String::as_str) == Some("{") => return Some(i + 4),
            name => {
                // A common pattern is `const config = { ... }; export default config`.
                // Also accept a statically declared `const config = defineConfig({ ... })`.
                for j in 0..i.saturating_sub(3) {
                    if !matches!(tokens[j].as_str(), "const" | "let" | "var")
                        || tokens[j + 1] != name || tokens[j + 2] != "=" { continue; }
                    if tokens[j + 3] == "{" { return Some(j + 3); }
                    if tokens[j + 3] == "defineConfig"
                        && tokens.get(j + 4).map(String::as_str) == Some("(")
                        && tokens.get(j + 5).map(String::as_str) == Some("{") {
                        return Some(j + 5);
                    }
                }
            }
        }
    }
    None
}

fn find_static_config_string(source: &str, key: &str) -> Option<String> {
    let tokens = js_config_tokens(source);
    let object = find_config_object(&tokens)?;
    let mut depth = 1_i32;
    let mut i = object + 1;
    while i + 2 < tokens.len() {
        match tokens[i].as_str() {
            "{" => depth += 1,
            "}" => {
                depth -= 1;
                if depth == 0 { break; }
            }
            _ => {}
        }
        if depth == 1 && (tokens[i] == key || tokens[i] == format!("s:{key}")) && tokens[i + 1] == ":" {
            if let Some(value) = tokens[i + 2].strip_prefix("s:") {
                return Some(value.to_string());
            }
            // Resolve a simple top-level string binding, e.g. `const docs = 'docs';`
            // followed by `srcDir: docs`. Dynamic expressions stay unresolved.
            let binding = &tokens[i + 2];
            if binding.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
                && binding.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$') {
                for j in 0..object.saturating_sub(3) {
                    if matches!(tokens[j].as_str(), "const" | "let" | "var")
                        && tokens[j + 1].as_str() == binding.as_str() && tokens[j + 2] == "=" {
                        if let Some(value) = tokens[j + 3].strip_prefix("s:") {
                            return Some(value.to_string());
                        }
                    }
                }
            }
        }
        i += 1;
    }
    None
}

fn contains_markdown(dir: &Path, depth: usize) -> bool {
    // A bounded probe is enough for a plain Markdown folder. Never recursively
    // walk an entire Vocs repository just to decide which pages folder to use.
    if depth > 3 { return false; }
    let Ok(entries) = fs::read_dir(dir) else { return false; };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.eq_ignore_ascii_case("node_modules") || matches!(name.as_str(), "target" | "dist" | "build" | "coverage" | "vendor" | "out") { continue; }
        let Ok(file_type) = entry.file_type() else { continue; };
        if file_type.is_symlink() { continue; }
        let path = entry.path();
        if file_type.is_dir() && contains_markdown(&path, depth + 1) { return true; }
        if file_type.is_file() && path.extension().and_then(|v| v.to_str()).is_some_and(|v| v.eq_ignore_ascii_case("md") || v.eq_ignore_ascii_case("mdx")) { return true; }
    }
    false
}

fn load_project(root: PathBuf, app: &AppHandle) -> Result<ProjectState, String> {
    let package_path = root.join("package.json");
    let package_text = fs::read_to_string(&package_path).ok();
    let package: serde_json::Value = package_text.as_deref().and_then(|text| serde_json::from_str(text).ok()).unwrap_or_default();
    let has_vocs = ["dependencies", "devDependencies", "peerDependencies"].iter().any(|section| package.get(section).and_then(|v| v.get("vocs")).is_some());
    let config_path = CONFIGS.iter().map(|name| root.join(name)).find(|path| path.is_file());
    let config_source = config_path.as_ref().and_then(|p| fs::read_to_string(p).ok());
    let source_dir = config_source.as_deref()
        .and_then(|source| find_static_config_string(source, "srcDir"))
        .and_then(|value| {
            let path = Path::new(&value);
            if path.is_absolute() { return None; }
            let mut parts = Vec::new();
            for component in path.components() {
                match component {
                    Component::Normal(part) => parts.push(part.to_string_lossy().into_owned()),
                    Component::CurDir => {},
                    _ => return None,
                }
            }
            Some(if parts.is_empty() { ".".into() } else { parts.join("/") })
        })
        .unwrap_or_else(|| "src".into());

    let candidates = [format!("{source_dir}/pages"), "src/pages".into(), "pages".into(), "docs/pages".into()];
    let existing_pages = candidates.iter().find(|candidate| root.join(candidate).is_dir()).cloned();
    let markdown_pages = candidates.iter().find(|candidate| root.join(candidate).is_dir() && contains_markdown(&root.join(candidate), 0)).cloned();
    // If the folder is already recognizable as a Vocs project, the configured
    // pages directory is authoritative. In particular, don't search the repo
    // root just because its pages directory is empty: it may contain huge tools,
    // generated assets, and dependency trees.
    let has_root_markdown = if config_path.is_none() && !has_vocs {
        contains_markdown(&root, 0)
    } else {
        false
    };
    if config_path.is_none() && !has_vocs && existing_pages.is_none() && !has_root_markdown {
        return Err("Choose a folder with Markdown pages, or a Vocs project folder.".into());
    }
    let configured_pages = format!("{source_dir}/pages");
    let pages_dir = markdown_pages
        .or_else(|| if has_root_markdown && config_path.is_none() && !has_vocs { Some(".".into()) } else { None })
        .or(existing_pages)
        .unwrap_or(configured_pages);
    if pages_dir != "." { fs::create_dir_all(root.join(&pages_dir)).map_err(|e| format!("Could not create the pages folder: {e}"))?; }
    let project = ProjectState { root, pages_dir, sidebar_source: config_source };
    let user_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&user_dir).map_err(|e| e.to_string())?;
    fs::write(user_dir.join("last-project.json"), serde_json::json!({"root":project.root.to_string_lossy(),"pagesDir":project.pages_dir}).to_string()).map_err(|e| e.to_string())?;
    Ok(project)
}

#[tauri::command]
async fn choose_project(app: AppHandle, state: State<'_, EditorState>) -> Result<Option<ProjectInfo>, String> {
    // Native file dialogs must not block Tauri's main thread: macOS can leave the
    // entire window unresponsive while Finder's folder picker is open. Run the
    // plugin's blocking bridge on a dedicated worker; it dispatches the actual
    // native dialog to the main thread and keeps the WebView event loop free.
    let dialog_app = app.clone();
    let selection = tauri::async_runtime::spawn_blocking(move || {
        dialog_app.dialog().file().set_title("Choose a docs folder or Vocs project").blocking_pick_folder()
    })
    .await
    .map_err(|e| format!("Could not open the folder picker: {e}"))?;
    let Some(selection) = selection else { return Ok(None); };
    let root = selection.into_path().map_err(|_| "Could not read the selected folder path.".to_string())?;
    let load_app = app.clone();
    let project = tauri::async_runtime::spawn_blocking(move || load_project(root, &load_app))
        .await
        .map_err(|e| format!("Could not read the selected docs folder: {e}"))??;
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
    // Re-check after directory creation to close the ordinary symlink path
    // escape case before writing to disk.
    let target = validate_page_path(&project, &file)?;
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

fn emit_preview_status(app: &AppHandle, status: &str) {
    let _ = app.emit("vocs-preview-status", status.to_string());
}

fn package_manager(root: &Path, package: &serde_json::Value) -> (&'static str, Vec<&'static str>) {
    let declared = package.get("packageManager").and_then(|value| value.as_str()).unwrap_or("");
    if declared.starts_with("pnpm") {
        return ("pnpm", if root.join("pnpm-lock.yaml").is_file() { vec!["install", "--prod=false", "--frozen-lockfile"] } else { vec!["install", "--prod=false"] });
    }
    if declared.starts_with("yarn") {
        let has_lock = root.join("yarn.lock").is_file();
        let immutable = root.join(".yarnrc.yml").is_file();
        return ("yarn", if !has_lock { vec!["install"] } else if immutable { vec!["install", "--immutable"] } else { vec!["install", "--frozen-lockfile"] });
    }
    if declared.starts_with("bun") {
        let has_lock = root.join("bun.lock").is_file() || root.join("bun.lockb").is_file();
        return ("bun", if has_lock { vec!["install", "--frozen-lockfile"] } else { vec!["install"] });
    }
    if declared.starts_with("npm") { return if root.join("package-lock.json").is_file() || root.join("npm-shrinkwrap.json").is_file() { ("npm", vec!["ci"]) } else { ("npm", vec!["install"]) }; }
    if root.join("pnpm-lock.yaml").is_file() {
        return ("pnpm", if root.join("pnpm-lock.yaml").is_file() { vec!["install", "--prod=false", "--frozen-lockfile"] } else { vec!["install", "--prod=false"] });
    }
    if root.join("yarn.lock").is_file() {
        let has_lock = root.join("yarn.lock").is_file();
        let immutable = root.join(".yarnrc.yml").is_file();
        return ("yarn", if !has_lock { vec!["install"] } else if immutable { vec!["install", "--immutable"] } else { vec!["install", "--frozen-lockfile"] });
    }
    if root.join("bun.lock").is_file() || root.join("bun.lockb").is_file() {
        let has_lock = root.join("bun.lock").is_file() || root.join("bun.lockb").is_file();
        return ("bun", if has_lock { vec!["install", "--frozen-lockfile"] } else { vec!["install"] });
    }
    if root.join("package-lock.json").is_file() || root.join("npm-shrinkwrap.json").is_file() {
        ("npm", vec!["ci"])
    } else {
        ("npm", vec!["install"])
    }
}

fn manager_command(program: &str, args: &[&str], root: &Path) -> Command {
    #[cfg(windows)]
    let mut command = {
        let mut command = Command::new("cmd");
        command.arg("/C").arg(program).args(args);
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = Command::new(program);
        command.args(args);
        command
    };
    command.current_dir(root);
    #[cfg(target_os = "macos")]
    {
        let path = std::env::var("PATH").unwrap_or_default();
        command.env("PATH", format!("{path}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"));
    }
    command
}

fn dependency_install_error(program: &str, output: std::process::Output) -> String {
    let mut lines: Vec<String> = String::from_utf8_lossy(&output.stdout).lines().chain(String::from_utf8_lossy(&output.stderr).lines()).map(str::to_owned).collect();
    let detail = if lines.len() > 8 { lines.drain(..lines.len() - 8); lines.join("\n") } else { lines.join("\n") };
    let hint = if output.status.code() == Some(127) {
        format!("{program} could not find a required command. Check that Node.js and the selected package manager are installed.")
    } else {
        format!("{program} exited with {}.", output.status)
    };
    if detail.is_empty() { format!("Could not install the project's dependencies. {hint}") }
    else { format!("Could not install the project's dependencies. {hint}\n{}", detail) }
}

fn install_dependencies(app: &AppHandle, root: &Path, package: &serde_json::Value) -> Result<(), String> {
    let (manager, args) = package_manager(root, package);
    emit_preview_status(app, &format!("Installing dependencies with {manager}… This may take a few minutes."));
    let mut command = manager_command(manager, &args, root);
    command.env("NODE_ENV", "development");
    let output = command.output().map_err(|error| {
        format!("Could not run {manager} to install dependencies: {error}. Install Node.js and {manager}, then retry.")
    })?;
    if !output.status.success() { return Err(dependency_install_error(manager, output)); }
    Ok(())
}

#[tauri::command]
async fn preview(app: AppHandle, file: String) -> Result<String, String> {
    // Starting Vocs can take a while (especially on the first run). Keep npm,
    // filesystem reads, and the readiness poll off Tauri's UI/event thread.
    tauri::async_runtime::spawn_blocking(move || preview_blocking(app, file))
        .await
        .map_err(|e| format!("Could not start Vocs preview: {e}"))?
}

fn preview_blocking(app: AppHandle, file: String) -> Result<String, String> {
    let state = app.state::<EditorState>();
    let project = state_project(&state)?;
    let _ = validate_page_path(&project, &file)?;
    let cached_base = state.preview_base.lock().map_err(|e| e.to_string())?.clone();
    let server_is_running = if cached_base.is_some() {
        let mut server = state.server.lock().map_err(|e| e.to_string())?;
        let running = server.as_mut().map(|child| child.try_wait().map(|status| status.is_none())).transpose().map_err(|e| e.to_string())?.unwrap_or(false);
        if !running { if let Some(mut child) = server.take() { let _ = child.kill(); } }
        running
    } else { false };
    if !server_is_running { *state.preview_base.lock().map_err(|e| e.to_string())? = None; }
    let base = if server_is_running {
        let base = cached_base.unwrap_or_default();
        emit_preview_status(&app, "Vocs is already running · opening this page…");
        base
    } else {
        if let Ok(mut old) = state.server.lock() { if let Some(mut child) = old.take() { let _ = child.kill(); } }
        let package_text = fs::read_to_string(project.root.join("package.json")).map_err(|_| "Could not read the project package.json.".to_string())?;
        let package: serde_json::Value = serde_json::from_str(&package_text).map_err(|_| "Could not read the project package.json.".to_string())?;
        let dev_script = package.get("scripts").and_then(|scripts| scripts.get("dev")).and_then(|value| value.as_str()).ok_or_else(|| "This Vocs project has no \"dev\" script. Add one (usually \"vocs dev\") or start the docs server yourself.".to_string())?;
        let (manager, _) = package_manager(&project.root, &package);
        let vocs_cli = project.root.join("node_modules/.bin/vocs");
        let vocs_cli_windows = project.root.join("node_modules/.bin/vocs.cmd");
        let needs_install = !project.root.join("node_modules").is_dir() || (dev_script.contains("vocs") && !vocs_cli.exists() && !vocs_cli_windows.exists());
        if needs_install { install_dependencies(&app, &project.root, &package)?; }
        emit_preview_status(&app, "Starting the Vocs development server…");
        let args = ["run", "dev", "--", "--host", "127.0.0.1"];
        let mut command = manager_command(manager, &args, &project.root);
        command.env("NODE_ENV", "development").stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|e| format!("Could not start Vocs with {manager}: {e}. Install Node.js and {manager}, then retry."))?;
        let (tx, rx) = mpsc::channel::<String>();
        if let Some(stdout) = child.stdout.take() { let tx = tx.clone(); thread::spawn(move || for line in BufReader::new(stdout).lines().flatten() { let _ = tx.send(line); }); }
        if let Some(stderr) = child.stderr.take() { let tx = tx.clone(); thread::spawn(move || for line in BufReader::new(stderr).lines().flatten() { let _ = tx.send(line); }); }
        let began = Instant::now();
        let mut detected = None;
        let mut recent_output = VecDeque::new();
        emit_preview_status(&app, "Waiting for Vocs to become ready…");
        while began.elapsed() < Duration::from_secs(45) {
            while let Ok(line) = rx.try_recv() {
                if recent_output.len() == 8 { recent_output.pop_front(); }
                recent_output.push_back(line.clone());
                if let Some(url) = extract_local_url(&line) { detected = Some(url); break; }
            }
            if detected.is_some() { break; }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                while let Ok(line) = rx.try_recv() { if recent_output.len() == 8 { recent_output.pop_front(); } recent_output.push_back(line); }
                let output = recent_output.into_iter().collect::<Vec<_>>().join("\n");
                let advice = if status.code() == Some(127) { "The dev script could not find its Vocs command. The app tried to restore missing dependencies; check the dev script and package manager output below." } else { "Check the dev script and package manager output below." };
                return Err(if output.is_empty() { format!("The Vocs dev server exited before starting (code {status}). {advice}") } else { format!("The Vocs dev server exited before starting (code {status}). {advice}\n{output}") });
            }
            thread::sleep(Duration::from_millis(150));
        }
        let base = match detected { Some(base) => base, None => { let _ = child.kill(); return Err(format!("Vocs did not start within 45 seconds. Check the project's dev script and port.{}", if recent_output.is_empty() { String::new() } else { format!("\n{}", recent_output.into_iter().collect::<Vec<_>>().join("\n")) })); } };
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


#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_project() -> (PathBuf, ProjectState) {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("vocs-editor-test-{}-{stamp}", std::process::id()));
        fs::create_dir_all(root.join("src/pages")).unwrap();
        let project = ProjectState { root: root.clone(), pages_dir: "src/pages".into(), sidebar_source: None };
        (root, project)
    }

    #[test]
    fn config_src_dir_ignores_comments_and_nested_properties() {
        let source = r#"
            // srcDir: '../wrong'
            export default defineConfig({
              nested: { srcDir: 'nested-wrong' },
              srcDir: './content',
            })
        "#;
        assert_eq!(find_static_config_string(source, "srcDir").as_deref(), Some("./content"));
    }

    #[test]
    fn config_src_dir_supports_a_static_named_export() {
        let source = "const config = { srcDir: 'docs' }; export default config;";
        assert_eq!(find_static_config_string(source, "srcDir").as_deref(), Some("docs"));
    }

    #[test]
    fn config_src_dir_resolves_a_static_string_binding() {
        let source = "const docsDir = './content'; const config = { srcDir: docsDir }; export default config;";
        assert_eq!(find_static_config_string(source, "srcDir").as_deref(), Some("./content"));
    }

    #[test]
    fn page_path_rejects_parent_traversal() {
        let (root, project) = temporary_project();
        assert!(validate_page_path(&project, "../outside.mdx").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn page_path_rejects_symlinks_that_escape_docs() {
        use std::os::unix::fs::symlink;
        let (root, project) = temporary_project();
        let outside = root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.mdx"), "outside").unwrap();
        symlink(&outside, root.join("src/pages/linked")).unwrap();
        assert!(validate_page_path(&project, "linked/secret.mdx").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
