// Describes the open dialog (subtitle chooser): its text, the focused element, and whether the page behind is inert.
(() => {
  const d = document.querySelector('[role=dialog]');
  return {
    open: Boolean(d),
    text: d ? d.innerText.replace(/\s+/g, ' ').trim() : null,
    buttons: d ? [...d.querySelectorAll('button')].map((b) => b.innerText.trim()) : [],
    focused: document.activeElement?.innerText?.trim() ?? null,
    focusInDialog: Boolean(d && d.contains(document.activeElement)),
    behindInert: Boolean(document.querySelector('main')?.closest('[inert]')),
  };
})();
