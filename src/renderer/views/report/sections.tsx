// Abschnitte der Anti-Strat-Ansicht: T-Seite, CT-Seite und Tabellen (Roster, Heatmap, Util, Pushes, Rundenliste)
import type { AntiStrat, CTSide, Heatmap, Play, PushRow, RosterRow, RoundRow, TSide, UtilRow } from '../../../shared/analysis/types'
import { clockSpan } from '../../../shared/analysis/util'
import { Icon } from '../../icons'
import { Weapon } from '../../weapons'
import { Blocks, BuyTag, Chips, LineItem, Lines, Rich, Sub, TagBadge, TokenIcon } from './ui'

export function RosterTable({ rows }: { rows: RosterRow[] }) {
  return (
    <table className="rp-table rp-roster">
      <thead><tr><th>Player</th><th title="Our rebuild of the FACEIT rating">Rating</th><th>K–D</th><th>ADR</th><th><span className="side-dot T" />T</th><th><span className="side-dot CT" />CT</th><th>Watch</th></tr></thead>
      <tbody>{rows.map(p => (
        <tr key={p.steamid}>
          <td><b>{p.name}</b></td>
          <td><span className={`rating ${p.rating >= 1.15 ? 'good' : p.rating < 0.85 ? 'bad' : ''}`}>{p.rating.toFixed(2)}</span></td>
          <td className="rp-num">{p.kills}–{p.deaths}</td><td>{Math.round(p.adr)}</td>
          <td><Rich text={p.t} /></td><td><Rich text={p.ct} /></td>
          <td>{p.watch && <LineItem l={p.watch} />}</td>
        </tr>
      ))}</tbody>
    </table>
  )
}

function HeatmapGrid({ h }: { h: Heatmap }) {
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
function PlayCard({ p }: { p: Play }) {
  return (
    <details className="rp-card rp-play">
      <summary>
        <span className="rp-play-id">{p.id}</span>
        <b className="rp-play-name"><Rich text={p.name} /></b>
        <span className={`rp-site ${p.site}`}>{p.site}</span>
        {p.kinds.map(k => <span key={k} className="rp-kindtag">{k}</span>)}
        <span className={`rp-wl ${p.won * 2 >= p.total ? 'good-txt' : 'bad-txt'}`}>{p.won}/{p.total}</span>
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

const Empty = () => <p className="muted small">No patterns found.</p>

export function TSideView({ t }: { t: TSide }) {
  if (!t.overview.length && !t.plays.length && !t.reads.length && !t.awp.length && !t.pistol.length && !t.force.length && !t.second) return <Empty />
  return (
    <>
      <Sub title="Overview" show={t.overview.length > 0}><Lines lines={t.overview} /></Sub>
      <Sub title="Timing" icon={<Icon name="clock" size={15} />} show={t.heatmap.rows.length > 0}><HeatmapGrid h={t.heatmap} /></Sub>
      <Sub title="Plays" icon={<Icon name="target" size={15} />} show={t.plays.length > 0}><div className="rp-plays">{t.plays.map(p => <PlayCard key={p.id} p={p} />)}</div></Sub>
      <Sub title="Reads" icon={<Icon name="target" size={15} />} show={t.reads.length > 0}><Lines lines={t.reads} /></Sub>
      <Sub title="AWP" icon={<Weapon name="AWP" h={11} />} show={t.awp.length > 0}><Lines lines={t.awp} /></Sub>
      <Blocks blocks={[...t.pistol, ...(t.second ? [t.second] : []), ...t.force]} />
    </>
  )
}

function UtilTable({ rows }: { rows: UtilRow[] }) {
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

function PushTable({ rows }: { rows: PushRow[] }) {
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

export function CTSideView({ ct }: { ct: CTSide }) {
  if (!ct.overview.length && !ct.setups.length && !ct.utilSignature.length && !ct.pushes.length && !ct.retakes.length && !ct.pistol.length && !ct.forces.length && !ct.second) return <Empty />
  return (
    <>
      <Sub title="Overview" show={ct.overview.length + ct.setups.length > 0}><Lines lines={[...ct.overview, ...ct.setups]} /></Sub>
      <Sub title="Utility signature" icon={<Weapon name="Smoke Grenade" h={15} />} show={ct.utilSignature.length > 0}><UtilTable rows={ct.utilSignature} /></Sub>
      <Sub title="Spots" icon={<Icon name="layers" size={15} />} show={ct.spots.length > 0}><Lines lines={ct.spots} /></Sub>
      <Sub title="AWP" icon={<Weapon name="AWP" h={11} />} show={ct.awp.length > 0}><Lines lines={ct.awp} /></Sub>
      <Sub title="Early pushes" icon={<Icon name="arrow" size={15} />} show={ct.pushes.length > 0}><PushTable rows={ct.pushes} /></Sub>
      <div className="rp-cols">
        <Sub title="Rotations" icon={<Icon name="shuffle" size={15} />} show={ct.rotations.length > 0}><Lines lines={ct.rotations} /></Sub>
        <Sub title="Retakes" icon={<Weapon name="defuser" h={13} />} show={ct.retakes.length > 0}><Lines lines={ct.retakes} /></Sub>
      </div>
      <Blocks blocks={[...ct.pistol, ...(ct.second ? [ct.second] : []), ...ct.forces]} />
    </>
  )
}

export function GamePlan({ a }: { a: AntiStrat }) {
  const col = (side: 'T' | 'CT', lines: typeof a.gameplan.ourT) => lines.length > 0 && (
    <div className="rp-card">
      <h3><span className={`side-dot ${side}`} />Our {side}</h3>
      <ol className="rp-plan">{lines.map((l, i) => <li key={i}><LineItem l={l} /></li>)}</ol>
    </div>
  )
  return <div className="rp-cols">{col('T', a.gameplan.ourT)}{col('CT', a.gameplan.ourCT)}</div>
}

export function RoundTable({ rows }: { rows: RoundRow[] }) {
  return (
    <table className="rp-table rp-rounds">
      <thead><tr><th>Round</th><th>Side</th><th>Buy them</th><th>Buy us</th><th>Play / setup</th><th>Plant</th><th /></tr></thead>
      <tbody>{rows.map(r => (
        <tr key={`${r.ref.matchId}:${r.ref.round}`}>
          <td><Chips refs={[r.ref]} /></td>
          <td><span className={`side-dot ${r.side}`} />{r.side}</td>
          <td><BuyTag b={r.buyThem} /></td><td><BuyTag b={r.buyUs} /></td>
          <td><Rich text={r.play} /></td>
          <td>{r.plant && <><TokenIcon t="c4" /> {r.plant}</>}</td>
          <td><Icon name={r.won ? 'check' : 'x'} size={14} className={r.won ? 'good-txt' : 'bad-txt'} /></td>
        </tr>
      ))}</tbody>
    </table>
  )
}
