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
 * Issue #873
 */

import {
  createVoiceSession,
  type RealtimeVoiceAdapter,
  type VoiceSessionHelpers,
  type VoiceSessionControls,
} from '@assistant-ui/react'
import type { VoiceServerMessage } from '@/lib/voice/types'

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

/**
 * Constructs the WebSocket URL for the voice endpoint.
 */
function getWebSocketUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${protocol}//${window.location.host}/api/nexus/voice`
}

/**
 * Converts an ArrayBuffer of PCM16 Int16 samples to a base64 string.
 */
function pcmToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
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
    this.helpers.setStatus({ type: 'starting' })

    this.ws = await this.connectWebSocket()

    if (this.helpers.isDisposed()) {
      this.cleanup()
      return { disconnect: () => this.cleanup(), mute: () => undefined, unmute: () => undefined }
    }

    await this.setupMicrophoneCapture()
    this.setupPlayback()
    await this.resumeAudioContexts()

    this.ws.addEventListener('message', (e) => this.handleMessage(e))
    this.ws.addEventListener('close', (e) => this.handleClose(e))

    this.startVolumePolling()
    await this.acquireWakeLock()

    this.helpers.setStatus({ type: 'running' })
    this.helpers.emitMode('listening')

    return {
      disconnect: () => this.disconnect(),
      mute: () => this.mute(),
      unmute: () => this.unmute(),
    }
  }

  /** Clean up all audio, WebSocket, and system resources. */
  private cleanup(): void {
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
    if (this.captureContext?.state !== 'closed') {
      this.captureContext?.close().catch(() => undefined)
    }
    this.captureContext = null
    if (this.playbackContext?.state !== 'closed') {
      this.playbackContext?.close().catch(() => undefined)
    }
    this.playbackContext = null
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.ws.close()
    }
    this.ws = null
  }

  /** Connect WebSocket and wait for "ready" signal. */
  private connectWebSocket(): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(getWebSocketUrl())
      const signal = this.abortSignal

      const onAbort = () => {
        socket.close()
        reject(new Error('Connection aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      socket.addEventListener('message', (event) => {
        try {
          const msg: VoiceServerMessage = JSON.parse(event.data as string)
          if (msg.type === 'ready') {
            signal?.removeEventListener('abort', onAbort)
            resolve(socket)
          }
        } catch { /* Ignore parse errors during handshake */ }
      })

      socket.addEventListener('error', () => {
        signal?.removeEventListener('abort', onAbort)
        reject(new Error('WebSocket connection failed'))
      })

      socket.addEventListener('close', (event) => {
        signal?.removeEventListener('abort', onAbort)
        if (event.code === 4001) reject(new Error('Unauthorized — please sign in again'))
        else if (event.code === 4003) reject(new Error('Voice mode is not enabled for your account'))
        else reject(new Error(`Connection closed: ${event.reason || 'unknown reason'}`))
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
      this.cleanup()
      const message = error instanceof Error ? error.message : 'Microphone access failed'
      throw new Error(
        message.includes('Permission')
          ? 'Microphone permission denied. Please allow microphone access and try again.'
          : `Microphone setup failed: ${message}`
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

    this.workletNode.port.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
      if (this.isMuted || !this.ws || this.ws.readyState !== WebSocket.OPEN) return
      this.ws.send(JSON.stringify({ type: 'audio', data: pcmToBase64(event.data) }))
    })
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

  /** Handle incoming WebSocket messages. */
  private handleMessage(event: MessageEvent): void {
    if (this.helpers.isDisposed()) return
    try {
      const msg: VoiceServerMessage = JSON.parse(event.data as string)
      switch (msg.type) {
        case 'audio':
          if (this.playbackQueue) this.playbackQueue.enqueue(base64ToPcm(msg.data))
          break
        case 'transcript':
          this.helpers.emitTranscript({ role: msg.entry.role, text: msg.entry.text, isFinal: msg.entry.isFinal })
          break
        case 'state':
          if (msg.speaking === 'user') this.helpers.emitMode('listening')
          else if (msg.speaking === 'assistant') this.helpers.emitMode('speaking')
          break
        case 'error':
          this.helpers.end('error', new Error(msg.message))
          this.cleanup()
          break
        case 'session_ended':
          this.helpers.end(msg.reason === 'finished' ? 'finished' : 'cancelled')
          this.cleanup()
          break
      }
    } catch { /* Ignore malformed messages */ }
  }

  /** Handle WebSocket close during active session (potential reconnect). */
  private handleClose(event: CloseEvent): void {
    if (this.helpers.isDisposed()) return

    if (event.code === 4001 || event.code === 4003) {
      this.helpers.end('error', new Error(event.reason || 'Access denied'))
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
    this.wakeLock?.release().catch(() => undefined)
    this.wakeLock = null
    this.helpers.end('finished')
    this.cleanup()
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
