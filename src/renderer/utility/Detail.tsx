// Utility-Dashboard Detailseite: großes Bild (oder Radar-Ausschnitt), Schritte, rechts „Preview in 3D“, Infos, Radar, Video/Quelle,
// Aktionen (Favorit, Bearbeiten, Duplizieren, Löschen mit Rückfrage), ähnliche Lineups.
import { useState } from 'react'
import { api } from '../api'
import { Icon } from '../icons'
import { LineupCard, Star, TeamTag } from './cards'
import { imageUrl, mapName, typeOf } from './maps'
import { deleteLineup, duplicateLineup, patchLineup, playbookItems, savePlaybook, uid } from './ops'
import { TeamClip } from './TeamClip'
import { MiniRadar, SideBadge, TypeIcon, live, techLabel, useUtil, type Route } from './ui'

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }

export function Detail({ id, back }: { id: string; back: Route }) {
  const { lib, maps, update, go, route, notify, preview, team, share } = useUtil()
  const [img, setImg] = useState(0)
  const l = lib.lineups.find(x => x.id === id)
  if (!l || l.deleted) return <div className="ut-empty pad">This lineup was deleted. <button className="ut-link" onClick={() => go(back)}>Back</button></div>
  const meta = maps.meta[l.map]
  const tags = lib.tags.filter(t => !t.deleted && l.tags.includes(t.id))
  const books = lib.playbooks.filter(p => !p.deleted && (!p.map || p.map === l.map))
  const similar = live(lib).filter(x => x.id !== l.id && x.map === l.map && x.type === l.type && Math.hypot(x.target.x - l.target.x, x.target.y - l.target.y) < 300).slice(0, 4)
  const open = (u: { url?: string; local?: string }) => api.utilityOpen(u).catch(e => notify(String(e?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), true))
  const cur = l.images[Math.min(img, l.images.length - 1)]
  const canEdit = l.owner === 'local' || team.store.canEdit(l.id) // Team-Lineups: eigene oder Admin

  return (
    <div className="ut-detail">
      <div className="ut-detail-head">
        <button className="ut-icon-btn big" onClick={() => go(back)} title="Back"><Icon name="arrow" className="flip" /></button>
        <TypeIcon type={l.type} size={34} />
        <h1><span>{mapName(l.map)} {typeOf(l.type).label}:</span> {l.title || 'Untitled'} <TeamTag l={l} />{l.description && <small className="ut-desc">{l.description}</small>}</h1>
        <div className="ut-detail-actions">
          <Star l={l} />
          {l.owner === 'local' && team.state.team && <button className="ut-btn" onClick={() => share([l.id])} title={`Copy this lineup to ${team.state.team.name}`}><Icon name="multi" size={15} /> Share to team</button>}
          {canEdit && <button className="ut-btn" onClick={() => go({ page: 'edit', draft: l, isNew: false, back: route })}><Icon name="clipboard" size={15} /> Edit</button>}
          <button className="ut-btn" onClick={() => { const r = duplicateLineup(lib, l.id); update(() => r.lib); notify('Duplicated: you are editing the copy'); go({ page: 'edit', draft: r.lib.lineups.find(x => x.id === r.id)!, isNew: false, back: { page: 'lineup', id: r.id, back } }) }}><Icon name="layers" size={15} /> Duplicate</button>
          {canEdit && <button className="ut-btn danger" onClick={() => {
            if (!confirm(`Delete “${l.title}”${team.state.clips[l.id] ? ' and its team clip' : ''}?`)) return
            update(x => deleteLineup(x, l.id)); go(back)
            notify('Lineup deleted', false, () => update(x => patchLineup(x, l.id, { deleted: false })))
          }}><Icon name="x" size={15} /> Delete</button>}
        </div>
      </div>

      <div className="ut-detail-body">
        <div className="ut-detail-main">
          <div className="ut-media">
            {cur ? <img src={imageUrl(cur)} alt="" decoding="async" /> : <MiniRadar l={l} meta={meta} />}
            {!cur && canEdit && <span className="ut-media-note">No images yet. <button className="ut-link" onClick={() => go({ page: 'edit', draft: l, isNew: false, step: 5, back: route })}>Add images</button></span>}
          </div>
          {l.images.length > 1 && (
            <div className="ut-thumbs">
              {l.images.map((h, i) => <button key={h} className={i === img ? 'on' : ''} onClick={() => setImg(i)}><img src={imageUrl(h)} alt="" loading="lazy" decoding="async" /></button>)}
            </div>
          )}
          {l.steps.length > 0 && (
            <section className="ut-steps">
              <h3>How to throw</h3>
              <ol>{l.steps.map((s, i) => <li key={i}><span>{i + 1}</span><p>{s}</p></li>)}</ol>
            </section>
          )}
          {similar.length > 0 && (
            <section className="ut-section">
              <h3>Similar lineups</h3>
              <div className="ut-grid">{similar.map(x => <LineupCard key={x.id} l={x} onOpen={() => go({ page: 'lineup', id: x.id, back })} />)}</div>
            </section>
          )}
        </div>

        <aside className="ut-detail-side">
          <button className="ut-btn primary big ut-3d" onClick={() => preview(l)}><Icon name="cube" size={22} /> Preview in 3D</button>
          <div className="ut-info">
            <div><label>Side</label><SideBadge side={l.side} /></div>
            <div><label>Technique</label><b>{l.technique.map(t => techLabel(lib, t)).join(' + ') || '–'}</b></div>
            <div><label>Grenade</label><b>{typeOf(l.type).label}</b></div>
            {l.aim && <div><label>Aim</label><b>pitch {l.aim.pitch.toFixed(1)}°, yaw {l.aim.yaw.toFixed(1)}°</b></div>}
            {Object.entries(l.fields ?? {}).map(([k, v]) => <div key={k}><label>{k}</label><b>{v}</b></div>)}
            {tags.length > 0 && <div><label>Tags</label><span className="ut-chips">{tags.map(t => <span key={t.id} className="ut-tag" style={{ '--c': t.color } as React.CSSProperties}>{t.name}</span>)}</span></div>}
            {l.demo && <div><label>From demo</label><b>{l.demo.player ?? l.demo.steamid}{l.demo.round ? `, round ${l.demo.round}` : ''}</b></div>}
            {l.author && <div><label>Author</label><b>{l.author}</b></div>}
          </div>
          <TeamClip l={l} />
          <div className="ut-detail-radar"><MiniRadar l={l} meta={meta} aspect={1} /></div>
          {l.video?.url && <button className="ut-linkcard" onClick={() => open({ url: l.video!.url })}><span className="ut-linkcard-ico"><Icon name="replay" size={18} /></span><span><b>Video</b><small>{host(l.video.url)} · opens in your browser</small></span></button>}
          {l.video?.local && <button className="ut-linkcard" onClick={() => open({ local: l.video!.local })}><span className="ut-linkcard-ico"><Icon name="replay" size={18} /></span><span><b>Local video</b><small>Only on this PC · opens in your video player</small></span></button>}
          {l.sourceUrl && <button className="ut-linkcard" onClick={() => open({ url: l.sourceUrl })}><span className="ut-linkcard-ico"><Icon name="arrow" size={18} /></span><span><b>Source</b><small>{host(l.sourceUrl)}</small></span></button>}
          <select className="ut-select" value="" onChange={e => {
            const v = e.target.value
            if (v === 'new') { const pid = uid(); update(x => savePlaybook(x, { id: pid, name: `${mapName(l.map)} playbook`, map: l.map, lineupIds: [l.id] })); go({ page: 'map', map: l.map, playbook: pid }) }
            else if (v) { update(x => playbookItems(x, v, ids => (ids.includes(l.id) ? ids : [...ids, l.id]))); notify(`Added to ${books.find(p => p.id === v)?.name}`) }
          }}>
            <option value="">Add to playbook…</option>
            {books.map(p => <option key={p.id} value={p.id} disabled={p.lineupIds.includes(l.id)}>{p.name}{p.lineupIds.includes(l.id) ? ' (already in)' : ''}</option>)}
            <option value="new">New playbook</option>
          </select>
        </aside>
      </div>
    </div>
  )
}
