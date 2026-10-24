import { useMemo, useState } from 'react'
import type { MatchData } from '../../shared/model'
import type { Entry } from '../../shared/analysis/report'
import type { Ref } from '../../shared/analysis/rounds'
import { buildAntiStrat } from '../../shared/analysis/antistrat'
import { toMarkdown } from '../../shared/analysis/antistrat-text'
import type { AntiStrat, IconToken } from '../../shared/analysis/types'
import { Icon } from '../icons'
import { mapLabel } from '../format'
import { CTSideView, GamePlan, RosterTable, RoundTable, TSideView } from './report/sections'
import { Chips, ExportIcon, Lines, ReportCtx, Rich, Sub, TagBadge, TokenIcon, type Ctx } from './report/ui'
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

const JUMP: [string, string][] = [['rp-t', 'T side'], ['rp-ct', 'CT side'], ['rp-plan', 'Game plan'], ['rp-rounds', 'Rounds']]
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })

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
      <button className="ghost" onClick={copy} title="Copy as text (Markdown)"><ExportIcon name="copy" /> Copy text</button>
      <button className="ghost" onClick={save} title="Save as .md file"><ExportIcon name="download" /> .md</button>
      <button className="ghost" onClick={printPdf} title="Print / save as PDF"><ExportIcon name="print" /> PDF</button>
    </span>
  )
}

const LEGEND: [IconToken, string][] = [
  ['smoke', 'smoke'], ['flash', 'flash'], ['molly', 'molly'], ['he', 'HE'], ['awp', 'AWP'], ['deagle', 'Deagle'], ['c4', 'plant'], ['kit', 'retake'],
  ['knife', 'lurk'], ['target', 'duel / pick'], ['arrow', 'push'], ['shuffle', 'rotate / fake'], ['layers', 'setup'], ['warn', 'care'],
]

function Header({ a }: { a: AntiStrat }) {
  const sideTile = (s: 'T' | 'CT') => {
    const { won, total } = a.sides[s]
    return (
      <div className={`tile ${won * 2 >= total ? 'good' : 'bad'}`}>
        <div className="tile-top"><span className={`side-dot ${s}`} />Their {s}</div>
        <div className="tile-num">{won}<span>/{total}</span></div>
      </div>
    )
  }
  return (
    <>
      <div className="tiles">
        {a.results.map((r, i) => (
          <div key={i} className={`tile ${r.us > r.them ? 'good' : 'bad'}`}>
            <div className="tile-top"><span>{a.team} vs {r.opponent}</span></div>
            <div className="tile-num">{r.us}<span> : {r.them}</span></div>
          </div>
        ))}
        {sideTile('T')}{sideTile('CT')}
        <div className="tile">
          <div className="tile-top">{mapLabel(a.map)}</div>
          <div className="tile-num">{a.demos}<span> demo{a.demos === 1 ? '' : 's'} · {a.rounds} rds</span></div>
        </div>
      </div>
      <div className="rp-legend small muted">
        <span className="rp-tag habit">HABIT</span> ≥ 3× <span className="rp-tag pattern">PATTERN</span> 2× <span className="rp-tag once">ONCE</span> 1× · n/N = seen in n of N rounds ·
        <Icon name="clock" size={13} /> 1:55 → 0:00 · <b>?</b> = name from landing spot ·
        {LEGEND.map(([t, l]) => <span key={t}><TokenIcon t={t} size={13} /> {l}</span>)}
      </div>
    </>
  )
}

export function ReportView({ matches, onRef }: { matches: MatchData[]; onRef: (r: Ref) => void }) {
  const base = matches[0]
  const [team, setTeam] = useState(base.teams[1])
  const { entries, skipped } = useMemo(() => entriesFor(matches, base, team), [matches, team])
  const a = useMemo(() => (entries.length ? buildAntiStrat(entries) : undefined), [entries])
  const ctx = useMemo<Ctx>(() => {
    const won = new Map(a?.roundList.map(r => [`${r.ref.matchId}:${r.ref.round}`, r.won]))
    return {
      onRef,
      label: r => `${matches.length > 1 ? `D${matches.findIndex(m => m.id === r.matchId) + 1}·` : ''}R${r.round}`,
      won: r => won.get(`${r.matchId}:${r.round}`),
    }
  }, [a, matches, onRef])

  return (
    <div className="report">
      <div className="team-pick">
        {base.teams.map(t => (
          <button key={t} className={`team-card ${team === t ? 'on' : ''}`} onClick={() => setTeam(t)}>
            <div className="tc-name">{t}</div>
            <div className="tc-players">{base.players.filter(p => p.team === t).map(p => p.name).join(' · ')}</div>
          </button>
        ))}
      </div>
      {skipped.length > 0 && <div className="error">Team not found in: {skipped.join(', ')}</div>}
      {a && (
        <ReportCtx.Provider value={ctx}>
          <h1 className="rp-title">Anti-strat · {a.team} · {mapLabel(a.map)}</h1>
          <Header a={a} />

          <nav className="rp-jump">
            {JUMP.map(([id, label]) => <button key={id} className="ghost" onClick={() => jump(id)}>{label}</button>)}
            <ExportBar a={a} />
          </nav>

          <h2><Icon name="star" /> &nbsp;Keys (read first)</h2>
          <div className="rp-keys">{a.keys.map((k, i) => (
            <div key={i} className="rp-card rp-key">
              <div className="rp-key-n"><Icon name="star" size={14} /> {i + 1}</div>
              <div className="rp-key-t">{k.icon && <TokenIcon t={k.icon} size={16} />} <Rich text={k.text} /></div>
              {k.counter && <div className="rp-counter"><Icon name="arrow" size={13} /> <Rich text={k.counter} /></div>}
              <div className="rp-key-f">{k.tag && <TagBadge tag={k.tag} />} <Chips refs={k.refs} /></div>
            </div>
          ))}</div>

          <h2>Roster</h2>
          <RosterTable rows={a.roster} />

          <h2 id="rp-t"><span className="side-dot T" /> T side · {a.sides.T.won}/{a.sides.T.total}</h2>
          <TSideView t={a.t} />

          <h2 id="rp-ct"><span className="side-dot CT" /> CT side · {a.sides.CT.won}/{a.sides.CT.total}</h2>
          <CTSideView ct={a.ct} />

          <div className="rp-cols">
            <Sub title="Economy" icon={<TokenIcon t="deagle" />} show={a.economy.length > 0}><Lines lines={a.economy} /></Sub>
            <Sub title="What worked for us" icon={<Icon name="check" size={15} />} show={a.worked.length > 0}><Lines lines={a.worked} /></Sub>
          </div>

          <h2 id="rp-plan"><Icon name="target" /> &nbsp;Game plan</h2>
          <GamePlan a={a} />

          <h2 id="rp-rounds">Round list</h2>
          <RoundTable rows={a.roundList} />

          {a.limits.length > 0 && (
            <Sub title="Limits" icon={<TokenIcon t="warn" />}>
              <ul className="rp-limits small muted">{a.limits.map((l, i) => <li key={i}><Rich text={l} /></li>)}</ul>
            </Sub>
          )}
          <p className="muted small">Rule-based analysis, no AI. Click any round chip to watch it in the replay.</p>
        </ReportCtx.Provider>
      )}
    </div>
  )
}

