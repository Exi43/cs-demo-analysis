// Team-Lineups: Raster je Map (virtuell), eigene Lineups aus dem Utility-Dashboard ins Team teilen, Detailseite mit 3D-Vorschau,
// Lern-Status und den Strats, in denen das Lineup vorkommt
import { useEffect, useState } from 'react'
import type { Lineup, NadeType } from '../../shared/utility'
import { BUILTIN_TECHNIQUES } from '../../shared/utility-lib'
import { api } from '../api'
import { Icon } from '../icons'
import { MiniRadar, Modal, SideBadge, TypeIcon, VirtualRows } from '../utility/ui'
import { TYPES, mapName, typeOf } from '../utility/maps'
import { team } from '.'
import { ago, inBook, progressOf } from './logic'
import { StratRow } from './Stratbook'
import { LearnDot, LearnSeg, MapStrip, TI, errText, useTeam } from './tui'

const tech = (ids: string[]) => ids.map(id => BUILTIN_TECHNIQUES.find(t => t.id === id)?.label ?? id).join(' + ')
const live = (ls: Lineup[]) => ls.filter(l => !l.deleted)

export function LineupsPage() {
  const { s, route, go, map: last, setMap } = useTeam()
  const map = (route.page === 'lineups' && route.map) || last
  const [type, setType] = useState<NadeType>()
  const [q, setQ] = useState('')
  const [share, setShare] = useState(false)
  const all = live(s.lineups)
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = all.filter(l => l.map === map && (!type || l.type === type) && words.every(w => `${l.title} ${l.description ?? ''} ${l.author ?? ''}`.toLowerCase().includes(w)))
    .sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title))
  return (
    <div className="tm-page tm-book">
      <MapStrip value={map} onPick={m => { setMap(m); go({ page: 'lineups', map: m }) }} count={m => all.filter(l => l.map === m).length} />
      <div className="tm-book-bar">
        <h1 className="ut-mapname">{mapName(map)}</h1>
        <div className="ut-chips">
          <button className={`ut-chip ${!type ? 'on' : ''}`} onClick={() => setType(undefined)}>All</button>
          {TYPES.filter(t => all.some(l => l.map === map && l.type === t.id)).map(t => (
            <button key={t.id} className={`ut-chip ${type === t.id ? 'on' : ''}`} onClick={() => setType(type === t.id ? undefined : t.id)}><TypeIcon type={t.id} size={18} />{t.plural}</button>
          ))}
        </div>
        <input className="ut-search tm-book-search" placeholder="Search lineups" value={q} onChange={e => setQ(e.target.value)} />
        <div className="tm-book-actions"><button className="ut-btn primary" onClick={() => setShare(true)}><TI name="plus" size={15} /> Add from my library</button></div>
      </div>
      <VirtualRows items={list} minColW={250} rowH={w => (w * 9) / 16 + 96} className="tm-book-list" render={l => <LineupTile key={l.id} l={l} />}
        empty={<div className="ut-empty"><b>No team lineups for {mapName(map)} yet.</b> Share your own lineups from the Utility page with “Add from my library”.</div>} />
      {share && <ShareDialog map={map} onClose={() => setShare(false)} />}
    </div>
  )
}

function LineupTile({ l }: { l: Lineup }) {
  const { s, maps, go, preview } = useTeam()
  return (
    <article className="ut-card" onClick={() => go({ page: 'lineup', id: l.id })}>
      <div className="ut-card-head"><TypeIcon type={l.type} size={24} /><b title={l.title}>{l.title || 'Untitled'}</b><LearnDot status={progressOf(s.progress, s.me?.id, { lineup: l.id })} /></div>
      <div className="ut-card-media">
        <MiniRadar l={l} meta={maps.meta[l.map]} />
        <button className="ut-card-3d" onClick={e => { e.stopPropagation(); preview(l) }} title="Preview in 3D"><Icon name="cube" size={15} /> Preview in 3D</button>
      </div>
      <div className="ut-card-foot"><SideBadge side={l.side} /><span className="ut-card-tech">{tech(l.technique)}</span><span className="muted small">{l.author}</span></div>
    </article>
  )
}

/** eigene (lokale) Lineups dieser Map auswählen und ins Team kopieren */
function ShareDialog({ map, onClose }: { map: string; onClose: () => void }) {
  const { s, run } = useTeam()
  const [mine, setMine] = useState<Lineup[]>()
  const [err, setErr] = useState<string>()
  const [sel, setSel] = useState<string[]>([])
  useEffect(() => { api.utilityLoad().then(r => setMine(live(r.lib.lineups).filter(l => l.map === map)), e => setErr(errText(e))) }, [map])
  const shared = (l: Lineup) => s.lineups.some(t => !t.deleted && t.map === l.map && t.type === l.type && Math.hypot(t.stand.x - l.stand.x, t.stand.y - l.stand.y) < 32 && Math.hypot(t.target.x - l.target.x, t.target.y - l.target.y) < 32)
  return (
    <Modal title={`Share lineups: ${mapName(map)}`} onClose={onClose}
      foot={<><span className="muted small">Copies go to the team. Your own lineups stay as they are.</span>
        <button className="ut-btn primary" disabled={!sel.length} onClick={() => run(team.shareLineups(mine!.filter(l => sel.includes(l.id))), `${sel.length} lineup${sel.length > 1 ? 's' : ''} shared`).then(ok => ok && onClose())}>Share {sel.length || ''}</button></>}>
      {err && <div className="ut-empty small">Your library could not be loaded: {err}</div>}
      {!mine && !err && <div className="muted">Loading your lineups…</div>}
      {mine && !mine.length && <div className="ut-empty small">You have no lineups for {mapName(map)} on this PC. Add them on the Utility page first.</div>}
      <div className="tm-share-list">
        {mine?.map(l => (
          <label key={l.id} className="ut-row">
            <input type="checkbox" checked={sel.includes(l.id)} onChange={e => setSel(e.target.checked ? [...sel, l.id] : sel.filter(x => x !== l.id))} />
            <TypeIcon type={l.type} size={24} />
            <span className="ut-row-main"><b>{l.title}</b><span className="ut-row-sub"><SideBadge side={l.side} /> {tech(l.technique)}</span></span>
            {shared(l) && <span className="tm-pill approved" title="A team lineup with the same spot exists">In team</span>}
          </label>
        ))}
      </div>
    </Modal>
  )
}

export function LineupPage({ id }: { id: string }) {
  const { s, maps, go, preview, notify } = useTeam()
  const l = s.lineups.find(x => x.id === id)
  if (!l || l.deleted) return <div className="ut-empty pad">This lineup was removed. <button className="ut-link" onClick={() => go({ page: 'lineups' })}>Back</button></div>
  const used = s.strats.filter(st => inBook(st) && st.slots.some(sl => sl.lineupIds.includes(l.id)))
  return (
    <div className="ut-detail">
      <div className="ut-detail-head">
        <button className="ut-icon-btn big" onClick={() => go({ page: 'lineups', map: l.map })} title="Back"><Icon name="arrow" className="flip" /></button>
        <TypeIcon type={l.type} size={34} />
        <h1><span>{mapName(l.map)} {typeOf(l.type).label}:</span> {l.title || 'Untitled'}{l.description && <small className="ut-desc">{l.description}</small>}</h1>
      </div>
      <div className="ut-detail-body">
        <div className="ut-detail-main">
          <div className="ut-media"><MiniRadar l={l} meta={maps.meta[l.map]} /></div>
          {l.steps.length > 0 && (
            <section className="ut-steps"><h3>How to throw</h3><ol>{l.steps.map((x, i) => <li key={i}><span>{i + 1}</span><p>{x}</p></li>)}</ol></section>
          )}
          <section className="ut-section">
            <h3>Used in strats</h3>
            {used.length ? <div className="tm-used">{used.map(st => <StratRow key={st.id} st={st} />)}</div> : <div className="ut-empty small">Not part of a strat yet. Add it to a player in a strat.</div>}
          </section>
        </div>
        <aside className="ut-detail-side">
          <button className="ut-btn primary big ut-3d" onClick={() => preview(l)}><Icon name="cube" size={22} /> Preview in 3D</button>
          <div className="tm-card"><b>Your status</b><LearnSeg refTo={{ lineup: l.id }} /></div>
          <div className="ut-info">
            <div><label>Side</label><SideBadge side={l.side} /></div>
            <div><label>Technique</label><b>{tech(l.technique) || '–'}</b></div>
            <div><label>Grenade</label><b>{typeOf(l.type).label}</b></div>
            {l.author && <div><label>Shared by</label><b>{l.author}</b></div>}
            <div><label>Updated</label><b>{ago(l.updatedAt)}</b></div>
          </div>
          {l.video?.url && <button className="ut-linkcard" onClick={() => api.utilityOpen({ url: l.video!.url }).catch(e => notify(errText(e), true))}><span className="ut-linkcard-ico"><Icon name="replay" size={18} /></span><span><b>Video</b><small>Opens in your browser</small></span></button>}
        </aside>
      </div>
    </div>
  )
}
