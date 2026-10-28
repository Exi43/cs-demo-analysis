import { useEffect, useMemo, useRef, useState } from 'react'
import type { MatchData, Round, Side } from '../../shared/model'
import { api, type MapMeta } from '../api'
import { BOMB_TIME, COLORS, ROUND_TIME, TICKRATE, drawScene, frameAt, playerAt } from './scene'
import { RoundStrip } from '../views/RoundStrip'
import { Weapon } from '../weapons'
import type { Jump } from '../App'
import { decode3d, type CS3D } from '../../shared/cs3d'
import { InputsOverlay, keysAt } from '../replay3d/InputsOverlay'
import { createFrameLoop } from '../replay3d/frameloop'
import { Highlights2D, useHighlights } from '../replay3d/hud/Highlights'

const SPEEDS = [0.5, 1, 2, 4, 8]
const NADE_INV: Record<string, RegExp> = { smoke: /smoke/i, flash: /flash/i, he: /high explosive/i, molotov: /molotov|incendiary/i, decoy: /decoy/i }

/** Inventar bei Freezetime-Ende minus bereits geworfene Granaten */
export function invLeft(inv: string[], thrown: string[]) {
  const left = [...inv]
  for (const t of thrown) { const i = left.findIndex(w => NADE_INV[t]?.test(w)); if (i >= 0) left.splice(i, 1) }
  return left
}

export function ReplayView({ match, map, img, lowerImg, jump }: { match: MatchData; map: MapMeta; img?: HTMLImageElement; lowerImg?: HTMLImageElement; jump?: Jump }) {
  const [ri, setRi] = useState(0)
  const [tick, setTick] = useState(match.rounds[0].startTick)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [level, setLevel] = useState<'upper' | 'lower'>('upper')
  const [trail, setTrail] = useState(false)
  const [only, setOnly] = useState<Set<string>>(new Set()) // leer = alle Spieler zeigen
  const togglePlayer = (s: string) => setOnly(o => { const n = new Set(o); n.has(s) ? n.delete(s) : n.add(s); return n })
  // Tasten-Overlay für genau einen gewählten Spieler; CS3D erst dann laden (null = Match ohne 3D-Daten)
  const keysOf = only.size === 1 ? [...only][0] : undefined
  const [d3, setD3] = useState<CS3D | null>()
  useEffect(() => {
    if (!keysOf || d3 !== undefined) return
    setD3(null)
    api.load3d(match.id).then(b => b && setD3(decode3d(b))).catch(e => console.warn('load3d', e))
  }, [keysOf])
  const round = match.rounds[ri]
  const end = round.frameTicks[round.frameTicks.length - 1] ?? round.endTick

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tickRef = useRef(tick)
  tickRef.current = tick

  // Runde wechseln → an Freezetime-Ende springen
  const goRound = (i: number) => { setRi(i); setTick(match.rounds[i].freezeEndTick - TICKRATE * 2) }
  useEffect(() => {
    if (jump) { const i = Math.min(match.rounds.length - 1, jump.round - 1); setRi(i); setTick(Math.max(match.rounds[i].startTick, jump.tick)); return }
    const [, , r, sec] = location.hash.slice(1).split('/')
    const i = r ? Math.min(match.rounds.length - 1, Number(r) - 1) : 0
    goRound(i)
    if (sec) setTick(match.rounds[i].freezeEndTick + Number(sec) * TICKRATE)
  }, [match.id, jump?.n])

  // Highlights wie im 3D-Replay; Sprung auch über Runden, Fokus = Spieler weiß umrandet (2D hat keine Kamera)
  const [hlFocus, setHlFocus] = useState<string>()
  const seekAny = (t: number) => { setRi(Math.max(0, match.rounds.findLastIndex(r => r.startTick <= t))); setTick(t) }
  const hl = useHighlights(match, tick, keysOf ?? null, { seek: seekAny, play: setPlaying, pick: setHlFocus })

  // Abspielen im Bildtakt des 3D-Replays (Bildlimit aus dessen Optionen, minimiert kein Bild): sonst zeichnete es mit Monitor-Hz (240 Hz: 54 % eines Kerns)
  useEffect(() => {
    if (!playing) return
    const loop = createFrameLoop({
      step(_now, dt) {
        const next = tickRef.current + (dt / 1000) * TICKRATE * speed
        if (next >= end) { setTick(end); setPlaying(false) } else setTick(next)
      },
      wantsFrame: () => false, onHud() {}, onStats() {},
    })
    loop.setPlaying(true)
    return () => loop.stop()
  }, [playing, speed, end])

  // Tastatur
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.code === 'Space') { e.preventDefault(); setPlaying(p => !p) }
      if (e.code === 'ArrowRight') setTick(t => Math.min(end, t + TICKRATE * 5))
      if (e.code === 'ArrowLeft') setTick(t => Math.max(round.startTick, t - TICKRATE * 5))
      if (e.code === 'PageDown' || e.code === 'KeyN') goRound(Math.min(match.rounds.length - 1, ri + 1))
      if (e.code === 'PageUp' || e.code === 'KeyP') goRound(Math.max(0, ri - 1))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ri, end, round.startTick])

  // Zeichnen
  useEffect(() => {
    const c = canvasRef.current, w = wrapRef.current
    if (!c || !w) return
    const size = Math.min(w.clientWidth, w.clientHeight)
    const dpr = window.devicePixelRatio || 1
    if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr; c.style.width = c.style.height = `${size}px` }
    const ctx = c.getContext('2d')!
    drawScene(ctx, match, { map, level }, level === 'lower' && lowerImg ? lowerImg : img,
      [{ round, tick, alpha: 1, trail: trail ? 6 : 0, players: only.size ? only : undefined, highlight: hlFocus }], (size * dpr) / 1024)
  })
  useEffect(() => {
    const ro = new ResizeObserver(() => setTick(t => t + 0.0001))
    if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  const f = frameAt(round, tick)
  const states = useMemo(() => round.tracks.map(tr => ({ tr, p: playerAt(round, tr, f) })), [round, Math.round(f * 2)])
  const nameOf = (s?: string) => match.players.find(p => p.steamid === s)?.name ?? '—'

  // Uhr
  const sinceFreeze = (tick - round.freezeEndTick) / TICKRATE
  let clock: string, clockCls = ''
  if (sinceFreeze < 0) { clock = `Freeze ${Math.ceil(-sinceFreeze)}s` }
  else if (round.plant && tick >= round.plant.tick) {
    const left = Math.max(0, BOMB_TIME - (tick - round.plant.tick) / TICKRATE); clock = left.toFixed(1); clockCls = 'bomb'
  } else {
    const left = Math.max(0, ROUND_TIME - sinceFreeze); clock = `${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`
  }

  const feed = round.kills.filter(k => k.tick <= tick).slice(-6)
  const span = end - round.startTick

  const teamPanel = (side: Side) => (
    <div className={`team-panel ${side}`}>
      <div className="team-head">
        <span>{round.teamOnSide[side]}</span>
        <span className="muted">{side} · {round.scoreBefore[side]} · {round.buy[side]} ${round.equipValue[side].toLocaleString('en-US')}</span>
      </div>
      {states.filter(s => s.tr.side === side).sort((a, b) => b.p.hp - a.p.hp).map(({ tr, p }) => (
        <div key={tr.steamid} className={`pl ${p.hp <= 0 ? 'dead' : ''} ${only.has(tr.steamid) ? 'focus' : ''} ${only.size && !only.has(tr.steamid) ? 'off' : ''}`}
          onClick={() => togglePlayer(tr.steamid)} title="Click to show only selected players">
          <div className="hpbar" style={{ width: `${p.hp}%`, background: COLORS[side] }} />
          <span className="pl-name">{nameOf(tr.steamid)}</span>
          <span className="pl-hp">{p.hp > 0 ? p.hp : '✝'}</span>
          <span className="pl-wpn">{p.hp > 0 && <Weapon name={p.weapon} h={15} />}</span>
          <span className="pl-money">${p.money}</span>
          <span className="pl-place muted">{p.hp > 0 ? p.place : ''}</span>
          <span className="pl-inv">
            {invLeft(tr.inventory, round.nades.filter(n => n.thrower === tr.steamid && n.throwTick <= tick).map(n => n.type))
              .filter(w => w !== p.weapon && !/c4/i.test(w)).map((w, i) => <Weapon key={i} name={w} h={11} dim />)}
            {tr.helmet ? <Weapon name="assaultsuit" h={11} dim /> : p.armor > 0 && <Weapon name="kevlar" h={11} dim />}
            {tr.defuser && <Weapon name="defuser" h={11} dim />}
          </span>
        </div>
      ))}
    </div>
  )

  return (
    <div className="replay">
      <RoundStrip match={match} current={ri} onPick={goRound} />
      <div className="replay-body">
        <div className="side-col">{teamPanel('CT')}{teamPanel('T')}</div>
        <div className="canvas-wrap" ref={wrapRef} style={{ position: 'relative' }}>
          <canvas ref={canvasRef} />
          {keysOf && d3 && <InputsOverlay keys={keysAt(d3, keysOf, tick)} label={nameOf(keysOf)} />}
          <Highlights2D hl={hl} match={match} players={round.tracks.map(t => ({ steamid: t.steamid, name: nameOf(t.steamid), side: t.side, avatar: null }))} />
        </div>
        <div className="side-col">
          <div className={`clock ${clockCls}`}>{clockCls === 'bomb' && <Weapon name="c4" h={26} />}{clock}</div>
          <div className="muted small">Round {round.num} · {round.winner} wins ({round.reason.replace(/_/g, ' ')})</div>
          <div className="feed">
            {feed.map((k, i) => (
              <div key={i} className="feed-row" onClick={() => setTick(k.tick - TICKRATE * 3)}>
                <span style={{ color: COLORS[round.tracks.find(t => t.steamid === k.attacker)?.side ?? 'T'] }}>{nameOf(k.attacker)}</span>
                <span className="kf-mid"><Weapon name={k.weapon} h={14} />{k.headshot && <span className="kf-tag">HS</span>}{k.wallbang && <span className="kf-tag">WB</span>}{k.throughSmoke && <span className="kf-tag">SMOKE</span>}</span>
                <span style={{ color: COLORS[round.tracks.find(t => t.steamid === k.victim)?.side ?? 'CT'] }}>{nameOf(k.victim)}</span>
                {k.traded && <span className="tag">traded</span>}
              </div>
            ))}
          </div>
          <div className="opts">
            <label><input type="checkbox" checked={trail} onChange={e => setTrail(e.target.checked)} /> Paths (6 s)</label>
            {map.verticalsections && (
              <label><input type="checkbox" checked={level === 'lower'} onChange={e => setLevel(e.target.checked ? 'lower' : 'upper')} /> Lower level</label>
            )}
          </div>
          <div className="muted small help">Space: play/pause · ←/→: 5 s · N/P: round</div>
        </div>
      </div>
      <div className="controls">
        <button onClick={() => goRound(Math.max(0, ri - 1))}>⏮</button>
        <button className="play" onClick={() => setPlaying(p => !p)}>{playing ? '⏸' : '▶'}</button>
        <button onClick={() => goRound(Math.min(match.rounds.length - 1, ri + 1))}>⏭</button>
        <div className="timeline">
          <input type="range" min={round.startTick} max={end} step={1} value={tick} onChange={e => setTick(Number(e.target.value))} />
          <div className="markers">
            {round.kills.map((k, i) => (
              <span key={i} className="mk" title={`${nameOf(k.attacker)} → ${nameOf(k.victim)}`}
                style={{ left: `${((k.tick - round.startTick) / span) * 100}%`, background: COLORS[round.tracks.find(t => t.steamid === k.victim)?.side ?? 'T'] }} />
            ))}
            {round.plant && <span className="mk bombmk" style={{ left: `${((round.plant.tick - round.startTick) / span) * 100}%` }} />}
            <span className="mk freeze" style={{ left: `${((round.freezeEndTick - round.startTick) / span) * 100}%` }} />
          </div>
        </div>
        {SPEEDS.map(s => <button key={s} className={s === speed ? 'on' : ''} onClick={() => setSpeed(s)}>{s}x</button>)}
        <button className={hl.open || hl.reel ? 'on' : ''} title="Highlights: all kills and deaths" onClick={hl.toggle}>
          Highlights{hl.reel && ` ${hl.reel.i + 1}/${hl.reel.list.length}`}
        </button>
      </div>
    </div>
  )
}

export type { Round }
