// Utility-Dashboard Startseite: Map-Kacheln (Pool groß, alle anderen Radare klein), Zahlen je Granatentyp, Favoriten, Zuletzt hinzugefügt,
// rechts Hinzufügen, Playbooks und Tags. Voll nutzbar ohne Demos.
import { useState } from 'react'
import { Icon } from '../icons'
import { LineupCard } from './cards'
import { POOL, TYPES, mapColor, mapName, radarUrl } from './maps'
import { newDraft } from './ops'
import { TagManager } from './tags'
import { TypeIcon, live, useUtil } from './ui'

export function Home() {
  const { lib, maps, go, route } = useUtil()
  const [tagsOpen, setTagsOpen] = useState(false)
  const all = live(lib)
  const count = (m: string) => all.filter(l => l.map === m).length
  const pool = POOL.filter(m => maps.meta[m] && maps.radars.includes(m))
  const others = maps.radars.filter(r => !r.endsWith('_lower') && !POOL.includes(r) && maps.meta[r]).sort((a, b) => mapName(a).localeCompare(mapName(b)))
  const favs = all.filter(l => l.favorite).slice(0, 8)
  const recent = [...all].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8)
  const books = lib.playbooks.filter(p => !p.deleted)
  const add = () => go({ page: 'edit', draft: newDraft(), isNew: true, step: 1, back: route })
  const open = (id: string) => go({ page: 'lineup', id, back: route })

  return (
    <div className="ut-home">
      <div className="ut-home-main">
        <div className="ut-tiles">
          {pool.map(m => (
            <button key={m} className="ut-tile" style={{ '--m': mapColor(m) } as React.CSSProperties} onClick={() => go({ page: 'map', map: m })}>
              <img src={radarUrl(m)} alt="" decoding="async" />
              <span className="ut-tile-name">{mapName(m)}</span>
              <span className="ut-tile-n">{count(m)} lineup{count(m) === 1 ? '' : 's'}</span>
              <span className="ut-tile-types">
                {TYPES.map(t => { const n = all.filter(l => l.map === m && l.type === t.id).length; return n ? <i key={t.id} className={t.id} title={`${n} ${t.plural}`}>{n}</i> : null })}
              </span>
            </button>
          ))}
          <button className="ut-tile add" onClick={add}><span className="ut-tile-plus">+</span><span className="ut-tile-name">Add lineup</span><span className="ut-tile-n">Map, type, two clicks</span></button>
        </div>

        {others.length > 0 && (
          <div className="ut-others">
            {others.map(m => (
              <button key={m} style={{ '--m': mapColor(m) } as React.CSSProperties} onClick={() => go({ page: 'map', map: m })}>
                <span className="ut-mapdot"><img src={radarUrl(m)} alt="" loading="lazy" decoding="async" /></span>{mapName(m)}{count(m) > 0 && <small>{count(m)}</small>}
              </button>
            ))}
          </div>
        )}

        <div className="ut-typestats">
          {TYPES.filter(t => t.id !== 'decoy' || all.some(l => l.type === 'decoy')).map(t => (
            <div key={t.id} className="ut-typestat"><TypeIcon type={t.id} size={34} /><b>{all.filter(l => l.type === t.id).length}</b><span>{t.plural}</span></div>
          ))}
        </div>

        {favs.length > 0 && (
          <section className="ut-section">
            <h3><Icon name="star" size={17} /> Favourites</h3>
            <div className="ut-grid">{favs.map(l => <LineupCard key={l.id} l={l} showMap onOpen={() => open(l.id)} />)}</div>
          </section>
        )}
        <section className="ut-section">
          <h3><Icon name="clock" size={17} /> Recently added</h3>
          {recent.length
            ? <div className="ut-grid">{recent.map(l => <LineupCard key={l.id} l={l} showMap onOpen={() => open(l.id)} />)}</div>
            : <div className="ut-empty"><b>No lineups yet.</b> Pick a map above or <button className="ut-link" onClick={add}>add your first lineup</button>. You do not need a demo for this.</div>}
        </section>
      </div>

      <aside className="ut-home-side">
        <p className="ut-welcome">Your own grenade lineups for every map. Add one in a few clicks: <b>map</b>, <b>type</b>, <b>where you stand</b> and <b>where it lands</b>, <b>technique</b>. Images, steps and videos are optional.</p>
        <div className="ut-menu">
          <button className="ut-btn primary big" onClick={add}><span>+</span> Add lineup</button>
        </div>
        <div className="ut-menu">
          <h4><Icon name="multi" size={15} /> Playbooks</h4>
          {books.map(p => {
            const m = p.map ?? lib.lineups.find(l => l.id === p.lineupIds[0])?.map
            return m ? <button key={p.id} className="ut-menu-item" onClick={() => go({ page: 'map', map: m, playbook: p.id })}>{p.name}<small>{mapName(m)} · {p.lineupIds.length}</small></button> : null
          })}
          {!books.length && <div className="muted small">Playbooks are ordered lineup sets, e.g. “A execute Mirage”. Create one on a map page.</div>}
        </div>
        <div className="ut-menu">
          <h4><Icon name="layers" size={15} /> Tags <button className="ut-link small" onClick={() => setTagsOpen(o => !o)}>{tagsOpen ? 'Done' : 'Edit'}</button></h4>
          {tagsOpen ? <TagManager /> : (
            <div className="ut-chips">
              {lib.tags.filter(t => !t.deleted).map(t => <span key={t.id} className="ut-tag" style={{ '--c': t.color } as React.CSSProperties}>{t.name}</span>)}
              {!lib.tags.some(t => !t.deleted) && <span className="muted small">No tags yet.</span>}
            </div>
          )}
        </div>
      </aside>
    </div>
  )
}
