// Clicks the "Remove <title> from history" button for window.__removeTitle (first match).
(() => {
  const want = window.__removeTitle;
  const b = [...document.querySelectorAll('main button[aria-label]')].find((x) => x.getAttribute('aria-label') === `Remove ${want} from history`);
  if (!b) return `no remove button for ${want}`;
  b.click();
  return `clicked remove ${want}`;
})();
