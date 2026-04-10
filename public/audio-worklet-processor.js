/**
 * AudioWorklet processor for capturing microphone audio as PCM16 16kHz mono.
 *
 * Runs in a separate audio thread to avoid blocking the main thread.
 * Accumulates ~100ms of audio before posting a chunk to the main thread.
 *
 * Input: Native sample rate Float32 audio from getUserMedia
 * Output: 16kHz PCM16 Int16Array via MessagePort
 *
 * Issue #873
 */

// eslint-disable-next-line no-undef -- AudioWorkletProcessor is a global in the AudioWorklet scope
class PCMCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // sampleRate is a global in AudioWorkletGlobalScope
    // eslint-disable-next-line no-undef -- AudioWorklet global
    this._ratio = sampleRate / 16000
    // Pre-allocate buffer for ~200ms of input at native sample rate
    // eslint-disable-next-line no-undef -- AudioWorklet global
    this._bufferSize = Math.ceil(sampleRate * 0.2)
    this._buffer = new Float32Array(this._bufferSize)
    this._writePos = 0
    // Send a chunk every ~100ms of 16kHz output (1600 samples at 16kHz)
    this._targetInputSamples = Math.ceil(1600 * this._ratio)
    this._stopped = false

    this.port.addEventListener('message', (event) => {
      if (event.data === 'stop') {
        this._stopped = true
      }
    })
  }

  process(inputs) {
    if (this._stopped) return false

    const input = inputs[0]
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      return true
    }

    const samples = input[0]

    // Copy to accumulation buffer
    for (let i = 0; i < samples.length && this._writePos < this._bufferSize; i++) {
      this._buffer[this._writePos++] = samples[i]
    }

    // Check if we have enough for a chunk
    if (this._writePos >= this._targetInputSamples) {
      const outputLength = Math.floor(this._writePos / this._ratio)
      const int16 = new Int16Array(outputLength)

      // Downsample and convert Float32 → Int16
      for (let i = 0; i < outputLength; i++) {
        const srcIdx = Math.min(Math.floor(i * this._ratio), this._writePos - 1)
        const s = Math.max(-1, Math.min(1, this._buffer[srcIdx]))
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
      }

      // Transfer ownership of the buffer for zero-copy
      this.port.postMessage(int16.buffer, [int16.buffer])
      this._writePos = 0
    }

    return true
  }
}

// eslint-disable-next-line no-undef -- AudioWorklet global
registerProcessor('pcm-capture-processor', PCMCaptureProcessor)
