// What a run that died (killed, power cut) leaves behind: its containers,
// its network and its checkout folder. `agent sandbox run` and `agent sandbox watch` sweep
// them at the start. Only things whose owner process is gone are removed:
// another `shapewall agent` running now keeps its own.

import { OWNER_LABEL, RUN_LABEL } from './runtime.js'
import { processAlive, sweepWorkRoot } from './worktree.js'

const NAME_RE = /^shapewall-(agent|egress)-\d{14}-[a-f0-9]{6}$/

async function removable(runtime, kind, name, isAlive) {
  const args =
    kind === 'network'
      ? ['network', 'inspect', '--format', `{{index .Labels "${OWNER_LABEL}"}}`, name]
      : ['inspect', '--format', `{{index .Config.Labels "${OWNER_LABEL}"}}`, name]
  const found = await runtime.exec(args)
  if (found.code !== 0) return false
  const label = found.stdout.trim()
  // Older resources have no owner label. An unreadable or malformed
  // owner is insufficient evidence to stop another process's resource.
  if (!label || label === '<no value>') return true
  const pid = Number(label)
  return Number.isSafeInteger(pid) && pid > 0 && !isAlive(pid)
}

// -> { containers: [...], networks: [...], folders: [...] } (what was removed)
export async function sweepLeftovers({ runtime, root = null, isAlive = processAlive, log = () => {} }) {
  const removed = { containers: [], networks: [], folders: [] }
  if (runtime) {
    const listed = await runtime.exec(['ps', '-a', '--filter', `label=${RUN_LABEL}`, '--format', '{{.Names}}'])
    for (const name of listed.code === 0 ? listed.stdout.split('\n').map((line) => line.trim()) : []) {
      if (!NAME_RE.test(name)) continue
      if (!(await removable(runtime, 'container', name, isAlive))) continue
      if ((await runtime.exec(['rm', '-f', name])).code === 0) removed.containers.push(name)
    }
    const networks = await runtime.exec(['network', 'ls', '--filter', `label=${RUN_LABEL}`, '--format', '{{.Name}}'])
    for (const name of networks.code === 0 ? networks.stdout.split('\n').map((line) => line.trim()) : []) {
      if (!NAME_RE.test(name)) continue
      if (!(await removable(runtime, 'network', name, isAlive))) continue
      if ((await runtime.exec(['network', 'rm', name])).code === 0) removed.networks.push(name)
    }
  }
  if (root) removed.folders = sweepWorkRoot(root, { isAlive })
  const total = removed.containers.length + removed.networks.length + removed.folders.length
  if (total) log(`removed what earlier runs left: ${[...removed.containers, ...removed.networks, ...removed.folders].join(', ')}`)
  return removed
}
