// Bausteine des Gegner-Tabs: Heatmap, Spielzug-Karte, Util- und Push-Tabelle
import type { Heatmap, Play, PushRow, UtilRow } from '../../../shared/analysis/types'
import { clockSpan } from '../../../shared/analysis/util'
import { Icon } from '../../icons'
import { Chips, LineItem, Rich, TagBadge, TokenIcon } from './ui'

export function HeatmapGrid({ h }: { h: Heatmap }) {
  const max = Math.max(1, ...h.rows.flatMap(r => r.cells.map(c => c.length)))
  return (
    <div className="rp-heat" style={{ gridTemplateColumns: `minmax(150px, 1.4fr) repeat(${h.buckets.length}, minmax(0, 1fr))` }}>
      <div className="rp-heat-h" />
      {h.buckets.map(b => <div key={b} className="rp-heat-h"><Icon name="clock" size={12} /> {b}</div>)}
      {h.rows.map(r => [
        <div key={r.play} className="rp-heat-l"><Rich text={r.play} /></div>,
        ...r.cells.map((c, i) => <div key={`${r.play}${i}`} className="rp-heat-c" style={{ background: c.length ? `rgba(255, 90, 31, ${0.12 + (0.38 * c.length) / max})` : undefined }}><Chips refs={c} /></div>),
      ])}
    </div>
  )
}

/** Spielzug-Karte: zu = Titel, Bilanz, Tag, Chips; auf = Timeline, Rollen je Spieler, Read/Care/Counter */
export function PlayCard({ p }: { p: Play }) {
  return (
    <details className="rp-card rp-play">
      <summary>
        <span className="rp-play-id">{p.id}</span>
        <b className="rp-play-name"><Rich text={p.name} /></b>
        <span className={`rp-site ${p.site}`}>{p.site}</span>
        {p.kinds.map(k => <span key={k} className="rp-kindtag">{k}</span>)}
        <span className={`rp-wl ${p.won * 2 >= p.total ? 'good-txt' : 'bad-txt'}`} title="Rounds they won with this play">{p.won}/{p.total}</span>
        <TagBadge tag={p.tag} />
        <Chips refs={p.refs} />
      </summary>
      <div className="rp-play-body">
        <LineItem l={p.timeline} />
        <div className="rp-roles">{p.roles.map((l, i) => <LineItem key={i} l={l} />)}</div>
        {p.read && <LineItem l={p.read} kind="read" />}
        {p.care && <LineItem l={p.care} kind="care" />}
        {p.counter && <LineItem l={p.counter} kind="counter" />}
      </div>
    </details>
  )
}

export function UtilTable({ rows }: { rows: UtilRow[] }) {
  return (
    <table className="rp-table">
      <thead><tr><th>Clock</th><th>Util</th><th>Target</th><th>Thrower</th><th>Seen</th><th>Rounds</th></tr></thead>
      <tbody>{rows.map((u, i) => (
        <tr key={i}>
          <td className="rp-num">{clockSpan(u.fromSec, u.toSec)}</td>
          <td>{u.nade.map(n => <TokenIcon key={n} t={n} size={16} />)}</td><td>{u.target}</td><td>{u.throwers.join(', ')}</td>
          <td><TagBadge tag={u.tag} /></td><td><Chips refs={u.refs} /></td>
        </tr>
      ))}</tbody>
    </table>
  )
}

export function PushTable({ rows }: { rows: PushRow[] }) {
  return (
    <table className="rp-table">
      <thead><tr><th /><th>Where</th><th>Who</th><th>K–D</th><th>Rounds</th></tr></thead>
      <tbody>{rows.map((p, i) => (
        <tr key={i}>
          <td><span className={`rp-push ${p.level}`} title={p.level === 'push' ? 'deep push into their half' : 'early on a contested spot'}><Icon name="arrow" size={12} /> {p.level}</span></td>
          <td><b>{p.place}</b></td><td>{p.players.join(', ')}</td>
          <td className={p.kills >= p.deaths ? 'good-txt' : 'bad-txt'}>{p.kills}–{p.deaths}</td>
          <td><Chips refs={p.refs} /></td>
        </tr>
      ))}</tbody>
    </table>
  )
}
