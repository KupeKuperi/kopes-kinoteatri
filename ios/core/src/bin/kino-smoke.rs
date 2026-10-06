//! Smoke test of the whole core against live MovieBox: search → details → streams → play, then
//! fetch what AVPlayer would. OWNER: agent "engine" (see GUIDE.md). Placeholder until then.

fn main() {
    let dir = std::env::temp_dir().join("kino-smoke");
    if let Err(e) = kino_core::start(&dir.to_string_lossy()) {
        eprintln!("start failed: {e}");
        std::process::exit(1);
    }
    println!("{}", kino_core::call(r#"{"op":"version"}"#));
}
