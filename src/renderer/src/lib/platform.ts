// The system the window runs on, and how its keyboard shortcuts are written.
export const isMac = window.mb.platform === 'darwin';
export const isWindows = window.mb.platform === 'win32';

/** Key names as each system prints them: ⌘ ⌥ ⌃ on a Mac, Ctrl and Alt elsewhere. */
export const keyNames = isMac
  ? { command: '⌘', section: '⌘', control: '⌃' }
  : { command: 'Ctrl', section: 'Alt', control: 'Ctrl' };
