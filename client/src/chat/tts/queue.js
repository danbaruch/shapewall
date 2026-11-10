// Speak sentences in order while the next ones are being made: sentence 1
// plays as soon as it is ready, and up to `lookahead` sentences are requested
// ahead of the one playing. The model and the speakers are passed in, so this
// runs the same in tests.
//
// speakQueue({ sentences, synthesize(text) -> Promise<Float32Array>,
//   play(samples) -> Promise, signal, lookahead, onSentence(index) })
//   -> 'done' | 'stopped'. A failed synthesis rejects with error.index set to
//   the first sentence that was not spoken, so the caller can read the rest
//   another way.

export async function speakQueue({ sentences, synthesize, play, signal, lookahead = 2, onSentence = () => {} }) {
  const pending = []
  let next = 0
  const fill = () => {
    while (pending.length < Math.max(1, lookahead) && next < sentences.length) {
      const index = next++
      const job = Promise.resolve()
        .then(() => synthesize(sentences[index]))
        .then(
          (samples) => ({ index, samples }),
          (error) => ({ index, error }),
        )
      pending.push(job)
    }
  }
  fill()
  while (pending.length) {
    if (signal?.aborted) return 'stopped'
    const { index, samples, error } = await pending.shift()
    if (signal?.aborted) return 'stopped'
    if (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      failure.index = index
      throw failure
    }
    fill()
    onSentence(index)
    if (samples?.length) await play(samples)
  }
  return signal?.aborted ? 'stopped' : 'done'
}

// Plays mono Float32 samples through one AudioContext, one buffer after the
// other. Create it inside the click that starts reading (autoplay rules).
export function createPlayer(sampleRate, AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext) {
  let context = null
  let current = null
  return {
    get context() {
      return context
    },
    unlock() {
      if (!AudioContextClass) throw new Error('This browser cannot play audio here.')
      context ??= new AudioContextClass()
      if (context.state === 'suspended') context.resume?.()
      return context
    },
    play(samples) {
      const ctx = this.unlock()
      return new Promise((resolve) => {
        const buffer = ctx.createBuffer(1, samples.length, sampleRate)
        buffer.copyToChannel ? buffer.copyToChannel(samples, 0) : buffer.getChannelData(0).set(samples)
        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.connect(ctx.destination)
        source.onended = () => {
          if (current === source) current = null
          resolve()
        }
        current = source
        source.start()
      })
    },
    stop() {
      const source = current
      current = null
      try {
        source?.stop()
      } catch {
        /* already ended */
      }
      if (context?.state === 'suspended') context.resume?.()
    },
    pause() {
      return context?.suspend?.()
    },
    resume() {
      return context?.resume?.()
    },
    // Frees the audio device (the panel closed). A later play opens a new context.
    close() {
      this.stop()
      const ctx = context
      context = null
      return Promise.resolve()
        .then(() => ctx?.close?.())
        .catch(() => {})
    },
  }
}
