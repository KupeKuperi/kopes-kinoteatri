// Kope's Kinoteatri for iPhone: the engine core (kino-core, Rust) as seen from Swift.
// Requests and answers are JSON; the full contract is in ios/GUIDE.md.
#ifndef KINO_H
#define KINO_H

#ifdef __cplusplus
extern "C" {
#endif

/// Starts the engine and its local stream server; call once, before anything else.
/// `data_dir`: a writable folder for the engine's settings, caches and history.
/// Returns NULL on success, otherwise an error message (free it with kino_free).
char *kino_start(const char *data_dir);

/// One request, e.g. {"op":"search","query":"Inception"}.
/// Returns {"ok":true,"value":...} or {"ok":false,"error":"..."}; free it with kino_free.
/// Blocks until the answer is ready (network): call it off the main thread.
char *kino_call(const char *request_json);

/// Frees a string returned by kino_start or kino_call.
void kino_free(char *s);

#ifdef __cplusplus
}
#endif

#endif
