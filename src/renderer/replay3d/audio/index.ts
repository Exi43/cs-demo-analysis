// Ton des 3D-Replays: EIN AudioContext (Critic P1-7). Voice-Clips → bus.voice, Spiel-Sounds → bus.sfx → bus.master →
// Kompressor → destination; beide über dieselbe Uhr (clock.ts) mit Ausgleich der Gerätelatenz geplant.
// Auch vom 2D-Replay nutzbar: createAudio({ d }) ohne Sound-Assets = nur Voice (update ohne Listener).
// Gemessen (user-demo, Electron 44, Gerätelatenz 78 ms): Voice-Versatz −0.06 … +0.10 ms, Schüsse +0.7 ms nach dem Bild,
// dichtestes Feuergefecht (151 Schüsse/15 s, max. 38 Stimmen) +5.8 % eines Kerns, update() p99 0.2 ms.
import { parseFloorGrid, type Assets3D } from '../../../shared/assets3d'
import { voicePackets, type CS3D } from '../../../shared/cs3d'
import type { MatchData, Side } from '../../../shared/model'
import type { AudioEngine, CreateAudio, Listener, PlayState } from '../contracts'
import { Clock } from './clock'
import { buildCues, Sfx } from './sfx'
import { layoutVoice, VoiceBank, VoiceScheduler, type RateMode } from './voice'

export type { RateMode }

export interface AudioStats {
  latencyMs: number
  clock: { resyncs: number; reanchors: number }
  voice: { clips: number; decoded: number; pcmMB: number; decodeMs: number; errors: number; live: number; started: number; late: number }
  sfx?: Sfx['stats'] & { cues: number; live: number }
}

/** Erweiterung des Vertrags (contracts.ts AudioEngine) für die Steuerung im View */
export interface AudioEngineX extends AudioEngine {
  /** Kompressor = letzter Knoten vor destination (Messen/Umleiten) */
  readonly out: DynamicsCompressorNode
  /** Voice bei Tempo ≠ 1: 'stretch' (Default, 0.5x … 2x, Tonhöhe bleibt), 'pitch', 'mute' */
  setVoiceRate(mode: RateMode): void
  /** zusätzlich zu Mute/Solo, z. B. Team-Voice: sid => teamOf(sid) === team; null = alle */
  setVoiceFilter(f: ((steamid: string) => boolean) | null): void
  stats(): AudioStats
}

/**
 * setVolume('voice', 0) schaltet Voice aus (kein Dekodieren, PCM frei); Dekodiert wird erst beim Abspielen, im Fenster t−1 … t+30 s.
 * Sound-Dateien lädt die Engine selbst nach (20 s voraus); assets.map.floor (URL) liefert den Untergrund für Schritte.
 */
export async function createAudio(
  data: { d: CS3D; match?: MatchData },
  assets?: Partial<Pick<Assets3D, 'map' | 'sounds' | 'weapons'>>,
): Promise<AudioEngineX> {
  const { d, match } = data, rate = d.header.tickrate
  const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })
  const bus = { master: ctx.createGain(), voice: ctx.createGain(), sfx: ctx.createGain() }
  const out = ctx.createDynamicsCompressor() // Limiter (sounds-Spike R14: Peak −0.6 dBFS, 0 Clipping)
  out.threshold.value = -6; out.knee.value = 0; out.ratio.value = 20; out.attack.value = 0.002; out.release.value = 0.2
  bus.voice.connect(bus.master); bus.sfx.connect(bus.master); bus.master.connect(out).connect(ctx.destination)
  const clock = new Clock(ctx, rate)
  const bank = new VoiceBank(layoutVoice(voicePackets(d), rate))
  const voice = new VoiceScheduler(ctx, bank, bus.voice, clock)

  let sfx: Sfx | undefined
  if (assets?.sounds) {
    const floorUrl = assets.map?.floor
    const floor = floorUrl
      ? await fetch(floorUrl).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`)))).then(b => parseFloorGrid(b))
        .catch(e => { console.warn('floor.bin fehlt, Schritte auf Beton:', e); return undefined })
      : undefined
    // Seite je Runde aus v1 (CS3D kennt nur Teamnamen); ohne v1 klingen alle Schritte wie CT
    const sides = d.header.rounds.map(R => new Map(match?.rounds.find(m => m.num === R.num)?.tracks.map(t => [t.steamid, t.side])))
    const sideOf = (r: number, p: number): Side => sides[r].get(d.header.players[p].steamid) ?? 'CT'
    sfx = new Sfx(ctx, bus.sfx, clock, buildCues(d, assets.sounds.map, sideOf, floor, assets.weapons), assets.sounds.base, assets.sounds.map.mixgroupVol)
  }

  const stopAll = () => { voice.stopAll(); sfx?.stopAll() }
  // kein update() seit 300 ms (Pause, Fenster versteckt, Replay hängt) bzw. Fenster minimiert/verdeckt → stumm und Audio-Thread anhalten
  // (spart CPU); das nächste update() beim Abspielen weckt ihn wieder
  let last = 0
  const idle = () => {
    if (clock.anchor) { clock.anchor = null; stopAll() }
    if (ctx.state === 'running') void ctx.suspend().catch(() => {})
  }
  const watchdog = setInterval(() => { if (document.hidden || performance.now() - last > 300) idle() }, 100)
  const onVis = () => { if (document.hidden) idle() }
  document.addEventListener('visibilitychange', onVis)

  return {
    ctx, bus, out,
    update(s: PlayState, l?: Listener) {
      last = performance.now()
      if (document.hidden) return idle()
      if (s.playing && ctx.state === 'suspended') void ctx.resume()
      const fresh = clock.sync(s), demo = s.tick / rate
      if (fresh || !clock.anchor) stopAll()
      voice.update(demo, s.speed)
      sfx?.warm(demo, s.speed)
      if (sfx && clock.anchor) { if (fresh) sfx.seek(demo, s.speed); if (l) sfx.update(demo, s.speed, l) }
    },
    setMuted: (sid, m) => voice.setMuted(sid, m),
    setSolo: (sid, s) => voice.setSolo(sid, s),
    setVoiceFilter: f => voice.setFilter(f),
    setVoiceRate: mode => { voice.rateMode = mode; voice.stopAll() },
    setVolume(b, v) {
      bus[b].gain.setTargetAtTime(v, ctx.currentTime, 0.01)
      if (b === 'voice') voice.setEnabled(v > 0)
    },
    speaking: tick => voice.speakingAt(tick / rate),
    stats: () => ({
      latencyMs: (ctx.baseLatency + ctx.outputLatency) * 1000,
      clock: { resyncs: clock.resyncs, reanchors: clock.reanchors },
      voice: { clips: bank.clips.length, decoded: bank.stats.decoded, pcmMB: bank.bytes / 2 ** 20, decodeMs: bank.stats.ms, errors: bank.stats.errors, live: voice.liveCount, started: voice.started, late: voice.late },
      sfx: sfx && { ...sfx.stats, cues: sfx.cues.length, live: sfx.liveCount },
    }),
    dispose() { clearInterval(watchdog); document.removeEventListener('visibilitychange', onVis); stopAll(); bank.dispose(); sfx?.dispose(); void ctx.close() },
  }
}
createAudio satisfies CreateAudio
