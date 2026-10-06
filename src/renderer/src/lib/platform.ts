// The system the window runs on, and how its keyboard shortcuts are written.
export const isMac = window.mb.platform === 'darwin';
export const isWindows = window.mb.platform === 'win32';
/** Opened from a phone's (or any) browser through phone access, not the desktop window. */
export const isWeb = window.mb.platform === 'web';
/** A touch screen without a keyboard: key hints mean nothing there. */
export const isTouch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** This phone, so plays it asks for open here and not on another phone. */
export const deviceId: string = (() => {
  // crypto.randomUUID needs HTTPS; the phone opens the app over plain HTTP on the home network.
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
  try {
    const known = localStorage.getItem('mb.device');
    if (known) return known;
    const id = fresh();
    localStorage.setItem('mb.device', id);
    return id;
  } catch {
    return fresh();
  }
})();

/** Key names as each system prints them: ⌘ ⌥ ⌃ on a Mac, Ctrl and Alt elsewhere. */
export const keyNames = isMac
  ? { command: '⌘', section: '⌘', control: '⌃' }
  : { command: 'Ctrl', section: 'Alt', control: 'Ctrl' };
