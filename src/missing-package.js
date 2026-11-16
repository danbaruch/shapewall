// Node's "Cannot find package 'express' imported from ..." means
// Shapewall's own install is incomplete (an interrupted npm install, a
// pruned node_modules). Said plainly, with the fix; null for any other error.
// No imports: the CLI uses this when loading a module has just failed.

export function missingPackageMessage(error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') return null
  const name = /Cannot find package '([^']+)'/.exec(String(error.message || ''))?.[1]
  if (!name) return null
  return `Shapewall's install is incomplete: the package "${name}" is missing from node_modules. Reinstall it ("npm install" in this project, or "npm install -g shapewall" for a global install), then run "shapewall doctor".`
}
