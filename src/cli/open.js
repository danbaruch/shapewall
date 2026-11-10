// Opening a URL in the default browser.

import { spawn } from 'node:child_process'

// Opens a URL in the default browser (xdg-open, open, start), without a
// shell and without waiting. Failing to open is a note, not an error.
export function openerFor(platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [] }
  if (platform === 'win32') return { command: 'explorer.exe', args: [] }
  return { command: 'xdg-open', args: [] }
}

export function openBrowser(url, out, { spawnImpl = spawn } = {}) {
  const { command, args } = openerFor()
  try {
    const child = spawnImpl(command, [...args, url], { stdio: 'ignore', detached: true, shell: false, windowsHide: true })
    child.once('error', (error) => out(`Could not open a browser (${command}: ${error.code || error.message}); open ${url} yourself.`))
    child.unref()
  } catch (error) {
    out(`Could not open a browser (${error.message}); open ${url} yourself.`)
  }
}
