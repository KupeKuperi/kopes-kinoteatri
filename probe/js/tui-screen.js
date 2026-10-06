// Prints the engine's current screen as plain text (non-empty lines).
window.mb.consoleSnapshot().then((s) =>
  s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(0, 40)
    .join('\n'),
);
