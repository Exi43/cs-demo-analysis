// Tabs neben „At a glance“: Rounds, Players, Opponent anti-strat (gekürzt), Economy
import { useState } from 'react'
import type { EcoRow, PlayerRow, RoundInfo } from '../../../shared/analysis/glance'
import type { AntiStrat, Line, Tag } from '../../../shared/analysis/types'
import { Icon } from '../../icons'
import { Weapon } from '../../weapons'
import { WIN } from '../RoundStrip'
import { HeatmapGrid, PlayCard, PushTable, UtilTable } from './sections'
import { Blocks, BuyTag, Chips, Lines, Rich, Sub, TagBadge, TokenIcon } from './ui'

export function RoundsTab({ rows, names }: { rows: RoundInfo[]; names: Record<string, string> }) {
  const N = (id?: string) => (id && names[id]) || '?'
  return (
    <table className="rp-table rp-rounds">
      <thead><tr><th>Round</th><th>Score</th><th>Side</th><th>Buy us · them</th><th>Opening duel</th><th>Won by</th><th>Plant</th></tr></thead>
      <tbody>{rows.map(r => {
        const w = WIN[r.win]
        return (
          <tr key={`${r.ref.matchId}:${r.ref.round}`} className={r.won ? 'won' : 'lost'}>
            <td><Chips refs={[r.ref]} /></td>
            <td className="rp-num"><b className={r.won ? 'good-txt' : 'bad-txt'}>{r.us}</b> : {r.them}</td>
            <td><span className={`side-dot ${r.side}`} />{r.side}</td>
            <td><BuyTag b={r.buyUs} /> <span className="muted">vs</span> <BuyTag b={r.buyThem} /></td>
            <td>{r.opening && <span className={r.opening.ours ? 'good-txt' : 'bad-txt'} title={r.opening.ours ? 'We won the first duel' : 'We lost the first duel'}>
              <Icon name={r.opening.ours ? 'check' : 'x'} size={13} /> <span className="rp-duel">{N(r.opening.killer)} <Icon name="arrow" size={11} /> {N(r.opening.victim)}</span></span>}</td>
            <td><span className={`rp-win ${r.won ? 'good-txt' : 'bad-txt'}`}><Icon name={w[0]} size={13} /> {r.won ? 'Us' : 'Them'} · {w[1]}</span></td>
            <td>{r.plant && <><TokenIcon t="c4" /> {r.plant}</>}</td>
          </tr>
        )
      })}</tbody>
    </table>
  )
}

const ratingClass = (r: number) => (r >= 1.15 ? 'good' : r < 0.85 ? 'bad' : '')
export function PlayersTab({ rows, player, onPlayer }: { rows: PlayerRow[]; player?: string; onPlayer: (id: string) => void }) {
  return (
    <>
      <p className="muted small">Click a name to see the glance cards for that player.</p>
      <table className="rp-table rp-players">
        <thead><tr>
          <th>Player</th><th title="Our rebuild of the FACEIT rating">Rating</th><th title="Opening duels won–lost">Opening W–L</th><th title="Deaths the team did not trade within 5 s">Untraded deaths</th>
          <th title="Rounds with a kill, assist, survival or traded death">KAST</th><th>ADR</th><th>Flash assists</th><th title="Clutches won / played (last player alive)">Clutches</th>
        </tr></thead>
        <tbody>{rows.map(p => (
          <tr key={p.steamid} className={player === p.steamid ? 'on' : ''}>
            <td><button className="ghost rp-pname" onClick={() => onPlayer(p.steamid)} title="Show the cards for this player">{p.name}</button></td>
            <td><span className={`rating ${ratingClass(p.rating)}`}>{p.rating.toFixed(2)}</span></td>
            <td className={`rp-num ${p.openW > p.openL ? 'good-txt' : p.openW < p.openL ? 'bad-txt' : ''}`}>{p.openW}–{p.openL}</td>
            <td className="rp-num">{p.untraded}</td>
            <td className="rp-num">{Math.round(p.kast)} %</td>
            <td className="rp-num">{Math.round(p.adr)}</td>
            <td className="rp-num">{p.flashAssists}</td>
            <td className="rp-num">{p.clutchW}/{p.clutchN}</td>
          </tr>
        ))}</tbody>
      </table>
    </>
  )
}

const Bar = ({ won, total }: { won: number; total: number }) => total ? (
  <span className="rp-bar" title={`${won} of ${total} won`}><i style={{ width: `${(100 * won) / total}%` }} /><b>{won}/{total} · {Math.round((100 * won) / total)} %</b></span>
) : <span className="muted">–</span>
export function EconomyTab({ rows, us, them }: { rows: EcoRow[]; us: string; them: string }) {
  return (
    <table className="rp-table rp-eco">
      <thead><tr><th>Buy</th><th>{us} won</th><th>{them} won</th></tr></thead>
      <tbody>{rows.map(e => <tr key={e.cls}><td><BuyTag b={e.cls} /></td><td><Bar {...e.us} /></td><td><Bar {...e.them} /></td></tr>)}</tbody>
    </table>
  )
}

/** Gekürzter Gegner-Report: Keys, Spielzüge, CT-Spots, AWP, Pushes, Pistols; Heatmap und Util-Signatur eingeklappt; ONCE-Zeilen nur auf Wunsch */
export function OpponentTab({ a }: { a: AntiStrat }) {
  const [once, setOnce] = useState(false)
  const keep = (x: { tag?: Tag }) => once || x.tag?.kind !== 'ONCE'
  const L = (ls: Line[]) => ls.filter(keep)
  const plays = a.t.plays.filter(keep), pushes = a.ct.pushes.filter(p => once || p.refs.length > 1)
  return (
    <>
      <label className="rp-once small muted"><input type="checkbox" checked={once} onChange={e => setOnce(e.target.checked)} /> Show things seen only once</label>

      <h2><Icon name="star" /> &nbsp;Keys</h2>
      <div className="rp-keys">{a.keys.map((k, i) => (
        <div key={i} className="rp-card rp-key">
          <div className="rp-key-t">{k.icon && <TokenIcon t={k.icon} size={16} />} <Rich text={k.text} /></div>
          {k.counter && <div className="rp-counter"><Icon name="arrow" size={13} /> <Rich text={k.counter} /></div>}
          <div className="rp-key-f">{k.tag && <TagBadge tag={k.tag} />} <Chips refs={k.refs} /></div>
        </div>
      ))}</div>

      <h2><span className="side-dot T" /> Their T side · {a.sides.T.won}/{a.sides.T.total}</h2>
      <Sub title="Plays" icon={<Icon name="target" size={15} />} show={plays.length > 0}><div className="rp-plays">{plays.map(p => <PlayCard key={p.id} p={p} />)}</div></Sub>
      <Sub title="AWP" icon={<Weapon name="AWP" h={11} />} show={L(a.t.awp).length > 0}><Lines lines={L(a.t.awp)} /></Sub>
      <Blocks blocks={a.t.pistol} />
      {a.t.heatmap.rows.length > 0 && <details className="rp-fold"><summary><Icon name="clock" size={15} /> Timing heatmap</summary><HeatmapGrid h={a.t.heatmap} /></details>}

      <h2><span className="side-dot CT" /> Their CT side · {a.sides.CT.won}/{a.sides.CT.total}</h2>
      <Sub title="Spots" icon={<Icon name="layers" size={15} />} show={L(a.ct.spots).length > 0}><Lines lines={L(a.ct.spots)} /></Sub>
      <Sub title="AWP" icon={<Weapon name="AWP" h={11} />} show={L(a.ct.awp).length > 0}><Lines lines={L(a.ct.awp)} /></Sub>
      <Sub title="Early pushes" icon={<Icon name="arrow" size={15} />} show={pushes.length > 0}><PushTable rows={pushes} /></Sub>
      <Blocks blocks={a.ct.pistol} />
      {a.ct.utilSignature.length > 0 && <details className="rp-fold"><summary><TokenIcon t="smoke" size={15} /> Utility signature</summary><UtilTable rows={a.ct.utilSignature.filter(keep)} /></details>}

      {a.limits.length > 0 && (
        <footer className="rp-limits small muted">
          {a.limits.map((l, i) => <p key={i}><Rich text={l} /></p>)}
          <p>Rule-based analysis, no AI. Click a round chip to watch it in the replay.</p>
        </footer>
      )}
    </>
  )
}
