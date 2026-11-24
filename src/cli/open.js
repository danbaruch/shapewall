// Opening a URL in the default browser.

import { spawn } from 'node:child_process'

// Opens a URL in the default browser (xdg-open, open, start), without a
// shell and without waiting. Failing to open is a note, not an error.
export function openerFor(platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [] }
  return { command: 'xdg-open', args: [] }
}

// What a headless box (no opener, or one with no display to open on) prints
// instead of the opener's own error: the link, which is all that matters.
// `extra`: a sentence about the link, such as how long it works.
export const cannotOpenNote = (url, extra = '') => `Couldn't open a browser here; open this link: ${url}${extra ? ` (${extra})` : ''}`

// onCannotOpen: called once when no browser could be opened, before the note;
// what it returns (a sentence or nothing) goes into the note.
export function openBrowser(url, out, { spawnImpl = spawn, onCannotOpen = null } = {}) {
  const { command, args } = openerFor()
  let told = false
  const tell = () => {
    if (told) return
    told = true
    out(cannotOpenNote(url, onCannotOpen?.() || ''))
  }
  try {
    const child = spawnImpl(command, [...args, url], { stdio: 'ignore', detached: true, shell: false, windowsHide: true })
    child.once('error', tell)
    // xdg-open without a desktop to open on exits non-zero. (explorer.exe
    // exits 1 even when it opened the page, so only a non-Windows opener counts.)
    if (process.platform !== 'win32') child.once('exit', (code) => (code ? tell() : null))
    child.unref()
  } catch {
    tell()
  }
}
