// Drives the running app over the Chrome DevTools Protocol for verification.
// Start the app with:  npx electron . --remote-debugging-port=9333
// Usage: node probe/cdp.mjs '<json actions>'
//   actions: [{"eval": "js"}, {"shot": "file.png"}, {"key": "ArrowDown"}, {"click": "css selector"}, {"type": "text"}, {"wait": ms}, {"until": "js returning truthy", "timeout": ms}]
const PORT = process.env.CDP_PORT ?? 9333;
// Steps come inline as JSON, or from a .json file (easier quoting).
const arg = process.argv[2] ?? '[]';
const actions = JSON.parse(arg.endsWith('.json') ? (await import('node:fs')).readFileSync(arg, 'utf8') : arg);

const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools'));
if (!page) throw new Error('No page target');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    // Never hang a test run on one command (e.g. a screenshot of a window that isn't painting).
    const timer = setTimeout(() => {
      pending.delete(i);
      resolve({ error: { message: `${method} timed out` }, result: {} });
    }, 30000);
    pending.set(i, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text };
  return r.result?.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEYS = { ArrowDown: 40, ArrowUp: 38, ArrowLeft: 37, ArrowRight: 39, Enter: 13, Escape: 27, Tab: 9 };

for (const a of actions) {
  if (a.reload) {
    await send('Page.reload', { ignoreCache: true });
    await sleep(1500);
  }
  if (a.wait) await sleep(a.wait);
  if (a.until) {
    const t = Date.now();
    let v;
    while (!(v = await evaluate(a.until)) && Date.now() - t < (a.timeout ?? 30000)) await sleep(300);
    console.log(`until ${v ? 'ok' : 'TIMEOUT'} (${Date.now() - t} ms): ${a.until.slice(0, 80)}`);
  }
  if (a.eval) console.log('eval →', JSON.stringify(await evaluate(a.eval)));
  if (a.evalFile) {
    const fs = await import('node:fs');
    const v = await evaluate(fs.readFileSync(a.evalFile, 'utf8'));
    console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 1));
  }
  if (a.click) {
    const ok = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(a.click)}); if (!el) return false; el.click(); return true; })()`);
    console.log(`click ${a.click} → ${ok}`);
  }
  if (a.type) await send('Input.insertText', { text: a.type });
  if (a.typeSlow) {
    for (const ch of a.typeSlow) {
      await send('Input.insertText', { text: ch });
      await sleep(90);
    }
  }
  if (a.key) {
    const code = KEYS[a.key];
    const base = { key: a.key, code: /^[0-9]$/.test(a.key) ? `Digit${a.key}` : a.key.length === 1 ? `Key${a.key.toUpperCase()}` : a.key, windowsVirtualKeyCode: code ?? a.key.toUpperCase().charCodeAt(0), modifiers: a.mod ?? 0 };
    const text = a.key === 'Enter' ? '\r' : a.key.length === 1 && !a.mod ? a.key : undefined;
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await sleep(80);
  }
  if (a.shot) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const fs = await import('node:fs');
    if (!r.result?.data) { console.log("shot failed:", r.error?.message); continue; }
    fs.writeFileSync(a.shot, Buffer.from(r.result.data, "base64"));
    console.log('shot →', a.shot);
  }
}
ws.close();
