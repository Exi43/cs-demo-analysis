import { useMemo, useState, type ReactNode } from 'react'
import type { MatchData } from '../../shared/model'
import type { Entry } from '../../shared/analysis/report'
import type { Ref } from '../../shared/analysis/rounds'
import { buildAntiStrat } from '../../shared/analysis/antistrat'
import { toMarkdown } from '../../shared/analysis/antistrat-text'
import { cards, economyRows, ourTeam, playerRows, prepare, roundInfos, sidesOf } from '../../shared/analysis/glance'
import type { AntiStrat } from '../../shared/analysis/types'
import { Icon } from '../icons'
import { mapLabel } from '../format'
import { RoundStrip } from './RoundStrip'
import { GlanceView, useTeamApi } from './report/glance'
import { EconomyTab, OpponentTab, PlayersTab, RoundsTab } from './report/tabs'
import { ExportIcon, ReportCtx, TokenIcon, type Ctx } from './report/ui'
import './report/report.css'

/** Team über mehrere Demos finden: das Team mit den meisten gemeinsamen Spielern */
export function entriesFor(matches: MatchData[], base: MatchData, team: string): { entries: Entry[]; skipped: string[] } {
  const ids = new Set(base.players.filter(p => p.team === team).map(p => p.steamid))
  const entries: Entry[] = [], skipped: string[] = []
  for (const m of matches) {
    const best = m.teams.map(t => ({ t, n: m.players.filter(p => p.team === t && ids.has(p.steamid)).length })).sort((a, b) => b.n - a.n)[0]
    if (best && best.n >= 2) entries.push({ match: m, team: best.t }); else skipped.push(m.fileName)
  }
  return { entries, skipped }
}

/** PDF: Spielzug-Karten für den Druck aufklappen, danach wieder wie vorher */
function printPdf() {
  const closed = [...document.querySelectorAll<HTMLDetailsElement>('.report details:not([open])')]
  closed.forEach(d => (d.open = true))
  addEventListener('afterprint', () => closed.forEach(d => (d.open = false)), { once: true })
  window.print()
}

function ExportBar({ a }: { a: AntiStrat }) {
  const [msg, setMsg] = useState('')
  const say = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 1800) }
  const copy = () => navigator.clipboard.writeText(toMarkdown(a)).then(() => say('Copied'), e => say(`Copy failed: ${e}`))
  const save = () => {
    const url = URL.createObjectURL(new Blob([toMarkdown(a)], { type: 'text/markdown' }))
    const link = document.createElement('a')
    link.href = url; link.download = `antistrat-${a.team}-${a.map}.md`.replace(/[^\w.-]+/g, '_'); link.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
  return (
    <span className="rp-export">
      {msg && <span className="small muted">{msg}</span>}
      <button className="ghost" onClick={copy} title="Copy the full anti-strat as text (Markdown)"><ExportIcon name="copy" /> Copy text</button>
      <button className="ghost" onClick={save} title="Save the full anti-strat as .md file"><ExportIcon name="download" /> .md</button>
      <button className="ghost" onClick={printPdf} title="Print / save as PDF"><ExportIcon name="print" /> PDF</button>
    </span>
  )
}

type Tab = 'glance' | 'rounds' | 'players' | 'opponent' | 'economy'
const TABS: [Tab, string, ReactNode][] = [
  ['glance', 'At a glance', <Icon name="analysis" size={16} />], ['rounds', 'Rounds', <Icon name="stats" size={16} />], ['players', 'Players', <Icon name="team" size={16} />],
  ['opponent', 'Opponent anti-strat', <Icon name="target" size={16} />], ['economy', 'Economy', <TokenIcon t="deagle" size={15} />],
]
// Selbsttest: CSDA_VIEW=auto/report/;tab=players (Tab beim Start)
const TAB0 = /;tab=(\w+)/.exec(location.hash)?.[1] as Tab | undefined
// Selbsttest: ;player=<Name> filtert die Karten auf einen Spieler
const PLAYER0 = /;player=([^;]+)/.exec(location.hash)?.[1]

export function ReportView({ matches, onRef }: { matches: MatchData[]; onRef: (r: Ref) => void }) {
  const base = matches[0]
  const t = useTeamApi()
  const steamids = (t?.s.members ?? []).flatMap(m => (m.steamid ? [m.steamid] : []))
  const auto = ourTeam(base, steamids)
  const [picked, setPicked] = useState<string>()
  const us = picked && base.teams.includes(picked) ? picked : auto, them = base.teams.find(x => x !== us) ?? base.teams[1]
  const [tab, setTab] = useState<Tab>(TAB0 && TABS.some(x => x[0] === TAB0) ? TAB0 : 'glance')
  const [player, setPlayer] = useState(() => PLAYER0 && base.players.find(p => p.name === decodeURIComponent(PLAYER0))?.steamid)

  const { entries, skipped } = useMemo(() => entriesFor(matches, base, us), [matches, us])
  const P = useMemo(() => (entries.length ? prepare(entries, them) : undefined), [entries, them])
  const cs = useMemo(() => P && cards(P, player), [P, player])
  // Gegner-Report erst beim ersten Öffnen des Tabs bauen
  const [oppOn, setOppOn] = useState(tab === 'opponent')
  if (tab === 'opponent' && !oppOn) setOppOn(true)
  const opp = useMemo(() => { if (!oppOn) return; const e = entriesFor(matches, base, them).entries; return e.length ? buildAntiStrat(e) : undefined }, [oppOn, matches, them])

  const ctx = useMemo<Ctx>(() => {
    const won = new Map(P?.rounds.map(d => [`${d.m.id}:${d.r.num}`, d.won]))
    return {
      onRef,
      label: r => `${matches.length > 1 ? `D${matches.findIndex(m => m.id === r.matchId) + 1}·` : ''}R${r.round}`,
      won: r => won.get(`${r.matchId}:${r.round}`),
    }
  }, [P, matches, onRef])
  const swap = () => { setPicked(them); setPlayer(undefined) }

  if (!P || !cs) return <div className="report">{skipped.length > 0 && <div className="error">Team not found in: {skipped.join(', ')}</div>}</div>
  const sides = sidesOf(P), score = entries.map(e => ({ us: e.match.finalScore[e.team], them: e.match.finalScore[e.match.teams.find(x => x !== e.team)!] }))
  const won = score[0].us > score[0].them, who = { us, them, map: base.map, matches, score: `${score[0].us}:${score[0].them}` }
  const sideTile = (s: 'T' | 'CT') => (
    <div className={`rp-side ${sides[s].won * 2 >= sides[s].total ? 'good' : 'bad'}`} title={`Rounds we won on ${s}`}>
      <span><span className={`side-dot ${s}`} />{s}</span><b>{sides[s].won}<span>/{sides[s].total}</span></b>
    </div>
  )

  return (
    <div className="report">
      <ReportCtx.Provider value={ctx}>
        <header className="rp-head">
          <div className="rp-team us">
            <span>Our team</span><b title={base.players.filter(p => p.team === us).map(p => p.name).join(', ')}>{us}</b>
            <button className="ghost rp-swap" onClick={swap} title={`Analyse the match as ${them}`}><Icon name="shuffle" size={14} /> Switch</button>
          </div>
          <div className={`rp-score ${won ? 'win' : score[0].us === score[0].them ? '' : 'loss'}`}>
            <div>{score[0].us}<i>:</i>{score[0].them}</div>
            <span>{won ? 'Win' : score[0].us === score[0].them ? 'Draw' : 'Loss'} · {mapLabel(base.map)}{score.length > 1 ? ` · ${score.length} demos` : ''}</span>
          </div>
          <div className="rp-team them"><span>Opponent</span><b title={base.players.filter(p => p.team === them).map(p => p.name).join(', ')}>{them}</b></div>
          <div className="rp-sides">{sideTile('T')}{sideTile('CT')}</div>
        </header>
        <div className="rp-strip"><RoundStrip match={base} us={us} onPick={i => { const r = base.rounds[i]; onRef({ matchId: base.id, round: r.num, tick: r.freezeEndTick }) }} /></div>
        {skipped.length > 0 && <div className="error">Team not found in: {skipped.join(', ')}</div>}

        <nav className="rp-tabs" role="tablist">
          {TABS.map(([id, label, icon]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{icon} {label}</button>
          ))}
          {tab === 'opponent' && opp && <ExportBar a={opp} />}
        </nav>

        {tab === 'glance' && <GlanceView cards={cs} who={who} t={t} player={player} playerName={player && P.names[player]} onClearPlayer={() => setPlayer(undefined)} />}
        {tab === 'rounds' && <RoundsTab rows={roundInfos(P)} names={P.names} />}
        {tab === 'players' && <PlayersTab rows={playerRows(P)} player={player} onPlayer={id => { setPlayer(id); setTab('glance') }} />}
        {tab === 'opponent' && (opp ? <OpponentTab a={opp} /> : <p className="muted">Opponent not found in these demos.</p>)}
        {tab === 'economy' && <EconomyTab rows={economyRows(P)} us={us} them={them} />}
      </ReportCtx.Provider>
    </div>
  )
}
