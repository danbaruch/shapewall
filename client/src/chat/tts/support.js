// Can this browser run the natural voice? It needs WebAssembly, module
// workers and Web Audio, and roughly 4 GB of device memory (the model takes
// a few hundred MB while it runs). Where it cannot, the reason is shown and
// the system voice reads instead.

export function naturalSupport(nav = globalThis.navigator, scope = globalThis) {
  if (typeof scope.WebAssembly !== 'object') return { ok: false, reason: 'This browser cannot run WebAssembly, which natural voices need.' }
  if (typeof scope.Worker !== 'function')
    return { ok: false, reason: 'This browser cannot run background workers, which natural voices need.' }
  if (!(scope.AudioContext || scope.webkitAudioContext)) return { ok: false, reason: 'This browser cannot play generated audio.' }
  const memory = nav?.deviceMemory
  if (typeof memory === 'number' && memory > 0 && memory < 4) {
    return {
      ok: false,
      reason: `This device has about ${memory} GB of memory and natural voices need about 4 GB, so the system voice reads instead.`,
    }
  }
  return { ok: true, reason: null }
}
