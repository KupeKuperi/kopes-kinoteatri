//! kino-core: Kope's Kinoteatri for iPhone. The engine (moviebox-tui) behind a small C ABI, and
//! the local server that relays its streams to AVPlayer. Contract: ios/GUIDE.md, include/kino.h.
//!
//! Requests run on one multi-threaded tokio runtime; `kino_call` blocks the calling (background)
//! thread until the answer is ready. Panics never cross into Swift: they become error answers.

pub mod api;
#[cfg(feature = "engine")]
pub mod engine;
pub mod hls;
pub mod server;
#[cfg(not(feature = "engine"))]
pub mod stub;

#[cfg(feature = "engine")]
use engine as backend;
#[cfg(not(feature = "engine"))]
use stub as backend;

use std::ffi::{CStr, CString, c_char};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::Path;
use std::sync::OnceLock;

use api::Request;
use serde_json::{Value, json};

struct Core {
    runtime: tokio::runtime::Runtime,
    server: server::Server,
}

static CORE: OnceLock<Core> = OnceLock::new();

/// Starts the engine and the local server (once; later calls do nothing). The engine keeps its
/// settings, caches and history under `data_dir`.
pub fn start(data_dir: &str) -> Result<(), String> {
    if CORE.get().is_some() {
        return Ok(());
    }
    let base = Path::new(data_dir);
    for (var, sub) in [("MOVIEBOX_CONFIG_DIR", "config"), ("MOVIEBOX_DATA_DIR", "data"), ("MOVIEBOX_CACHE_DIR", "cache")] {
        let dir = base.join(sub);
        std::fs::create_dir_all(&dir).map_err(|e| format!("Can't create {}: {e}", dir.display()))?;
        // SAFETY: set once, at start, before the engine (the only reader) runs anything.
        unsafe { std::env::set_var(var, &dir) };
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("kino-core")
        .build()
        .map_err(|e| format!("Can't start the engine's runtime: {e}"))?;
    let server = runtime.block_on(server::Server::start())?;
    runtime.block_on(backend::init())?;
    // A second, racing start loses here and its runtime is dropped: harmless.
    let _ = CORE.set(Core { runtime, server });
    Ok(())
}

/// Handles one JSON request (see GUIDE.md) and returns the JSON answer. Used by `kino_call`, the
/// smoke CLI and tests.
pub fn call(request: &str) -> String {
    let answer = match (CORE.get(), serde_json::from_str::<Request>(request)) {
        (None, _) => Err("The engine isn't started (kino_start).".to_string()),
        (_, Err(e)) => Err(format!("Bad request: {e}")),
        (Some(core), Ok(req)) => core.runtime.block_on(handle(core, req)),
    };
    match answer {
        Ok(value) => json!({ "ok": true, "value": value }).to_string(),
        Err(error) => json!({ "ok": false, "error": error }).to_string(),
    }
}

fn to_value<T: serde::Serialize>(v: Result<T, String>) -> Result<Value, String> {
    v.and_then(|v| serde_json::to_value(v).map_err(|e| e.to_string()))
}

async fn handle(core: &Core, req: Request) -> Result<Value, String> {
    match req {
        Request::Version => Ok(json!({
            "core": env!("CARGO_PKG_VERSION"),
            "engine": backend::ENGINE_VERSION,
            "mode": if cfg!(feature = "engine") { "engine" } else { "stub" },
        })),
        Request::Search { query } => to_value(backend::search(&query).await),
        Request::Details { id } => to_value(backend::details(&id).await),
        Request::Streams { id, season, episode } => to_value(backend::streams(&id, season, episode).await),
        Request::Play { id, season, episode, stream, subtitles } => {
            let source = backend::resolve(&id, season, episode, stream, subtitles.as_deref()).await?;
            to_value(core.server.open(source).await)
        }
        Request::Stop { session } => {
            core.server.close(&session);
            Ok(Value::Null)
        }
    }
}

// ── C ABI ─────────────────────────────────────────────────────────────────────

fn into_c(s: String) -> *mut c_char {
    // Interior NULs can't cross into C; they never occur in our JSON but are replaced to be safe.
    CString::new(s.replace('\0', " ")).map(CString::into_raw).unwrap_or(std::ptr::null_mut())
}

fn from_c(s: *const c_char) -> Option<String> {
    if s.is_null() {
        return None;
    }
    // SAFETY: the caller passes a NUL-terminated string that outlives this call.
    Some(unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned())
}

/// See include/kino.h.
#[unsafe(no_mangle)]
pub extern "C" fn kino_start(data_dir: *const c_char) -> *mut c_char {
    let Some(dir) = from_c(data_dir) else {
        return into_c("kino_start needs a folder.".into());
    };
    match catch_unwind(AssertUnwindSafe(|| start(&dir))) {
        Ok(Ok(())) => std::ptr::null_mut(),
        Ok(Err(e)) => into_c(e),
        Err(_) => into_c("The engine crashed while starting.".into()),
    }
}

/// See include/kino.h.
#[unsafe(no_mangle)]
pub extern "C" fn kino_call(request_json: *const c_char) -> *mut c_char {
    let request = from_c(request_json).unwrap_or_default();
    let answer = catch_unwind(AssertUnwindSafe(|| call(&request)))
        .unwrap_or_else(|_| json!({ "ok": false, "error": "The engine crashed on this request." }).to_string());
    into_c(answer)
}

/// See include/kino.h.
#[unsafe(no_mangle)]
pub extern "C" fn kino_free(s: *mut c_char) {
    if !s.is_null() {
        // SAFETY: `s` came from CString::into_raw in this crate and is freed once.
        drop(unsafe { CString::from_raw(s) });
    }
}
