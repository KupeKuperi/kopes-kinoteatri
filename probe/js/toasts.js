// Records every toast (they vanish after a few seconds) and returns the ones seen since the last call.
(() => {
  const box = document.querySelector('[aria-live=polite]');
  if (!window.__toastLog) {
    window.__toastLog = [];
    window.__toastSeen = new WeakSet();
    const grab = () =>
      box?.querySelectorAll(':scope > div').forEach((t) => {
        if (window.__toastSeen.has(t)) return;
        window.__toastSeen.add(t);
        window.__toastLog.push(t.innerText.replace(/\s+/g, ' ').trim());
      });
    new MutationObserver(grab).observe(box, { childList: true, subtree: true });
    grab();
  }
  const out = window.__toastLog.splice(0);
  return out.length ? out : ['(no toasts)'];
})();
