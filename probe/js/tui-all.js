// Prints every non-blank line of the engine screen (box borders and blank pane rows dropped).
window.mb.consoleSnapshot().then((s) =>
  s
    .replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.replace(/[│\s]/g, '').length > 0)
    .join('\n'),
);
