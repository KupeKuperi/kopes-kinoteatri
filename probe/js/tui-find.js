// Prints the engine screen lines around the first line matching window.__tuiFind (a regex source), or the last 30 lines.
window.mb.consoleSnapshot().then((s) => {
  const lines = s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd());
  const re = window.__tuiFind ? new RegExp(window.__tuiFind) : null;
  const at = re ? lines.findIndex((l) => re.test(l)) : -1;
  const from = at >= 0 ? Math.max(0, at - 2) : Math.max(0, lines.length - 30);
  return lines.slice(from, from + 14).filter((l) => l.trim()).join('\n') || '(nothing)';
});
