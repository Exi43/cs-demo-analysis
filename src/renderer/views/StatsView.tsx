import { useMemo, useState } from 'react'
import type { MatchData, Side } from '../../shared/model'
import { computeStats, type PlayerStats } from '../../shared/stats'
import { BUY_LABEL } from '../format'

type Col = { key: string; label: string; title: string; get: (p: PlayerStats) => number; fmt?: (v: number) => string; good?: number; bad?: number }

const f1 = (v: number) => v.toFixed(1)
const f2 = (v: number) => v.toFixed(2)
const pct = (v: number) => `${v.toFixed(0)}%`

const COLS: Col[] = [
  { key: 'rating', label: 'Rating', title: 'FACEIT-style rating (approximation): round swing, RWS, KAST and multi-kills. ~1.00 = average', get: p => p.rating, fmt: f2, good: 1.15, bad: 0.85 },
  { key: 'swing', label: 'Swing', title: 'FACEIT-style round swing: percentage points of round win chance added (+) or lost (−) per round', get: p => p.swingPct, fmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + '%', good: 2, bad: -2 },
  { key: 'rws', label: 'RWS', title: 'Round Win Share: share of each won round (damage based, bomb plant/defuse +30). ~10 = average', get: p => p.rws, fmt: f1, good: 12, bad: 7 },
  { key: 'kills', label: 'K', title: 'Kills', get: p => p.kills },
  { key: 'deaths', label: 'D', title: 'Deaths', get: p => p.deaths },
  { key: 'assists', label: 'A', title: 'Assists', get: p => p.assists },
  { key: 'kd', label: 'K/D', title: 'Kills per death (FACEIT)', get: p => p.kd, fmt: f2, good: 1.2, bad: 0.8 },
  { key: 'kpr', label: 'K/R', title: 'Kills per round (FACEIT)', get: p => p.kpr, fmt: f2, good: 0.85, bad: 0.55 },
  { key: 'adr', label: 'ADR', title: 'Average damage per round', get: p => p.adr, fmt: f1, good: 90, bad: 60 },
  { key: 'hs', label: 'HS%', title: 'Headshot percentage', get: p => p.hsPct, fmt: pct },
  { key: 'kast', label: 'KAST', title: 'Rounds with a kill, assist, survival or traded death', get: p => p.kast, fmt: pct, good: 75, bad: 60 },
  { key: 'open', label: 'Opening', title: 'Opening kills / opening deaths', get: p => p.openingKills - p.openingDeaths, fmt: undefined },
  { key: 'trade', label: 'Trades', title: 'Kills that avenged a teammate / own deaths that were avenged', get: p => p.tradeKills },
  { key: 'multi', label: '3k+', title: 'Rounds with 3, 4 or 5 kills', get: p => p.multi[2] + p.multi[3] + p.multi[4] },
  { key: 'clutch', label: 'Clutch', title: 'Won / played 1vX situations', get: p => p.clutchesWon },
  { key: 'ud', label: 'Util DMG', title: 'Damage from HE and molotov', get: p => p.utilDamage },
  { key: 'ef', label: 'Flashed', title: 'Enemies flashed (>0.7 s) / team flashes', get: p => p.enemiesFlashed },
]

function cell(c: Col, p: PlayerStats) {
  const v = c.get(p)
  if (c.key === 'open') return <>{p.openingKills}<span className="muted">/{p.openingDeaths}</span></>
  if (c.key === 'trade') return <>{p.tradeKills}<span className="muted">/{p.tradedDeaths}</span></>
  if (c.key === 'clutch') return <>{p.clutchesWon}<span className="muted">/{p.clutchesPlayed}</span></>
  if (c.key === 'ef') return <>{p.enemiesFlashed}{p.teamFlashed > 0 && <span className="bad-txt"> /{p.teamFlashed}</span>}</>
  const cls = c.good !== undefined && v >= c.good ? 'good-txt' : c.bad !== undefined && v <= c.bad ? 'bad-txt' : ''
  return <span className={cls}>{c.fmt ? c.fmt(v) : v}</span>
}

export function StatsView({ match }: { match: MatchData }) {
  const [sideFilter, setSideFilter] = useState<'all' | Side>('all')
  const [buyFilter, setBuyFilter] = useState<string>('all')
  const [sort, setSort] = useState('rating')
  // Pro Team rechnen: Seite und Buy-Typ beziehen sich auf das eigene Team
  const list = useMemo(() => match.teams.flatMap(team => {
    const sideOf = (r: MatchData['rounds'][0]): Side => (r.teamOnSide.CT === team ? 'CT' : 'T')
    return computeStats(match, r => (sideFilter === 'all' || sideOf(r) === sideFilter) && (buyFilter === 'all' || r.buy[sideOf(r)] === buyFilter))
      .players.filter(p => p.team === team)
  }), [match, sideFilter, buyFilter])

  const col = COLS.find(c => c.key === sort) ?? COLS[0]

  return (
    <div className="stats">
      <div className="filters">
        <span className="muted">Side:</span>
        {(['all', 'CT', 'T'] as const).map(s => (
          <button key={s} className={sideFilter === s ? 'on' : ''} onClick={() => setSideFilter(s)}>{s === 'all' ? 'Both' : s}</button>
        ))}
        <span className="muted" style={{ marginLeft: 12 }}>Own buy:</span>
        {(['all', 'pistol', 'eco', 'force', 'full'] as const).map(b => (
          <button key={b} className={buyFilter === b ? 'on' : ''} onClick={() => setBuyFilter(b)}>{b === 'all' ? 'All' : BUY_LABEL[b]}</button>
        ))}
      </div>
      {match.teams.map(team => (
        <div key={team} className="stat-team">
          <h3>{team} <span className="muted">{match.finalScore[team]}</span></h3>
          <table className="stat-table">
            <thead><tr><th>Player</th>{COLS.map(c => (
              <th key={c.key} title={c.title} className={sort === c.key ? 'sorted' : ''} onClick={() => setSort(c.key)}>{c.label}</th>
            ))}</tr></thead>
            <tbody>
              {list.filter(p => p.team === team).sort((a, b) => col.get(b) - col.get(a)).map(p => (
                <tr key={p.steamid}><td className="pname">{p.name}</td>{COLS.map(c => <td key={c.key}>{cell(c, p)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <Economy match={match} />
      <p className="muted small">Rating and Swing rebuild FACEIT Rating / Round Swing. FACEIT does not publish the exact weights, so values are close but not identical.</p>
    </div>
  )
}

function Economy({ match }: { match: MatchData }) {
  const max = Math.max(...match.rounds.flatMap(r => [r.equipValue.CT, r.equipValue.T]), 1)
  return (
    <div className="stat-team">
      <h3>Economy per round</h3>
      <div className="eco">
        {match.rounds.map(r => (
          <div key={r.num} className="eco-col" title={`R${r.num}\nCT ${r.teamOnSide.CT}: $${r.equipValue.CT} (${BUY_LABEL[r.buy.CT]})\nT ${r.teamOnSide.T}: $${r.equipValue.T} (${BUY_LABEL[r.buy.T]})`}>
            {match.teams.map(team => {
              const side: Side = r.teamOnSide.CT === team ? 'CT' : 'T'
              return <div key={team} className={`eco-bar ${side} ${r.winner === side ? 'won' : ''}`} style={{ height: `${(r.equipValue[side] / max) * 60}px` }} />
            })}
            <span className="small muted">{r.num}</span>
          </div>
        ))}
      </div>
      <div className="small muted">Left bar: {match.teams[0]}, right: {match.teams[1]}. Color = side, bright = round won.</div>
    </div>
  )
}
