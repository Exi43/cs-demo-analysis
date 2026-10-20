import { Fragment, useMemo, useState, type ReactNode } from 'react'
import type { MatchData } from '../../shared/model'
import { analyzeTeam, roundClock, type Entry, type TipKind, type WL } from '../../shared/analysis/report'
import type { Ref } from '../../shared/analysis/rounds'
import { Icon } from '../icons'
import { Weapon } from '../weapons'

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

const bold = (text: string) => text.split(/\*\*(.+?)\*\*/g).map((p, i) => (i % 2 ? <b key={i}>{p}</b> : <Fragment key={i}>{p}</Fragment>))
const pct = (w: number, t: number) => (t ? Math.round((100 * w) / t) : 0)

const TIP_ICON: Record<TipKind, ReactNode> = {
  site: <Icon name="target" />, rush: <Icon name="bolt" />, slow: <Icon name="clock" />, pistol: <Weapon name="USP-S" h={14} />,
  push: <Icon name="arrow" />, stack: <Icon name="layers" />, retake: <Weapon name="c4" h={16} />, awp: <Weapon name="AWP" h={12} />,
  star: <Icon name="star" />, force: <Weapon name="MAC-10" h={14} />,
}
const ROLE_ICON: Record<string, string> = { awp: 'AWP', entry: 'AK-47', lurk: 'Shadow Daggers', anchor: 'defuser', mid: 'M4A1-S', support: 'Smoke Grenade' }
const NADE_ICON: Record<string, string> = { smoke: 'Smoke Grenade', flash: 'Flashbang', molotov: 'Molotov', he: 'High Explosive Grenade' }

function Bar({ won, total, color = 'var(--good)' }: { won: number; total: number; color?: string }) {
  return <div className="wlbar"><div style={{ width: `${pct(won, total)}%`, background: color }} /></div>
}

function Tile({ label, wl, icon }: { label: string; wl: WL; icon?: ReactNode }) {
  const p = pct(wl.won, wl.total)
  return (
    <div className={`tile ${p >= 50 ? 'good' : 'bad'}`}>
      <div className="tile-top">{icon}<span>{label}</span></div>
      <div className="tile-num">{wl.won}<span>/{wl.total}</span></div>
      <Bar won={wl.won} total={wl.total} color={p >= 50 ? 'var(--good)' : 'var(--bad)'} />
    </div>
  )
}

function RoundChip({ label, won, onClick, title }: { label: string; won: boolean; onClick: () => void; title?: string }) {
  return <button className={`rchip ${won ? 'w' : 'l'}`} onClick={onClick} title={title}><Icon name={won ? 'check' : 'x'} size={12} /> {label}</button>
}

export function ReportView({ matches, onRef }: { matches: MatchData[]; onRef: (r: Ref) => void }) {
  const base = matches[0]
  const [team, setTeam] = useState(base.teams[1])
  const { entries, skipped } = useMemo(() => entriesFor(matches, base, team), [matches, team])
  const rep = useMemo(() => (entries.length ? analyzeTeam(entries) : undefined), [entries])
  const tag = (r: Ref) => `${matches.length > 1 ? `D${matches.findIndex(m => m.id === r.matchId) + 1} ` : ''}R${r.round}`

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
      {rep && (
        <>
          <div className="tiles">
            {rep.results.map((r, i) => (
              <div key={i} className={`tile ${r.us > r.them ? 'good' : 'bad'}`}>
                <div className="tile-top"><span>vs {r.opponent}</span></div>
                <div className="tile-num">{r.us}<span> : {r.them}</span></div>
              </div>
            ))}
            <Tile label="T side" wl={rep.sides.T} icon={<span className="side-dot T" />} />
            <Tile label="CT side" wl={rep.sides.CT} icon={<span className="side-dot CT" />} />
            {rep.buys.pistol && <Tile label="Pistol" wl={rep.buys.pistol} icon={<Weapon name="Glock-18" h={13} />} />}
            {rep.buys.eco && <Tile label="Eco" wl={rep.buys.eco} icon={<Weapon name="P250" h={13} />} />}
            {rep.buys.force && <Tile label="Force" wl={rep.buys.force} icon={<Weapon name="MAC-10" h={13} />} />}
            {rep.buys.full && <Tile label="Full buy" wl={rep.buys.full} icon={<Weapon name="AK-47" h={13} />} />}
          </div>

          {(rep.pistols.t.length > 0 || rep.pistols.ct.length > 0) && (
            <>
              <h2><Weapon name="USP-S" h={16} />&nbsp; Pistol rounds</h2>
              <div className="groups">
                {rep.pistols.t.map(r => (
                  <div key={tag(r.ref)} className="group pistol">
                    <div className="g-head">
                      <b><span className="side-dot T" />T pistol · {tag(r.ref)}</b>
                      <span className={r.won ? 'good-txt' : 'bad-txt'}>{r.won ? 'won' : 'lost'} <button className="ghost play-ref" onClick={() => onRef(r.ref)}><Icon name="replay" size={14} /></button></span>
                    </div>
                    <div className="pistol-plan">{r.plan}{r.hitSec !== undefined && <span className="muted"> at {roundClock(r.hitSec)}</span>}</div>
                    <div className="badges">
                      <span className="badge">Start:</span>
                      {r.start.A > 0 && <span className="badge">{r.start.A} A side</span>}
                      {r.start.Mid > 0 && <span className="badge">{r.start.Mid} mid</span>}
                      {r.start.B > 0 && <span className="badge">{r.start.B} B side</span>}
                    </div>
                    {r.rotators.length > 0 && <div className="badges">{r.rotators.map(s => <span key={s} className="badge"><Icon name="shuffle" size={13} /> {rep.names[s]} rotates to {r.site}</span>)}</div>}
                    {r.lurkers.length > 0 && <div className="badges">{r.lurkers.map(s => <span key={s} className="badge"><Weapon name="Shadow Daggers" h={11} /> {rep.names[s]} lurks</span>)}</div>}
                    {r.utility.length > 0 && <div className="util">{r.utility.filter(u => r.hitSec === undefined || u.sec <= r.hitSec + 3).map((u, i) => (
                      <span key={i} className="util-chip"><Weapon name={NADE_ICON[u.type]} h={14} /> {u.place} <i>{rep.names[u.thrower]}</i></span>
                    ))}</div>}
                    {r.opening && <div className="badges"><span className={`badge ${r.opening.forUs ? 'good' : 'bad'}`}><Icon name="target" size={13} /> opening {r.opening.forUs ? 'kill' : 'death'} at {r.opening.place} ({Math.round(r.opening.sec)} s)</span></div>}
                  </div>
                ))}
                {rep.pistols.ct.map(r => (
                  <div key={tag(r.ref)} className="group pistol">
                    <div className="g-head">
                      <b><span className="side-dot CT" />CT pistol · {tag(r.ref)}</b>
                      <span className={r.won ? 'good-txt' : 'bad-txt'}>{r.won ? 'won' : 'lost'} <button className="ghost play-ref" onClick={() => onRef(r.ref)}><Icon name="replay" size={14} /></button></span>
                    </div>
                    <div className="setups">
                      <span className="setup"><span className="st A">A<b>{r.zones.A}</b></span><span className="st M">Mid<b>{r.zones.Mid}</b></span><span className="st B">B<b>{r.zones.B}</b></span></span>
                      {r.stack && <span className="badge"><Icon name="layers" size={13} /> stack {r.stack}</span>}
                    </div>
                    <div className="ct-pos">{Object.entries(r.positions).map(([s, pl]) => (
                      <div key={s}><span>{rep.names[s]}</span><b>{pl}</b></div>
                    ))}</div>
                    {r.aggressive.length > 0 && <div className="badges">{r.aggressive.map(a => <span key={a.steamid} className="badge bad"><Icon name="arrow" size={13} /> {rep.names[a.steamid]} pushes {a.place} ({a.sec} s)</span>)}</div>}
                    {r.utility.length > 0 && <div className="util">{r.utility.map((u, i) => (
                      <span key={i} className="util-chip"><Weapon name={NADE_ICON[u.type]} h={14} /> {u.place} <i>{rep.names[u.thrower]}</i></span>
                    ))}</div>}
                    <div className="badges">
                      {r.opening && <span className={`badge ${r.opening.forUs ? 'good' : 'bad'}`}><Icon name="target" size={13} /> opening {r.opening.forUs ? 'kill' : 'death'} at {r.opening.place} ({Math.round(r.opening.sec)} s)</span>}
                      {r.retake && <span className={`badge ${r.retake === 'won' ? 'good' : 'bad'}`}><Weapon name="defuser" h={12} /> retake {r.retake}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <h2>How to beat them</h2>
          <div className="tips">
            {rep.tips.map((t, i) => (
              <div key={i} className="tip">
                <div className="tip-ico">{TIP_ICON[t.kind]}</div>
                <div className="tip-txt">{bold(t.text)}</div>
                {t.refs.length > 0 && <button className="ghost play-ref" title="Watch in replay" onClick={() => onRef(t.refs[0])}><Icon name="replay" size={14} /></button>}
              </div>
            ))}
          </div>

          <h2>Players</h2>
          <div className="pcards">
            {rep.players.map(p => (
              <div key={p.steamid} className="pcard">
                <div className="pc-head">
                  <span className="pc-name">{p.name}</span>
                  <span className={`rating ${p.rating >= 1.15 ? 'good' : p.rating < 0.85 ? 'bad' : ''}`}>{p.rating.toFixed(2)}</span>
                </div>
                <div className="pc-stats"><span>{p.kills}–{p.deaths}</span><span>ADR {p.adr.toFixed(0)}</span><span>KAST {p.kast.toFixed(0)}%</span></div>
                <div className="roles">{p.roles.map(r => <span key={r.kind} className="role"><Weapon name={ROLE_ICON[r.kind]} h={12} /> {r.label}</span>)}</div>
                <div className="pos"><span className="side-dot CT" />{p.ctPos.map(([pl, v]) => <span key={pl} className="pos-chip">{pl} <i>{v}%</i></span>)}</div>
                <div className="pos"><span className="side-dot T" />{p.tPos.map(([pl, v]) => <span key={pl} className="pos-chip">{pl} <i>{v}%</i></span>)}</div>
              </div>
            ))}
          </div>

          <h2><span className="side-dot T" /> T side</h2>
          <div className="groups">
            {rep.tGroups.map(g => (
              <div key={g.key} className="group">
                <div className="g-head"><b>{g.label}</b><span className="muted">{g.won}/{g.total} won</span></div>
                <div className="sites">
                  <div className="site-split">
                    <div className="sA" style={{ flex: Math.max(g.a.total, 0.001) }}>A {g.a.total > 0 && <i>{g.a.won}/{g.a.total}</i>}</div>
                    <div className="sB" style={{ flex: Math.max(g.b.total, 0.001) }}>B {g.b.total > 0 && <i>{g.b.won}/{g.b.total}</i>}</div>
                  </div>
                </div>
                <div className="badges">
                  {g.medianHit !== undefined && <span className="badge"><Icon name="clock" size={13} /> hit {roundClock(g.medianHit)}</span>}
                  {g.rushes > 0 && <span className="badge"><Icon name="bolt" size={13} /> {g.rushes} rush</span>}
                  {g.defaults > 0 && <span className="badge"><Icon name="shuffle" size={13} /> {g.defaults} default</span>}
                  {g.lurkers.slice(0, 2).map(l => <span key={l.name} className="badge"><Weapon name="Shadow Daggers" h={11} /> {l.name} ×{l.n}</span>)}
                </div>
                {g.utility.length > 0 && (
                  <div className="util">{g.utility.map((u, i) => <span key={i} className="util-chip"><Weapon name={NADE_ICON[u.type]} h={14} /> {u.place} <i>×{u.n}</i></span>)}</div>
                )}
                <div className="rchips">{g.rounds.map(r => (
                  <RoundChip key={tag(r.ref)} won={r.won} onClick={() => onRef(r.ref)}
                    label={`${tag(r.ref)} ${r.plan}`} title={`${r.hitSec !== undefined ? `Hit at ${roundClock(r.hitSec)}` : ''}${r.opening ? ` · Opening: ${r.opening.forUs ? 'kill' : 'death'} ${r.opening.place}` : ''}`} />
                ))}</div>
              </div>
            ))}
          </div>

          <h2><span className="side-dot CT" /> CT side</h2>
          <div className="groups">
            {rep.ctGroups.map(g => (
              <div key={g.key} className="group">
                <div className="g-head"><b>{g.label}</b><span className="muted">{g.won}/{g.total} won</span></div>
                <div className="setups">{g.setups.map(s => {
                  const [a, m, b] = s.setup.match(/\d+/g)!.map(Number)
                  return (
                    <button key={s.setup} className="setup" onClick={() => onRef(s.refs[0])} title="A – Mid – B after 15 s">
                      <span className="st A">A<b>{a}</b></span><span className="st M">Mid<b>{m}</b></span><span className="st B">B<b>{b}</b></span><i>×{s.n}</i>
                    </button>
                  )
                })}</div>
                <div className="badges">
                  {g.stacks.map(s => <span key={s.site} className="badge"><Icon name="layers" size={13} /> stack {s.site} ×{s.n}</span>)}
                  {g.retakes && <span className={`badge ${pct(g.retakes.won, g.retakes.total) >= 50 ? 'good' : 'bad'}`}><Weapon name="defuser" h={12} /> retakes {g.retakes.won}/{g.retakes.total}</span>}
                </div>
                {g.pushes.length > 0 && <div className="util">{g.pushes.map(p => (
                  <button key={p.name + p.place} className="util-chip" onClick={() => onRef(p.refs[0])}><Icon name="arrow" size={13} /> {p.name} → {p.place} <i>×{p.n}</i></button>
                ))}</div>}
                <div className="rchips">{g.rounds.map(r => <RoundChip key={tag(r.ref)} won={r.won} onClick={() => onRef(r.ref)} label={`${tag(r.ref)} ${r.setup}`} />)}</div>
              </div>
            ))}
          </div>

          <h2>Opening duels</h2>
          <div className="groups">
            {rep.openings.map(o => (
              <div key={o.side} className="group">
                <div className="g-head"><b><span className={`side-dot ${o.side}`} /> {o.side}</b><span className="muted">{o.won}/{o.total} won</span></div>
                <Bar won={o.won} total={o.total} color={pct(o.won, o.total) >= 50 ? 'var(--good)' : 'var(--bad)'} />
                <div className="badges">
                  <span className="badge">after opening kill: {o.wonAfter}/{o.won} rounds</span>
                  <span className="badge">after opening death: {o.lostAfter}/{o.total - o.won}</span>
                </div>
                <div className="util">{o.places.map(([pl, n]) => <span key={pl} className="util-chip"><Icon name="target" size={13} /> {pl} <i>×{n}</i></span>)}</div>
              </div>
            ))}
          </div>
          <p className="muted small">Rule-based analysis, no AI. Click any round to check it in the replay.</p>
        </>
      )}
    </div>
  )
}
