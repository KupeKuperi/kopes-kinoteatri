// Clicks the first <button> in <main> whose text matches window.__clickText.
(() => {
  const want = window.__clickText;
  const b = [...document.querySelectorAll('main button')].find((x) => x.innerText.replace(/\s+/g, ' ').trim() === want);
  if (!b) return `no button "${want}"`;
  b.click();
  return `clicked "${want}"`;
})();
