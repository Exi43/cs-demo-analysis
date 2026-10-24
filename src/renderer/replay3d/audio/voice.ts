// Voice-Chat einer Demo (aus dem voice-Spike übernommen): Opus-Pakete → Sprech-Abschnitte (Clips) → WebCodecs-Dekodierung
// erst beim Abspielen (Fenster t−1 … t+30 s, Budget 96 MB LRU) → Clips gegen die gemeinsame Uhr einplanen.
// Gemessen (user-demo, 4515 Pakete, 17 Clips): Dekodieren 135–439 ms, Versatz Bild ↔ Ton −0.27 … +0.04 ms.
import type { VoicePacket3D } from '../../../shared/cs3d'
import type { Clock } from './clock'

export const SAMPLE_RATE = 48000

export interface VoiceClip {
  id: number
  steamid: string
  /** Demo-Sekunde (tick / tickrate) des ersten Samples; end = start + samples / 48000 */
  start: number; end: number
  startTick: number; endTick: number
  packets: VoicePacket3D[]
  /** Sample-Offset jedes Pakets im Clip */
  slots: Int32Array
  samples: number
  /** Index des Clips in der Clip-Liste seines Spielers (Decoder-Vorlauf) */
  nth: number
}

/** Samples (48 kHz) eines Opus-Pakets aus dem TOC-Byte (RFC 6716, 3.1) */
export function opusSamples(p: Uint8Array): number {
  const cfg = p[0] >> 3, c = p[0] & 3
  const ms = cfg < 12 ? [10, 20, 40, 60][cfg & 3] : cfg < 16 ? [10, 20][cfg & 1] : [2.5, 5, 10, 20][cfg & 3]
  const frames = c === 0 ? 1 : c === 3 ? (p[1] & 63) : 2
  return Math.round(ms * 48 * frames)
}

/**
 * Pakete eines Spielers liegen lückenlos hintereinander (seq +1 pro Paket, verlorene seq = Stille), ab dem Tick des
 * ersten Pakets. Kommt ein Paket > breakSec nach seinem Platz an, war das eine Sprechpause → neuer Clip ab dessen Tick.
 * Strikt auf tick/64 gelegt überlappen sich 218–543 Pakete je Spieler (Pakete kommen gebündelt).
 */
export function layoutVoice(packets: VoicePacket3D[], tickrate = 64, breakSec = 0.1): VoiceClip[] {
  const by = new Map<string, VoicePacket3D[]>()
  for (const p of packets) { let a = by.get(p.steamid); if (!a) by.set(p.steamid, a = []); a.push(p) }
  const clips: VoiceClip[] = []
  for (const [steamid, list] of by) {
    list.sort((a, b) => a.tick - b.tick || (a.seq ?? 0) - (b.seq ?? 0))
    let nth = 0, i = 0
    while (i < list.length) {
      const start = list[i].tick / tickrate
      const slots: number[] = [0]
      let slot = 0, len = opusSamples(list[i].opus), j = i + 1
      for (; j < list.length; j++) {
        const p = list[j], q = list[j - 1]
        const lost = p.seq !== undefined && q.seq !== undefined ? Math.max(0, p.seq - q.seq - 1) : 0
        const next = slot + len * (1 + lost)
        if (p.tick / tickrate - (start + next / SAMPLE_RATE) > breakSec) break
        slot = next; len = opusSamples(p.opus); slots.push(slot)
      }
      const samples = slot + len
      clips.push({
        id: 0, steamid, start, end: start + samples / SAMPLE_RATE, startTick: list[i].tick,
        endTick: list[i].tick + (samples / SAMPLE_RATE) * tickrate,
        packets: list.slice(i, j), slots: Int32Array.from(slots), samples, nth: nth++,
      })
      i = j
    }
  }
  clips.sort((a, b) => a.start - b.start)
  clips.forEach((c, k) => (c.id = k))
  return clips
}

/** Clips, die [from, to) überlappen (clips nach start sortiert, maxLen = längster Clip in s) */
export function clipsIn(clips: VoiceClip[], maxLen: number, from: number, to: number): VoiceClip[] {
  let lo = 0, hi = clips.length
  const a = from - maxLen
  while (lo < hi) { const m = (lo + hi) >> 1; if (clips[m].start < a) lo = m + 1; else hi = m }
  const out: VoiceClip[] = []
  for (let k = lo; k < clips.length && clips[k].start < to; k++) if (clips[k].end > from) out.push(clips[k])
  return out
}

interface Item { opus: Uint8Array; slot: number; out?: Float32Array }

/** Ein Decoder-Lauf: Pakete in Reihenfolge, Ausgaben an ihre Slots. Fehler → Rest bleibt Stille. */
async function decodeRun(items: Item[], st: { errors: number }): Promise<void> {
  let fifo = 0
  const tmp = new Float32Array(5760)
  const dec = new AudioDecoder({
    output: ad => {
      const it = items[fifo++] // Ausgaben kommen in Eingabe-Reihenfolge (gemessen: 0 Zeitstempel-Abweichungen)
      if (it?.out) {
        const m = Math.min(ad.numberOfFrames, tmp.length, it.out.length - it.slot)
        if (m > 0) { ad.copyTo(tmp, { planeIndex: 0, format: 'f32-planar', frameCount: m }); it.out.set(tmp.subarray(0, m), it.slot) }
      }
      ad.close()
    },
    error: () => { st.errors++ },
  })
  dec.configure({ codec: 'opus', sampleRate: SAMPLE_RATE, numberOfChannels: 1 })
  for (let k = 0; k < items.length; k++) dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: k * 10000, duration: 10000, data: items[k].opus }))
  try { await dec.flush() } catch { st.errors++ }
  if (dec.state !== 'closed') dec.close()
}

const FADE = 120 // 2.5 ms Ein-/Ausblenden an Clip-Grenzen
const WARMUP = 5 // Pakete des vorigen Clips vorweg dekodieren und verwerfen (Opus-Zustand wie beim Sender)
const PARALLEL = 4

export class VoiceBank {
  readonly maxLen: number
  readonly stats = { errors: 0, ms: 0, decoded: 0 }
  /** Bytes PCM im Speicher */
  bytes = 0
  private base = new Map<number, AudioBuffer>()
  private stretched = new Map<string, AudioBuffer>()
  private used = new Map<number, number>()
  private pending = new Map<number, Promise<void>>()
  private byPlayer = new Map<string, VoiceClip[]>()
  private pinned = new Set<number>()
  private worker?: Worker
  private stretching = new Set<string>()

  constructor(readonly clips: VoiceClip[], private budget = 96 << 20) {
    this.maxLen = clips.reduce((m, c) => Math.max(m, c.end - c.start), 0)
    for (const c of clips) { let a = this.byPlayer.get(c.steamid); if (!a) this.byPlayer.set(c.steamid, a = []); a.push(c) }
  }

  has(c: VoiceClip) { return this.base.has(c.id) }

  /** AudioBuffer (rate ≠ 1: WSOLA-gestreckt im Worker, gecacht); undefined = noch nicht fertig */
  buffer(c: VoiceClip, rate = 1): AudioBuffer | undefined {
    const b = this.base.get(c.id)
    if (!b) return
    this.used.set(c.id, performance.now())
    if (rate === 1) return b
    const key = `${c.id}@${rate}`
    const s = this.stretched.get(key)
    if (!s) this.requestStretch(key, b, rate)
    return s
  }

  private requestStretch(key: string, b: AudioBuffer, rate: number) {
    if (this.stretching.has(key)) return
    this.stretching.add(key)
    if (!this.worker) {
      this.worker = new Worker(new URL('./stretch.worker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (e: MessageEvent<{ key: string; buf: ArrayBuffer; len: number }>) => {
        const { key, buf, len } = e.data
        this.stretching.delete(key)
        if (!this.base.has(Number(key.split('@')[0]))) return
        const s = new AudioBuffer({ length: Math.max(1, len), sampleRate: SAMPLE_RATE, numberOfChannels: 1 })
        s.copyToChannel(new Float32Array(buf, 0, len), 0)
        this.stretched.set(key, s); this.bytes += s.length * 4
      }
    }
    const x = b.getChannelData(0).slice()
    this.worker.postMessage({ key, x, rate }, [x.buffer])
  }

  /** Clips im Zeitfenster dekodieren (Promise darf ignoriert werden) */
  ensureRange(from: number, to: number): Promise<void> {
    const list = clipsIn(this.clips, this.maxLen, from, to)
    const todo = list.filter(c => !this.base.has(c.id) && !this.pending.has(c.id))
    if (!todo.length) return Promise.resolve()
    const t0 = performance.now()
    // pro Spieler ein Lauf; aufeinanderfolgende Clips teilen den Decoder-Zustand
    const runs = new Map<string, VoiceClip[]>()
    for (const c of todo) { let a = runs.get(c.steamid); if (!a) runs.set(c.steamid, a = []); a.push(c) }
    const jobs = [...runs.entries()].map(([sid, cs]) => () => this.decodePlayer(sid, cs.sort((a, b) => a.nth - b.nth)))
    let next = 0
    const worker = async () => { while (next < jobs.length) await jobs[next++]() }
    const p = Promise.all(Array.from({ length: Math.min(PARALLEL, jobs.length) }, worker)).then(() => {}).finally(() => {
      this.stats.ms += performance.now() - t0
      for (const c of todo) this.pending.delete(c.id)
      this.evict()
    })
    for (const c of todo) this.pending.set(c.id, p)
    return p
  }

  private async decodePlayer(sid: string, cs: VoiceClip[]) {
    const all = this.byPlayer.get(sid)!
    const items: Item[] = [], outs: Float32Array<ArrayBuffer>[] = []
    let prevNth = -2
    for (const c of cs) {
      if (c.nth !== prevNth + 1 && c.nth > 0) for (const p of all[c.nth - 1].packets.slice(-WARMUP)) items.push({ opus: p.opus, slot: 0 })
      const out = new Float32Array(c.samples); outs.push(out)
      c.packets.forEach((p, k) => items.push({ opus: p.opus, slot: c.slots[k], out }))
      prevNth = c.nth
    }
    await decodeRun(items, this.stats)
    if (this.disposed) return
    const now = performance.now()
    cs.forEach((c, k) => {
      const out = outs[k], m = Math.min(FADE, out.length >> 1)
      for (let i = 0; i < m; i++) { const g = i / m; out[i] *= g; out[out.length - 1 - i] *= g }
      const b = new AudioBuffer({ length: out.length, sampleRate: SAMPLE_RATE, numberOfChannels: 1 })
      b.copyToChannel(out, 0)
      this.base.set(c.id, b); this.used.set(c.id, now); this.bytes += out.length * 4; this.stats.decoded++
    })
  }

  /** Clips, die gerade spielen, nicht verdrängen */
  pin(ids: Iterable<number>) { this.pinned = new Set(ids) }

  /** am längsten unbenutzte Clips verwerfen, bis 80 % des Budgets erreicht sind */
  private evict() {
    if (this.bytes <= this.budget) return
    for (const [id] of [...this.used.entries()].sort((a, b) => a[1] - b[1])) {
      if (this.bytes <= this.budget * 0.8) break
      if (!this.pinned.has(id)) this.drop(id)
    }
  }

  private drop(id: number) {
    const b = this.base.get(id)
    if (b) this.bytes -= b.length * 4
    this.base.delete(id); this.used.delete(id)
    for (const [k, s] of this.stretched) if (k.startsWith(`${id}@`)) { this.bytes -= s.length * 4; this.stretched.delete(k) }
  }

  clear() { for (const id of [...this.base.keys()]) this.drop(id) }
  private disposed = false
  dispose() { this.disposed = true; this.clear(); this.worker?.terminate(); this.worker = undefined }
}

/** Lautheit angleichen: Faktor, der den Sprach-RMS eines Spielers auf targetDb (dBFS) bringt, 0.25 … 4 */
export function loudnessGain(rms: number, targetDb = -20, maxGain = 4): number {
  if (!(rms > 0)) return 1
  return Math.min(maxGain, Math.max(0.25, 10 ** (targetDb / 20) / rms))
}

/** Tempo ≠ 1: 'stretch' (Default; WSOLA, Tonhöhe bleibt; nur 0.5x … 2x, sonst stumm), 'pitch' (playbackRate, Mickymaus), 'mute' */
export type RateMode = 'mute' | 'pitch' | 'stretch'

const LOOKAHEAD = 0.5 // Wandzeit-s im Voraus einplanen
const PREFETCH = 30 // Demo-s im Voraus dekodieren

interface Live { src: AudioBufferSourceNode; g: GainNode }

export class VoiceScheduler {
  rateMode: RateMode = 'stretch'
  /** false = aus (Lautstärke 0): nichts dekodieren, PCM frei */
  enabled = true
  started = 0
  /** Clips, die erst nach ihrem Beginn starten konnten (> 20 ms) */
  late = 0
  private players = new Map<string, { gain: GainNode; norm: number }>()
  private live = new Map<number, Live>()
  private played = new Set<number>()
  private mute = new Set<string>()
  private solo = new Set<string>()
  private filter: ((steamid: string) => boolean) | null = null
  private loud = new Map<string, { ss: number; n: number }>()
  private measured = new Set<number>()
  private lastMeasure = 0

  constructor(private ctx: AudioContext, readonly bank: VoiceBank, private out: AudioNode, private clock: Clock) {}

  setMuted(sid: string, m: boolean) { m ? this.mute.add(sid) : this.mute.delete(sid); this.applyGains() }
  setSolo(sid: string, s: boolean) { s ? this.solo.add(sid) : this.solo.delete(sid); this.applyGains() }
  setFilter(f: ((steamid: string) => boolean) | null) { this.filter = f; this.applyGains() }
  setEnabled(on: boolean) { if (on === this.enabled) return; this.enabled = on; if (!on) { this.stopAll(); this.bank.clear(); this.measured.clear() } }

  private gainOf(sid: string, norm: number) {
    const on = (this.solo.size ? this.solo.has(sid) : !this.mute.has(sid)) && (!this.filter || this.filter(sid))
    return on ? norm : 0
  }
  private applyGains() {
    const t = this.ctx.currentTime
    for (const [sid, p] of this.players) p.gain.gain.setTargetAtTime(this.gainOf(sid, p.norm), t, 0.01)
  }
  private player(sid: string) {
    let p = this.players.get(sid)
    if (!p) {
      const gain = this.ctx.createGain()
      p = { gain, norm: 1 }
      gain.gain.value = this.gainOf(sid, 1)
      gain.connect(this.out)
      this.players.set(sid, p)
    }
    return p
  }

  /** Wer spricht zur Demo-Zeit (Sprech-Symbol), unabhängig vom Dekodieren */
  speakingAt(demo: number): string[] {
    return [...new Set(clipsIn(this.bank.clips, this.bank.maxLen, demo, demo + 1e-6).map(c => c.steamid))]
  }

  private rate(speed: number): number {
    if (speed === 1) return 1
    if (this.rateMode === 'mute' || speed < 0.5 || speed > 2) return 0
    return speed
  }

  /** jedes Bild nach clock.sync(); O(Clips im Fenster) */
  update(demo: number, speed: number) {
    if (!this.enabled) return
    void this.bank.ensureRange(demo - 1, demo + PREFETCH * Math.max(1, speed)).catch(() => {})
    const now = performance.now()
    if (now - this.lastMeasure > 500) { this.lastMeasure = now; this.measure() }
    const r = this.rate(speed)
    if (!r || !this.clock.anchor) { this.stopAll(); return }
    const horizon = demo + LOOKAHEAD * speed, stretch = this.rateMode === 'stretch' && r !== 1
    for (const c of clipsIn(this.bank.clips, this.bank.maxLen, demo, horizon)) {
      if (this.live.has(c.id) || this.played.has(c.id)) continue
      const b = this.bank.buffer(c, stretch ? r : 1)
      if (b) this.start(c, b, r, stretch) // sonst dekodiert/streckt noch → nächstes Bild startet mit Versatz
    }
    if (stretch) for (const c of clipsIn(this.bank.clips, this.bank.maxLen, demo, demo + 10 * speed)) this.bank.buffer(c, r)
    this.bank.pin(this.live.keys())
  }

  private start(c: VoiceClip, b: AudioBuffer, r: number, stretched: boolean) {
    const now = this.ctx.currentTime
    let when = this.clock.when(c.start), off = 0 // off in Demo-s
    if (when < now + 0.005) { off = (now + 0.005 - when) * r; when = now + 0.005; if (off > 0.02) this.late++ }
    if (off >= c.end - c.start) { this.played.add(c.id); return }
    const src = this.ctx.createBufferSource()
    src.buffer = b
    if (!stretched) src.playbackRate.value = r
    const g = this.ctx.createGain()
    src.connect(g).connect(this.player(c.steamid).gain)
    if (off > 0) { g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(1, when + 0.005) }
    src.start(when, stretched ? off / r : off)
    src.onended = () => { if (this.live.get(c.id)?.src === src) { this.live.delete(c.id); g.disconnect() } }
    this.live.set(c.id, { src, g }); this.played.add(c.id); this.started++
  }

  /** Lautheit je Spieler aus den dekodierten Clips nachführen (RMS → −20 dBFS) */
  private measure() {
    const touched = new Set<string>()
    for (const c of this.bank.clips) {
      if (this.measured.has(c.id) || !this.bank.has(c)) continue
      this.measured.add(c.id)
      const x = this.bank.buffer(c)!.getChannelData(0)
      let ss = 0; for (let i = 0; i < x.length; i++) ss += x[i] * x[i]
      const l = this.loud.get(c.steamid) ?? { ss: 0, n: 0 }
      l.ss += ss; l.n += x.length; this.loud.set(c.steamid, l); touched.add(c.steamid)
    }
    for (const sid of touched) { const l = this.loud.get(sid)!, p = this.player(sid); p.norm = loudnessGain(Math.sqrt(l.ss / l.n)) }
    if (touched.size) this.applyGains()
  }

  get liveCount() { return this.live.size }

  stopAll() {
    if (!this.live.size) { this.played.clear(); return }
    const t = this.ctx.currentTime
    for (const l of this.live.values()) {
      l.src.onended = null
      l.g.gain.cancelScheduledValues(t); l.g.gain.setTargetAtTime(0, t, 0.004)
      try { l.src.stop(t + 0.03) } catch { /* schon gestoppt */ }
      const g = l.g; setTimeout(() => g.disconnect(), 100)
    }
    this.live.clear(); this.played.clear()
  }
}
