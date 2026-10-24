// Demo-Leiste ganz unten (Bild 8, Entwurf v2 #demo; 96 px = 50 Zeitleiste + 41 Steuerzeile + 5): Zeitleiste über das ganze Match mit
// Runden-Abschnitten, Ereignis-Icons (22 px) und Abspielkopf; darunter Play/Pause, Tempo, Zeit + Tick, ±15 s, Runde (+ Liste), Spieler
// (+ Liste), nächstes Ereignis, Kamera FirstPerson/Free, X-Ray, Zahnrad. Nur Darstellung: Uhr, Runde, Spieler, Kamera und Zahnrad-Zustand
// besitzt der Aufrufer (Callbacks), X-Ray schreibt options.ts. Auto-Hide (ui.demobarAutoHide oder hideAll): 2 s ohne Maus unten →
// ausblenden, Mausbewegung unten → zeigen; der mousemove-Listener läuft nur, solange Auto-Hide an ist.
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from 'react'
import type { Side } from '../../../shared/model'
import type { CameraMode } from '../contracts'
import { getOptions, onOptions, setOptions } from '../options'
import { Avatar, HudIcon } from './assets'
import { log, type HudFixture } from './fixtures'
import type { HudPlayerView, TimelineEvent } from './types'
import './bottom.css'

/** Tempo-Stufen wie CS2 (huddemocontroller speedStops); 0 = Pause */
export const SPEEDS = [0, 0.1, 0.25, 0.5, 1, 2, 4]

export interface DemoBarProps {
  tick: number
  /** letzter Tick der Demo: Zeitleiste = 0 … total */
  total: number
  tickrate: number
  /** alle Runden des Matches = Abschnitte der Zeitleiste */
  rounds: readonly { num: number; startTick: number; endTick: number; winner: Side }[]
  /** aktuelle Runde (v1 Round.num) */
  round: number
  /** timeline(match, d, focus) aus hud/state.ts */
  events: readonly TimelineEvent[]
  playing: boolean
  /** Stufe aus SPEEDS (> 0); angezeigt wird 0x, solange pausiert */
  speed: number
  /** HudView.players (CT zuerst, je Seite nach slot): Reihenfolge für Spieler zurück/vor */
  players: readonly HudPlayerView[]
  focus: string | null
  camera: CameraMode
  settingsOpen: boolean
  onPlay(playing: boolean): void
  /** neue Stufe > 0 (Stufe 0 auf dem Regler ruft onPlay(false)) */
  onSpeed(speed: number): void
  onSeek(tick: number): void
  onRound(num: number): void
  onPlayer(steamid: string): void
  onCamera(mode: CameraMode): void
  onSettings(open: boolean): void
  /** zurück zur 2D-Ansicht (Entwurf v2 'Exit 3D'); ohne = kein Knopf */
  onExit?(): void
}

const EV: Record<TimelineEvent['kind'], string> = { kill: 'ui/crosshair_circle', death: 'ui/kill', plant: 'ui/bomb_c4', defuse: 'ui/defuser_white', explode: 'eq/planted_c4' }
/** Ereignis-Sprünge landen so weit davor, dass man es kommen sieht */
const LEAD_S = 2
const mmss = (s: number) => { s = Math.max(0, Math.floor(s)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
const KNOB = (i: number) => 6 + (i / (SPEEDS.length - 1)) * 128 // px im 140-px-Regler
const SPEED_TICKS = SPEEDS.map((v, i) => (
  <span key={i} style={{ left: KNOB(i) }}>
    {v === 0 ? <HudIcon name="ui/pause" className="pz" /> : v < 1 ? <i /> : Array.from({ length: v }, (_, k) => <HudIcon key={k} name="ui/message_arrow" />)}
  </span>
))

/** Auto-Hide: true = ausgeblendet. keep (Menü offen) oder Maus über der Leiste hält sie sichtbar. */
function useAutoHide(el: RefObject<HTMLElement | null>, on: boolean, keep: boolean): boolean {
  const [hidden, setHidden] = useState(false)
  const keepRef = useRef(keep)
  keepRef.current = keep
  useEffect(() => {
    setHidden(false)
    if (!on) return
    let t = 0
    const arm = () => {
      clearTimeout(t)
      t = window.setTimeout(() => (keepRef.current || el.current?.matches(':hover') ? arm() : setHidden(true)), 2000)
    }
    const move = (e: MouseEvent) => {
      const r = el.current?.getBoundingClientRect() // ausgeblendet: unter dem Rand → Zone = Leistenhöhe über dem unteren Rand
      if (r && e.clientY >= r.top - r.height) { setHidden(false); arm() }
    }
    arm()
    addEventListener('mousemove', move, { passive: true })
    return () => { clearTimeout(t); removeEventListener('mousemove', move) }
  }, [on, el])
  return hidden
}

export function DemoBar(p: DemoBarProps) {
  const o = useSyncExternalStore(onOptions, getOptions)
  const [menu, setMenu] = useState<'players' | 'rounds' | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const cb = useRef(p)
  cb.current = p
  const hidden = useAutoHide(root, o.ui.demobarAutoHide || o.hideAll, p.settingsOpen || !!menu)
  useEffect(() => {
    if (!menu) return
    const close = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setMenu(null) }
    addEventListener('pointerdown', close, true)
    return () => removeEventListener('pointerdown', close, true)
  }, [menu])

  const { tick, tickrate: tr, players, rounds, events } = p, total = p.total || 1, lead = LEAD_S * tr
  const pct = (t: number) => `${(Math.max(0, Math.min(total, t)) / total) * 100}%`
  const seekEvent = (e: TimelineEvent) => cb.current.onSeek(Math.max(0, e.tick - lead))
  // Abschnitte + Icons ändern sich nur mit Runde/Fokus, nicht mit jedem Tick
  const marks = useMemo(() => (
    <>
      {rounds.map((r, i) => (
        <div key={r.num} data-hud="timeline-round" className={`hu-rm ${i % 2 ? 'odd' : 'even'} ${r.num === p.round ? 'cur' : ''}`}
          style={{ left: pct(r.startTick), width: pct(r.endTick - r.startTick) }} title={`Round ${r.num} · ${r.winner} win`} />
      ))}
      {events.map((e, i) => (
        // clamp: Icons am Match-Ende/-Anfang ragten 1 px über den Rand
        <button key={i} data-hud="timeline-event" className={`hu-ev ${e.kind}`} style={{ left: `clamp(1px, ${pct(e.tick)}, calc(100% - 1px))` }} title={`${e.text} · ${mmss(e.tick / tr)}`}
          aria-label={e.text} onClick={ev => { ev.stopPropagation(); seekEvent(e) }}>
          <HudIcon name={EV[e.kind]} />
        </button>
      ))}
    </>
  ), [rounds, events, p.round, total, tr])

  const seekAt = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    p.onSeek(Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total))
  }
  const si = p.playing ? SPEEDS.reduce((b, s, i) => (Math.abs(s - p.speed) < Math.abs(SPEEDS[b] - p.speed) ? i : b), 1) : 0
  const pickSpeed = (e: ReactMouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * 140
    const i = Math.max(0, Math.min(SPEEDS.length - 1, Math.round(((x - 6) / 128) * (SPEEDS.length - 1))))
    if (!i) return p.onPlay(false)
    p.onSpeed(SPEEDS[i])
    if (!p.playing) p.onPlay(true)
  }
  const ri = rounds.findIndex(r => r.num === p.round)
  const goRound = (d: number) => { const r = rounds[Math.min(rounds.length - 1, Math.max(0, ri + d))]; if (r) p.onRound(r.num) }
  const fi = players.findIndex(x => x.steamid === p.focus), cur = players[fi]
  const step = (d: number) => { const n = players.length; if (n) p.onPlayer(players[fi < 0 ? 0 : (((fi + d) % n) + n) % n].steamid) }
  const next = events.find(e => e.tick - lead > tick + tr / 4)
  const toggle = (m: 'players' | 'rounds') => setMenu(v => (v === m ? null : m))

  return (
    // mousedown ohne Fokus: sonst löst Leertaste danach den zuletzt geklickten Knopf erneut aus (statt nur Play/Pause)
    <div ref={root} className={`hu-demo ${hidden ? 'hide' : ''}`} data-hud="demobar" onMouseDown={e => e.preventDefault()}>
      <div className="hu-tl" data-hud="timeline" onClick={seekAt}>
        {marks}
        <div className="hu-thumb" style={{ left: pct(tick) }} />
      </div>
      <div className="hu-ctrl" data-hud="controls">
        <button className="hu-btn hu-play" title={p.playing ? 'Pause' : 'Play'} onClick={() => p.onPlay(!p.playing)}>
          <HudIcon name={p.playing ? 'ui/pause' : 'ui/play'} />
        </button>
        <div className="hu-grp speed">
          <div className="hu-spd" title="Speed" onClick={pickSpeed}>
            <div className="track" /><div className="ticks">{SPEED_TICKS}</div><div className="knob" style={{ left: KNOB(si) }} />
          </div>
          <span className="hu-scale">{SPEEDS[si]}x</span>
        </div>
        <div className="hu-time">
          Time:&nbsp;{mmss(tick / tr)} / {mmss(total / tr)}<span className="k">Tick:&nbsp;{String(Math.round(tick)).padStart(6, '0')}</span>
        </div>
        <div className="hu-grp tctl">
          <button className="hu-btn" title="Back 15 s" onClick={() => p.onSeek(Math.max(0, tick - 15 * tr))}>-15s</button>
          <HudIcon name="ui/clock" />
          <button className="hu-btn" title="Forward 15 s" onClick={() => p.onSeek(Math.min(total, tick + 15 * tr))}>+15s</button>
        </div>
        <div className="hu-grp">
          <button className="hu-btn prev" title="Previous round" onClick={() => goRound(-1)}><HudIcon name="ui/skip" /></button>
          <button className="hu-btn hu-rnum" title="Round list" onClick={() => toggle('rounds')}>Round:&nbsp;{p.round}</button>
          <button className="hu-btn next" title="Next round" onClick={() => goRound(1)}><HudIcon name="ui/skip" /></button>
          {menu === 'rounds' && (
            <div className="hu-menu hu-list hu-rlist" data-hud="rounds">
              <h4>Rounds</h4>
              {rounds.map(r => (
                <button key={r.num} className={`it ${r.num === p.round ? 'sel' : ''}`} onClick={() => { setMenu(null); p.onRound(r.num) }}>
                  Round {r.num}<span className={`w ${r.winner}`}>{r.winner}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="hu-grp">
          <button className="hu-btn hu-arrow prev" title="Previous player" onClick={() => step(-1)}><HudIcon name="ui/message_arrow" /></button>
          <button className={`hu-btn hu-pname ${cur?.side ?? ''}`} title="Player list" onClick={() => toggle('players')}>{cur?.name ?? '–'}</button>
          <button className="hu-btn hu-arrow next" title="Next player" onClick={() => step(1)}><HudIcon name="ui/message_arrow" /></button>
          <button className="hu-btn hu-next" title={next ? `Next event: ${next.text}` : 'No more events'} disabled={!next} onClick={() => next && seekEvent(next)}>
            <HudIcon name="hud/double_arrows" className="da" /><HudIcon name="hud/deathnotice/domination" />
          </button>
          {menu === 'players' && (
            <div className="hu-menu hu-list hu-plist" data-hud="players">
              <h4>Players</h4>
              {players.map(x => (
                <button key={x.steamid} className={`it ${x.side} ${x.alive ? '' : 'dead'} ${x.steamid === p.focus ? 'sel' : ''}`}
                  onClick={() => { setMenu(null); p.onPlayer(x.steamid) }}>
                  <Avatar steamid={x.steamid} url={x.avatar} name={x.name} side={x.side} />{x.name}{!x.alive && <HudIcon name="ui/kill" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="hu-spacer" />
        <div className="hu-btn hu-cam" title="Camera">
          <HudIcon name="ui/camera" />
          <div className="seg">
            <button className={p.camera === 'ego' ? 'on' : ''} onClick={() => p.onCamera('ego')}>FirstPerson</button>
            <button className={p.camera === 'free' ? 'on' : ''} onClick={() => p.onCamera('free')}>Free</button>
          </div>
        </div>
        <button className={`hu-btn hu-xray ${o.xray ? 'on' : ''}`} title={`X-Ray: outlines through walls (${o.xray ? 'on' : 'off'})`} aria-pressed={o.xray}
          onClick={() => setOptions({ xray: !o.xray })}>
          <HudIcon name="ui/ct_silhouette" />
        </button>
        <button className={`hu-btn hu-gear ${p.settingsOpen ? 'open' : ''}`} title="Settings" aria-expanded={p.settingsOpen} onClick={() => p.onSettings(!p.settingsOpen)}>
          <HudIcon name="ui/settings" />
        </button>
        {p.onExit && <button className="hu-btn hu-back" title="Back to 2D" onClick={p.onExit}>Exit 3D</button>}
      </div>
    </div>
  )
}

export function preview(fx: HudFixture): ReactNode {
  const { rounds, timeline, view } = fx
  return (
    <DemoBar tick={view.tick} total={rounds[rounds.length - 1].endTick} tickrate={fx.tickrate} rounds={rounds} round={view.round} events={timeline}
      playing speed={1} players={view.players} focus={fx.focus} camera="ego" settingsOpen={fx.menu}
      onPlay={log('onPlay')} onSpeed={log('onSpeed')} onSeek={log('onSeek')} onRound={log('onRound')} onPlayer={log('onPlayer')}
      onCamera={log('onCamera')} onSettings={log('onSettings')} onExit={log('onExit')} />
  )
}
