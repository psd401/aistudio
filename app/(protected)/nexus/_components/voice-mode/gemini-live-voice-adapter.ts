/**
 * Gemini Live Voice Adapter for assistant-ui
 *
 * Implements RealtimeVoiceAdapter to bridge assistant-ui's voice system
 * with our server-side WebSocket proxy at /api/nexus/voice.
 *
 * Responsibilities:
 * - WebSocket connection to voice proxy
 * - Microphone capture via AudioWorklet (PCM16, 16kHz mono)
 * - Audio playback with seamless queueing
 * - Volume measurement via AnalyserNode
 * - Event emission (transcript, mode, volume, status)
 *
 * Security: AudioWorklet processor loaded from /audio-worklet-processor.js (same-origin).
 * The S3 bucket serving static assets must not allow public PutObject.
 * CSP should include worker-src 'self' for defense in depth.
 *
 * Issue #873
 */

import {
  createVoiceSession,
  type RealtimeVoiceAdapter,
  type VoiceSessionHelpers,
  type VoiceSessionControls,
} from '@assistant-ui/react'
import type { VoiceServerMessage } from '@/lib/voice/types'
import { createLogger } from '@/lib/client-logger'

const log = createLogger({ moduleName: 'voice-adapter' })

/** Audio playback sample rate — matches server-side Gemini Live config */
const PLAYBACK_SAMPLE_RATE = 16000

/** AnalyserNode FFT size for volume measurement */
const ANALYSER_FFT_SIZE = 256

/** Volume measurement interval in ms */
const VOLUME_POLL_INTERVAL_MS = 50

/** WebSocket reconnect attempts for transient failures */
const MAX_RECONNECT_ATTEMPTS = 3

/** Delay between reconnect attempts (ms) */
const RECONNECT_DELAY_MS = 1000

/** Max WebSocket bufferedAmount before dropping audio (back-pressure) */
const MAX_BUFFERED_AMOUNT = 65_536

/**
 * Constructs the WebSocket URL for the voice endpoint.
 */
function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/nexus/voice`
}

/**
 * Converts an ArrayBuffer of PCM16 Int16 samples to a base64 string.
 * Uses Array.from + join to avoid O(n²) string concatenation.
 */
function pcmToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  return btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(''))
}

/**
 * Decodes a base64 string to an ArrayBuffer of PCM16 samples.
 */
function base64ToPcm(base64: string): ArrayBuffer {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/** Compute average volume from AnalyserNode frequency data */
function measureVolume(analyser: AnalyserNode, dataArray: Uint8Array<ArrayBuffer>): number {
  analyser.getByteFrequencyData(dataArray)
  let sum = 0
  for (const value of dataArray) {
    sum += value
  }
  return sum / (dataArray.length * 255)
}

/**
 * Runtime validation guard for incoming WebSocket messages.
 * Mirrors the server-side isValidClientMessage() pattern from ws-handler.ts.
 */
function isValidServerMessage(msg: unknown): msg is VoiceServerMessage {
  if (typeof msg !== 'object' || msg === null) return false
  const obj = msg as Record<string, unknown>
  if (typeof obj.type !== 'string') return false
  switch (obj.type) {
    case 'ready':
      return true
    case 'audio':
      return typeof obj.data === 'string'
    case 'transcript': {
      if (typeof obj.entry !== 'object' || obj.entry === null) return false
      const entry = obj.entry as Record<string, unknown>
      return typeof entry.role === 'string'
        && typeof entry.text === 'string'
        && (typeof entry.isFinal === 'boolean' || entry.isFinal === undefined)
    }
    case 'state':
      return typeof obj.speaking === 'string'
    case 'error':
      return typeof obj.message === 'string'
    case 'session_ended':
      return typeof obj.reason === 'string'
    default:
      return false
  }
}

/**
 * Manages audio playback with seamless queueing.
 */
class AudioPlaybackQueue {
  private audioContext: AudioContext
  private analyser: AnalyserNode
  private nextPlayTime = 0
  private activeSources: AudioBufferSourceNode[] = []

  constructor(audioContext: AudioContext, analyser: AnalyserNode) {
    this.audioContext = audioContext
    this.analyser = analyser
  }

  enqueue(pcmData: ArrayBuffer): void {
    const int16 = new Int16Array(pcmData)
    if (int16.length === 0) return

    const float32 = Float32Array.from(int16, (sample) =>
      sample / (sample < 0 ? 0x8000 : 0x7FFF)
    )

    const audioBuffer = this.audioContext.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE)
    audioBuffer.getChannelData(0).set(float32)

    const source = this.audioContext.createBufferSource()
    source.buffer = audioBuffer
    source.connect(this.analyser)

    const now = this.audioContext.currentTime
    const startTime = Math.max(now, this.nextPlayTime)
    source.start(startTime)
    this.nextPlayTime = startTime + audioBuffer.duration

    this.activeSources.push(source)
    source.addEventListener('ended', () => {
      const idx = this.activeSources.indexOf(source)
      if (idx >= 0) this.activeSources.splice(idx, 1)
    })
  }

  clear(): void {
    for (const source of this.activeSources) {
      try { source.stop() } catch { /* Already stopped */ }
    }
    this.activeSources = []
    this.nextPlayTime = 0
  }
}

/**
 * Creates a RealtimeVoiceAdapter that connects to the Gemini Live
 * WebSocket proxy and manages audio capture/playback.
 */
export function createGeminiLiveVoiceAdapter(): RealtimeVoiceAdapter {
  return {
    connect(options) {
      return createVoiceSession(options, (helpers) => {
        const session = new VoiceSession(helpers, options.abortSignal)
        return session.start()
      })
    },
  }
}

/**
 * Manages a single voice session lifecycle: WebSocket, audio I/O, and events.
 * Each instance represents one voice conversation.
 */
class VoiceSession {
  private helpers: VoiceSessionHelpers
  private abortSignal?: AbortSignal
  private ws: WebSocket | null = null
  private mediaStream: MediaStream | null = null
  private captureContext: AudioContext | null = null
  private playbackContext: AudioContext | null = null
  private workletNode: AudioWorkletNode | null = null
  private inputAnalyser: AnalyserNode | null = null
  private outputAnalyser: AnalyserNode | null = null
  private playbackQueue: AudioPlaybackQueue | null = null
  private volumeTimer: ReturnType<typeof setInterval> | null = null
  private isMuted = false
  private reconnectAttempts = 0
  private wakeLock: WakeLockSentinel | null = null

  constructor(helpers: VoiceSessionHelpers, abortSignal?: AbortSignal) {
    this.helpers = helpers
    this.abortSignal = abortSignal
  }

  /** Main entry point — connects and returns session controls. */
  async start(): Promise<VoiceSessionControls> {
    log.info('Voice session starting')
    this.helpers.setStatus({ type: 'starting' })

    this.ws = await this.connectWebSocket()
    log.info('WebSocket connected, waiting for mic permission')

    if (this.helpers.isDisposed()) {
      this.cleanup()
      return { disconnect: () => this.cleanup(), mute: () => undefined, unmute: () => undefined }
    }

    // Attach WS handlers immediately after connect (before async mic setup)
    // so close events during permission prompt are observed
    this.ws.addEventListener('message', (e) => this.handleMessage(e))
    this.ws.addEventListener('close', (e) => this.handleClose(e))

    log.info('Setting up microphone capture')
    await this.setupMicrophoneCapture()
    log.info('Microphone capture ready')

    // Check disposal again after async mic setup
    if (this.helpers.isDisposed()) {
      this.cleanup()
      return { disconnect: () => this.cleanup(), mute: () => undefined, unmute: () => undefined }
    }

    this.setupPlayback()
    await this.resumeAudioContexts()

    this.startVolumePolling()
    await this.acquireWakeLock()

    log.info('Voice session running — listening for audio')
    this.helpers.setStatus({ type: 'running' })
    this.helpers.emitMode('listening')

    return {
      disconnect: () => this.disconnect(),
      mute: () => this.mute(),
      unmute: () => this.unmute(),
    }
  }

  /** Safely close an AudioContext if it's not already closed. */
  private static closeAudioContext(ctx: AudioContext | null): void {
    if (ctx?.state !== 'closed') ctx?.close().catch(() => undefined)
  }

  /** Clean up all audio, WebSocket, and system resources. */
  private cleanup(): void {
    this.wakeLock?.release().catch(() => undefined)
    this.wakeLock = null
    if (this.volumeTimer) {
      clearInterval(this.volumeTimer)
      this.volumeTimer = null
    }
    if (this.workletNode) {
      this.workletNode.port.postMessage('stop')
      this.workletNode.disconnect()
      this.workletNode = null
    }
    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) track.stop()
      this.mediaStream = null
    }
    this.playbackQueue?.clear()
    this.playbackQueue = null
    VoiceSession.closeAudioContext(this.captureContext)
    this.captureContext = null
    VoiceSession.closeAudioContext(this.playbackContext)
    this.playbackContext = null
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close()
    }
    this.ws = null
  }

  /** Connect WebSocket and wait for "ready" signal. */
  private connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const signal = this.abortSignal

      // Pre-check abort signal before initiating connection
      if (signal?.aborted) {
        reject(new Error('Connection aborted'))
        return
      }

      const socket = new WebSocket(getWebSocketUrl())

      const onAbort = () => {
        socket.close()
        reject(new Error('Connection aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      socket.addEventListener('message', (event) => {
        try {
          const parsed: unknown = JSON.parse(event.data as string)
          if (isValidServerMessage(parsed) && parsed.type === 'ready') {
            signal?.removeEventListener('abort', onAbort)
            resolve(socket)
          }
        } catch { /* Ignore parse errors during handshake */ }
      })

      socket.addEventListener('error', () => {
        signal?.removeEventListener('abort', onAbort)
        reject(new Error('WebSocket connection failed'))
      })

      // Use allowlisted error strings — do not expose raw event.reason to UI
      socket.addEventListener('close', (event) => {
        signal?.removeEventListener('abort', onAbort)
        if (event.code === 4001) reject(new Error('Unauthorized — please sign in again'))
        else if (event.code === 4003) reject(new Error('Voice mode is not enabled for your account'))
        else reject(new Error('Connection lost'))
      })
    })
  }

  /** Set up microphone capture with AudioWorklet. */
  private async setupMicrophoneCapture(): Promise<void> {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
    } catch (error) {
      log.error('Microphone setup failed', { error: error instanceof Error ? error.message : String(error) })
      this.cleanup()
      // Use DOMException.name for cross-browser permission detection
      const isPermissionDenied = error instanceof DOMException
        && (error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError')
      throw new Error(
        isPermissionDenied
          ? 'Microphone permission denied. Please allow microphone access and try again.'
          : `Microphone setup failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      )
    }

    this.captureContext = new AudioContext()
    await this.captureContext.audioWorklet.addModule('/audio-worklet-processor.js')

    const source = this.captureContext.createMediaStreamSource(this.mediaStream)
    this.inputAnalyser = this.captureContext.createAnalyser()
    this.inputAnalyser.fftSize = ANALYSER_FFT_SIZE
    this.workletNode = new AudioWorkletNode(this.captureContext, 'pcm-capture-processor')

    source.connect(this.inputAnalyser)
    this.inputAnalyser.connect(this.workletNode)

    // Connect worklet to a silent sink so the audio graph stays active
    // (Web Audio pull-based model requires connection to destination)
    const silentGain = this.captureContext.createGain()
    silentGain.gain.value = 0
    this.workletNode.connect(silentGain)
    silentGain.connect(this.captureContext.destination)

    this.workletNode.port.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      if (this.isMuted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
      // Back-pressure: skip frame if WebSocket send buffer is congested
      if (this.ws.bufferedAmount > MAX_BUFFERED_AMOUNT) return
      this.ws.send(JSON.stringify({ type: 'audio', data: pcmToBase64(event.data) }))
    })
    // Required when using addEventListener (vs onmessage) — starts message dispatch
    this.workletNode.port.start()
  }

  /** Set up audio playback context and queue. */
  private setupPlayback(): void {
    this.playbackContext = new AudioContext()
    this.outputAnalyser = this.playbackContext.createAnalyser()
    this.outputAnalyser.fftSize = ANALYSER_FFT_SIZE
    this.outputAnalyser.connect(this.playbackContext.destination)
    this.playbackQueue = new AudioPlaybackQueue(this.playbackContext, this.outputAnalyser)
  }

  /** Resume AudioContexts (required after user gesture on iOS Safari). */
  private async resumeAudioContexts(): Promise<void> {
    if (this.captureContext?.state === 'suspended') await this.captureContext.resume()
    if (this.playbackContext?.state === 'suspended') await this.playbackContext.resume()
  }

  /** Start polling volume levels from analysers. */
  private startVolumePolling(): void {
    const inputData = new Uint8Array(ANALYSER_FFT_SIZE / 2)
    const outputData = new Uint8Array(ANALYSER_FFT_SIZE / 2)

    this.volumeTimer = setInterval(() => {
      if (this.helpers.isDisposed()) {
        if (this.volumeTimer) clearInterval(this.volumeTimer)
        return
      }
      let volume = 0
      if (this.inputAnalyser && !this.isMuted) {
        volume = Math.max(volume, measureVolume(this.inputAnalyser, inputData))
      }
      if (this.outputAnalyser) {
        volume = Math.max(volume, measureVolume(this.outputAnalyser, outputData))
      }
      this.helpers.emitVolume(volume)
    }, VOLUME_POLL_INTERVAL_MS)
  }

  /** Acquire Screen Wake Lock to prevent screen sleep. */
  private async acquireWakeLock(): Promise<void> {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen')
      }
    } catch { /* Wake Lock not available — graceful degradation */ }
  }

  /** Handle incoming WebSocket messages with runtime validation. */
  private handleMessage(event: MessageEvent): void {
    if (this.helpers.isDisposed()) return
    try {
      const parsed: unknown = JSON.parse(event.data as string)
      if (!isValidServerMessage(parsed)) return
      switch (parsed.type) {
        case 'audio':
          if (this.playbackQueue) this.playbackQueue.enqueue(base64ToPcm(parsed.data))
          break
        case 'transcript':
          this.helpers.emitTranscript({ role: parsed.entry.role, text: parsed.entry.text, isFinal: parsed.entry.isFinal })
          break
        case 'state':
          if (parsed.speaking === 'user') this.helpers.emitMode('listening')
          else if (parsed.speaking === 'assistant') this.helpers.emitMode('speaking')
          break
        case 'error':
          this.helpers.end('error', new Error(parsed.message))
          this.cleanup()
          break
        case 'session_ended':
          this.helpers.end(parsed.reason === 'finished' ? 'finished' : 'cancelled')
          this.cleanup()
          break
      }
    } catch { /* Ignore malformed messages */ }
  }

  /** Handle WebSocket close during active session (potential reconnect). */
  private handleClose(event: CloseEvent): void {
    if (this.helpers.isDisposed()) return

    // Auth errors — use allowlisted message, don't expose event.reason
    if (event.code === 4001 || event.code === 4003) {
      this.helpers.end('error', new Error('Access denied'))
      this.cleanup()
      return
    }

    if (this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
      this.reconnectAttempts++
      setTimeout(async () => {
        if (this.helpers.isDisposed()) return
        try {
          this.ws = await this.connectWebSocket()
          this.ws.addEventListener('message', (e) => this.handleMessage(e))
          this.ws.addEventListener('close', (e) => this.handleClose(e))
          this.reconnectAttempts = 0
          this.helpers.setStatus({ type: 'running' })
        } catch {
          this.helpers.end('error', new Error('Failed to reconnect'))
          this.cleanup()
        }
      }, RECONNECT_DELAY_MS * this.reconnectAttempts)
      return
    }

    this.helpers.end('error', new Error('Connection lost'))
    this.cleanup()
  }

  /** Gracefully end the session. */
  private disconnect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'disconnect' }))
    }
    this.helpers.end('finished')
    this.cleanup() // cleanup() releases wake lock
  }

  /** Mute microphone (stop sending audio). */
  private mute(): void {
    this.isMuted = true
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) track.enabled = false
    }
  }

  /** Unmute microphone (resume sending audio). */
  private unmute(): void {
    this.isMuted = false
    if (this.mediaStream) {
      for (const track of this.mediaStream.getAudioTracks()) track.enabled = true
    }
  }
}
