// Highlights des 3D-Replays (Berat 28.10., wie CS Demo Manager): Knopf in der Demo-Leiste öffnet die Liste aller Kills und Tode, Filter
// Spieler (Standard beim ersten Öffnen: Fokus-Spieler) und Kills/Tode/beides. Klick = 5 s davor in die Ego-Sicht des Killers bzw. Opfers
// springen und abspielen; "Play all" zeigt je Eintrag −5 s … +2 s und springt weiter (Stand nur im Highlights-Knopf, z. B. 2/42;
// Weiter/Stopp im Panel). Uhr und Kamera nur über seek/play/pick der View. Liste nur bei offenem Panel (useMemo je Filter); "Play all"
// prüft im HUD-Takt (tick ≤ 15×/s), nicht pro Bild. Selbsttest: Hash-Segment 'hl' (Panel offen), 'hl=<n>' (Eintrag n der Liste des
// Hash-Spielers angeklickt), 'hl=all' (Play all), z. B. #auto/replay3d/5/79/ego/0//hl=2 bzw. #auto/replay/5/60/hl. 2D (Highlights2D):
// Fokus = Spieler weiß umrandet, keine Kamera.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { MatchData } from '../../../shared/model'
import { highlights, reelStep, type Highlight, type HighlightFilter } from '../highlights'
import { Avatar, HudIcon, useHudScale } from './assets'
import type { HudPlayerView } from './types'
import './highlights.css'

export interface HighlightCtl { seek(tick: number): void; play(on: boolean): void; pick(steamid: string): void }
export type HighlightsState = ReturnType<typeof useHighlights>

/** Zustand: offen, Filter (Spieler null = alle, undefined = noch nie geöffnet), laufendes "Play all" (Liste beim Start eingefroren) */
export function useHighlights(match: MatchData, tick: number, focus: string | null, ctl: HighlightCtl) {
  const c = useRef(ctl)
  c.current = ctl
  const rate = match.tickrate || 64
  const [open, setOpen] = useState(false)
  const [player, setPlayer] = useState<string | null>()
  const [filter, setFilter] = useState<HighlightFilter>('both')
  const [reel, setReel] = useState<{ list: Highlight[]; i: number } | null>(null)
  const go = (h: Highlight) => { c.current.pick(h.pov); c.current.seek(h.start); c.current.play(true) }
  /** Eintrag anklicken: hinspringen, abspielen, Panel zu */
  const one = (h: Highlight) => { setOpen(false); setReel(null); go(h) }
  const all = (list: Highlight[]) => { if (!list.length) return; setOpen(false); go(list[0]); setReel({ list, i: 0 }) }

  useEffect(() => {
    if (!reel) return
    const { list, i } = reel, s = reelStep(list, i, tick, rate)
    if (s === 'play') return
    if (s === 'next') {
      const n = list[i + 1]
      if (n.pov !== list[i].pov || n.start > tick) go(n) // Mehrfach-Kill desselben Spielers läuft schon: weiter statt zurückspringen
      return setReel({ list, i: i + 1 })
    }
    if (s === 'done') c.current.play(false)
    setReel(null)
  }, [tick, reel])

  useEffect(() => {
    const seg = location.hash.startsWith('#auto/') ? location.hash.slice(1).split('/') : []
    const m = seg.map(s => /^hl(?:=(\d+|all))?$/.exec(s)).find(Boolean)
    if (!m) return
    const n = m[1], who = match.players[Number(seg[5])]?.steamid ?? focus, list = highlights(match, who, 'both')
    setPlayer(who)
    if (n === 'all') all(list); else if (n && list[+n]) one(list[+n]); else setOpen(true)
  }, [])

  return {
    open, filter, reel, player: player === undefined ? focus : player, setPlayer, setFilter, one, all,
    toggle() { if (player === undefined) setPlayer(focus); setOpen(!open) },
    close: () => setOpen(false),
    next() { const n = reel?.list[reel.i + 1]; if (n) { go(n); setReel({ list: reel.list, i: reel.i + 1 }) } else setReel(null) },
    stop: () => setReel(null),
  }
}

const KIND: [HighlightFilter, string, string?][] = [['both', 'Kills & deaths'], ['kill', 'Kills', 'ui/crosshair_circle'], ['death', 'Deaths', 'ui/kill']]
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
/** mousedown ohne Fokus: Leertaste bleibt Play/Pause (wie Demo-Leiste) */
const noFocus = (e: { preventDefault(): void }) => e.preventDefault()

type Chip = Pick<HudPlayerView, 'steamid' | 'name' | 'side' | 'avatar'>
interface HighlightsProps { hl: HighlightsState; match: MatchData; players: readonly Chip[] }

/** 2D-Replay: dieselbe UI in einer eigenen HUD-Bühne über dem Radar (Farben, Schrift, Skalierung wie das 3D-HUD) */
export function Highlights2D(p: HighlightsProps) {
  const ref = useRef<HTMLDivElement>(null)
  useHudScale(ref)
  return <div ref={ref} className="hud-stage hl-stage"><Highlights {...p} /></div>
}

/** Panel (nur offen) als eigene .hud-Ebene über dem HUD (1080p-px); laufendes "Play all" zeigt der Knopf in der Demo-Leiste */
export function Highlights({ hl, match, players }: HighlightsProps) {
  const name = useMemo(() => new Map(match.players.map(p => [p.steamid, p.name])), [match])
  if (!hl.open) return null
  return <div className="hud"><Panel hl={hl} match={match} players={players} name={name} cur={hl.reel?.list[hl.reel.i]} /></div>
}

function Panel({ hl, match, players, name, cur }: HighlightsProps & { name: Map<string, string>; cur?: Highlight }) {
  const list = useMemo(() => highlights(match, hl.player, hl.filter), [match, hl.player, hl.filter])
  return (
    <div className="hl-panel" data-hud="highlights" onMouseDown={noFocus}>
      <header>
        <HudIcon name="ui/film" /><b>Highlights</b><span className="who">{hl.player ? name.get(hl.player) : 'All players'} · {list.length}</span>
        {hl.reel ? <>
          <span className="n">{hl.reel.i + 1} / {hl.reel.list.length}</span>
          <button className="hl-play" title="Next highlight" onClick={hl.next}><HudIcon name="ui/skip" />Next</button>
          <button className="hl-play" title="Stop play all" onClick={hl.stop}>Stop</button>
        </> : <button className="hl-play" disabled={!list.length} onClick={() => hl.all(list)}><HudIcon name="ui/play" />Play all</button>}
        <button className="x" title="Close" onClick={hl.close}>×</button>
      </header>
      <div className="hl-who">
        <button className={`all ${hl.player === null ? 'on' : ''}`} onClick={() => hl.setPlayer(null)}>All</button>
        {players.map(p => (
          <button key={p.steamid} className={hl.player === p.steamid ? 'on' : ''} title={p.name} aria-label={p.name} onClick={() => hl.setPlayer(p.steamid)}>
            <Avatar steamid={p.steamid} url={p.avatar} name={p.name} side={p.side} />
          </button>
        ))}
      </div>
      <div className="hl-kind">
        {KIND.map(([k, t, ic]) => (
          <button key={k} className={hl.filter === k ? 'on' : ''} aria-pressed={hl.filter === k} onClick={() => hl.setFilter(k)}>{ic && <HudIcon name={ic} />}{t}</button>
        ))}
      </div>
      <div className="hl-list">
        {list.map(h => (
          <button key={`${h.tick}-${h.victim}`} className={`hl-it ${h.kind} ${cur?.tick === h.tick && cur.victim === h.victim ? 'cur' : ''}`} onClick={() => hl.one(h)}
            title={`Watch from ${name.get(h.pov)}'s view, 5 s before`}>
            <HudIcon name={h.kind === 'kill' ? 'ui/crosshair_circle' : 'ui/kill'} className="k" />
            <span className="r">R{h.round}</span><span className="t">{mmss(h.clock)}</span>
            <span className={`nm a ${h.attackerSide ?? ''}`}>{h.attacker ? name.get(h.attacker) : ''}</span>
            <span className="w"><HudIcon name={h.weapon} img />{h.headshot && <HudIcon name="hud/deathnotice/icon_headshot" className="hs" />}</span>
            <span className={`nm ${h.victimSide}`}>{name.get(h.victim)}</span>
          </button>
        ))}
        {!list.length && <div className="hl-none">No {hl.filter === 'kill' ? 'kills' : hl.filter === 'death' ? 'deaths' : 'kills or deaths'} for this filter.</div>}
      </div>
    </div>
  )
}
