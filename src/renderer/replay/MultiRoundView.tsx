// Mehrere Runden synchron ab Freezetime-Ende übereinander abspielen + Heatmaps.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { BuyType, MatchData, Round, Side } from '../../shared/model'
import type { MapMeta } from '../api'
import { TICKRATE, drawHeat, drawScene, frameAt, playerAt, type Layer } from './scene'
import { RoundStrip } from '../views/RoundStrip'
import { BUY_LABEL } from '../format'

const ROUND_COLORS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#22b8cf', '#94d82d', '#f06595', '#845ef7', '#20c997', '#fab005']
type Heat = 'none' | 'pos' | 'deaths' | 'kills'

export function MultiRoundView({ match, map, img, lowerImg }: { match: MatchData; map: MapMeta; img?: HTMLImageElement; lowerImg?: HTMLImageElement }) {
  const [team, setTeam] = useState(match.teams[1])
  const [side, setSide] = useState<Side>('T')
  const [buys, setBuys] = useState<Set<BuyType>>(new Set(['pistol', 'eco', 'force', 'full']))
  const [result, setResult] = useState<'all' | 'won' | 'lost'>('all')
  const [manual, setManual] = useState<Set<number> | null>(null)
  const [t, setT] = useState(() => Number(location.hash.split('/')[2]) || 0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(2)
  const [trails, setTrails] = useState(true)
  const [nades, setNades] = useState(false)
  const [names, setNames] = useState(false)
  const [enemies, setEnemies] = useState(false)
  const [perRoundColor, setPerRoundColor] = useState(false)
  const [heat, setHeat] = useState<Heat>('none')
  const [only, setOnly] = useState<Set<string>>(new Set()) // leer = alle Spieler
  useEffect(() => setOnly(new Set()), [team])
  const ok = (s?: string) => !only.size || (!!s && only.has(s))
  const togglePlayer = (s: string) => setOnly(o => { const n = new Set(o); n.has(s) ? n.delete(s) : n.add(s); return n })
  const [level, setLevel] = useState<'upper' | 'lower'>('upper')

  const sideOf = (r: Round): Side => (r.teamOnSide.CT === team ? 'CT' : 'T')
  const filtered = useMemo(() => new Set(match.rounds.map((r, i) => i).filter(i => {
    const r = match.rounds[i]; const s = sideOf(r)
    return s === side && buys.has(r.buy[s]) && (result === 'all' || (result === 'won') === (r.winner === s))
  })), [match, team, side, buys, result])
  useEffect(() => setManual(null), [team, side, buys, result])
  const selected = manual ?? filtered
  const rounds = [...selected].sort((a, b) => a - b).map(i => match.rounds[i])
  const players = match.players.filter(p => p.team === team)
  const maxT = Math.max(10, ...rounds.map(r => ((r.frameTicks[r.frameTicks.length - 1] ?? r.endTick) - r.freezeEndTick) / TICKRATE))

  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const tRef = useRef(t); tRef.current = t

  useEffect(() => {
    if (!playing) return
    let last = performance.now(), raf = 0
    const loop = (now: number) => {
      const next = tRef.current + ((now - last) / 1000) * speed; last = now
      if (next >= maxT) { setT(maxT); setPlaying(false); return }
      setT(next); raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [playing, speed, maxT])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.code === 'Space') { e.preventDefault(); setPlaying(p => !p) } }
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Zeichnen
  useEffect(() => {
    const c = canvasRef.current, w = wrapRef.current
    if (!c || !w) return
    const size = Math.min(w.clientWidth, w.clientHeight), dpr = window.devicePixelRatio || 1
    if (c.width !== size * dpr) { c.width = size * dpr; c.height = size * dpr; c.style.width = c.style.height = `${size}px` }
    const ctx = c.getContext('2d')!, zoom = (size * dpr) / 1024
    const layers: Layer[] = []
    rounds.forEach((r, k) => {
      const tick = r.freezeEndTick + t * TICKRATE, s = sideOf(r)
      const color = perRoundColor ? ROUND_COLORS[k % ROUND_COLORS.length] : undefined
      if (enemies) layers.push({ round: r, tick, alpha: 0.35, side: s === 'CT' ? 'T' : 'CT', showNames: false })
      layers.push({ round: r, tick, alpha: heat === 'none' ? 0.9 : 0.5, side: s, trail: trails ? Infinity : 0, nadeHistory: nades, showNames: names, players: only.size ? only : undefined, color })
    })
    const bg = level === 'lower' && lowerImg ? lowerImg : img
    if (heat === 'none') { drawScene(ctx, match, { map, level }, bg, layers, zoom); return }
    drawScene(ctx, match, { map, level }, bg, [], zoom)
    drawHeat(ctx, map, zoom, heatPoints(rounds, heat, t, sideOf, ok))
  })
  useEffect(() => {
    const ro = new ResizeObserver(() => setT(x => x + 1e-6)); if (wrapRef.current) ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  // Wer steht wo zum Zeitpunkt t (häufigster Callout pro Spieler)
  const whereAt = useMemo(() => players.map(p => {
    const counts = new Map<string, number>(); let n = 0
    for (const r of rounds) {
      const tr = r.tracks.find(x => x.steamid === p.steamid); if (!tr) continue
      const st = playerAt(r, tr, frameAt(r, r.freezeEndTick + t * TICKRATE))
      if (st.hp <= 0) { counts.set('✝ dead', (counts.get('✝ dead') ?? 0) + 1); n++; continue }
      counts.set(st.place || '?', (counts.get(st.place || '?') ?? 0) + 1); n++
    }
    return { p, n, top: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 3) }
  }), [players, rounds, Math.floor(t)])

  const toggleBuy = (b: BuyType) => setBuys(s => { const n = new Set(s); n.has(b) ? n.delete(b) : n.add(b); return n })
  const clock = t < 0 ? `Freeze` : `${Math.floor(Math.max(0, 115 - t) / 60)}:${String(Math.floor(Math.max(0, 115 - t) % 60)).padStart(2, '0')}`

  return (
    <div className="replay">
      <RoundStrip match={match} selected={selected} onPick={i => setManual(prev => {
        const n = new Set(prev ?? filtered); n.has(i) ? n.delete(i) : n.add(i); return n
      })} />
      <div className="replay-body">
        <div className="side-col">
          <div className="opts">
            <b>Team</b>
            <div className="seg">{match.teams.map(tm => <button key={tm} className={team === tm ? 'on' : ''} onClick={() => setTeam(tm)}>{tm}</button>)}</div>
            <b>Side</b>
            <div className="seg">{(['T', 'CT'] as Side[]).map(s => <button key={s} className={side === s ? 'on' : ''} onClick={() => setSide(s)}>{s}</button>)}</div>
            <b>Buy</b>
            <div className="seg">{(['pistol', 'eco', 'force', 'full'] as BuyType[]).map(b => <button key={b} className={buys.has(b) ? 'on' : ''} onClick={() => toggleBuy(b)}>{BUY_LABEL[b]}</button>)}</div>
            <b>Result</b>
            <div className="seg">{([['all', 'All'], ['won', 'Won'], ['lost', 'Lost']] as const).map(([k, l]) => <button key={k} className={result === k ? 'on' : ''} onClick={() => setResult(k)}>{l}</button>)}</div>
            <div className="small muted">{rounds.length} rounds selected · click the round bar to add or remove rounds</div>
          </div>
          <div className="opts">
            <label><input type="checkbox" checked={trails} onChange={e => setTrails(e.target.checked)} /> Paths</label>
            <label><input type="checkbox" checked={nades} onChange={e => setNades(e.target.checked)} /> Grenades (throw → landing)</label>
            <label><input type="checkbox" checked={names} onChange={e => setNames(e.target.checked)} /> Names</label>
            <label><input type="checkbox" checked={enemies} onChange={e => setEnemies(e.target.checked)} /> Show enemies</label>
            <label><input type="checkbox" checked={perRoundColor} onChange={e => setPerRoundColor(e.target.checked)} /> One color per round</label>
            {map.verticalsections && <label><input type="checkbox" checked={level === 'lower'} onChange={e => setLevel(e.target.checked ? 'lower' : 'upper')} /> Lower level</label>}
            <b>Heatmap</b>
            <div className="seg">{([['none', 'Off'], ['pos', 'Positions'], ['deaths', 'Deaths'], ['kills', 'Kills']] as const).map(([k, l]) => <button key={k} className={heat === k ? 'on' : ''} onClick={() => setHeat(k)}>{l}</button>)}</div>
          </div>
        </div>
        <div className="canvas-wrap" ref={wrapRef}><canvas ref={canvasRef} /></div>
        <div className="side-col">
          <div className="clock">{clock}</div>
          <div className="opts">
            <b>Who is where ({Math.max(0, Math.floor(t))} s into the round)</b>
            {whereAt.map(({ p, n, top }) => (
              <div key={p.steamid} className={`where ${only.has(p.steamid) ? 'focus' : ''} ${only.size && !only.has(p.steamid) ? 'off' : ''}`} onClick={() => togglePlayer(p.steamid)}>
                <div className="pname">{p.name}</div>
                <div className="small muted">{top.map(([pl, c]) => `${pl} ${Math.round((100 * c) / Math.max(1, n))}%`).join(' · ')}</div>
              </div>
            ))}
            <div className="small muted">Click players to show only them. Click again to remove.</div>
          </div>
          {perRoundColor && (
            <div className="opts small">{rounds.map((r, k) => (
              <span key={r.num}><span className="dot" style={{ background: ROUND_COLORS[k % ROUND_COLORS.length] }} /> R{r.num} {r.winner === sideOf(r) ? '✓' : '✗'} {BUY_LABEL[r.buy[sideOf(r)]]}</span>
            ))}</div>
          )}
        </div>
      </div>
      <div className="controls">
        <button className="play" onClick={() => setPlaying(p => !p)}>{playing ? '⏸' : '▶'}</button>
        <div className="timeline"><input type="range" min={-3} max={maxT} step={0.05} value={t} onChange={e => setT(Number(e.target.value))} /></div>
        {[1, 2, 4, 8].map(s => <button key={s} className={s === speed ? 'on' : ''} onClick={() => setSpeed(s)}>{s}x</button>)}
      </div>
    </div>
  )
}

function heatPoints(rounds: Round[], heat: Heat, t: number, sideOf: (r: Round) => Side, ok: (s?: string) => boolean): [number, number][] {
  const pts: [number, number][] = []
  for (const r of rounds) {
    const s = sideOf(r), tick = r.freezeEndTick + t * TICKRATE
    const sideOfP = (sid?: string) => r.tracks.find(x => x.steamid === sid)?.side
    if (heat === 'pos') {
      const f0 = Math.ceil(frameAt(r, r.freezeEndTick)), f1 = Math.floor(frameAt(r, tick))
      for (const tr of r.tracks) {
        if (tr.side !== s || !ok(tr.steamid)) continue
        for (let i = f0; i <= f1; i += 4) if (tr.hp[i] > 0) pts.push([tr.x[i], tr.y[i]])
      }
    }
    for (const k of r.kills) {
      if (k.tick > tick) continue
      if (heat === 'deaths' && sideOfP(k.victim) === s && ok(k.victim)) pts.push([k.victimPos[0], k.victimPos[1]])
      if (heat === 'kills' && k.attackerPos && sideOfP(k.attacker) === s && ok(k.attacker)) pts.push([k.attackerPos[0], k.attackerPos[1]])
    }
  }
  return pts
}
