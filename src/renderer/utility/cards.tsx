// Utility-Dashboard: Lineup-Karte (Kartenraster, Startseite), Zeile (Liste, Seitenspalte) und Ziehen zum Umsortieren
import type { Lineup } from '../../shared/utility'
import { Icon } from '../icons'
import { imageUrl, mapName } from './maps'
import { patchLineup } from './ops'
import { MiniRadar, SideBadge, TypeIcon, techLabel, useUtil } from './ui'

/** HTML5-Ziehen: ein Eintrag auf einen anderen fallen lassen → onMove(gezogen, Ziel) */
export function dragProps(id: string, onMove?: (dragId: string, targetId: string) => void) {
  if (!onMove) return {}
  return {
    draggable: true,
    onDragStart: (e: React.DragEvent) => { e.dataTransfer.setData('text/x-ut', id); e.dataTransfer.effectAllowed = 'move' },
    onDragOver: (e: React.DragEvent) => { if (e.dataTransfer.types.includes('text/x-ut')) { e.preventDefault(); e.currentTarget.classList.add('drop') } },
    onDragLeave: (e: React.DragEvent) => e.currentTarget.classList.remove('drop'),
    onDrop: (e: React.DragEvent) => { e.preventDefault(); e.currentTarget.classList.remove('drop'); const d = e.dataTransfer.getData('text/x-ut'); if (d && d !== id) onMove(d, id) },
  }
}
/** Ziel beim Ziehen nach unten: hinter das Ziel, nach oben: davor */
export const beforeOf = (ids: string[], dragId: string, targetId: string) => (ids.indexOf(dragId) < ids.indexOf(targetId) ? ids[ids.indexOf(targetId) + 1] : targetId)

/** Kennzeichnung „Team“ (geteiltes Lineup, kommt vom Team-Sync) */
export const TeamTag = ({ l }: { l: Lineup }) => (l.owner === 'local' ? null : <span className="ut-teamtag" title={`Shared with your team${l.author ? ` by ${l.author}` : ''}`}>Team</span>)

export function Star({ l }: { l: Lineup }) {
  const { update } = useUtil()
  if (l.owner !== 'local') return null // Favorit ist persönlich, Team-Lineups gehören allen
  return (
    <button className={`ut-star ${l.favorite ? 'on' : ''}`} title={l.favorite ? 'Remove from favourites' : 'Add to favourites'}
      onClick={e => { e.stopPropagation(); update(lib => patchLineup(lib, l.id, { favorite: !l.favorite })) }}>
      <Icon name="star" size={16} />
    </button>
  )
}

export function LineupCard({ l, onOpen, onMove, showMap }: { l: Lineup; onOpen: () => void; onMove?: (d: string, t: string) => void; showMap?: boolean }) {
  const { lib, maps, preview, team } = useUtil()
  const tags = lib.tags.filter(t => !t.deleted && l.tags.includes(t.id))
  return (
    <article className="ut-card" onClick={onOpen} {...dragProps(l.id, onMove)}>
      <div className="ut-card-head"><TypeIcon type={l.type} size={24} /><b title={l.title}>{l.title || 'Untitled'}</b><TeamTag l={l} /><Star l={l} /></div>
      {l.description && <p className="ut-card-desc" title={l.description}>{l.description}</p>}
      <div className="ut-card-media">
        {l.images[0] ? <img src={imageUrl(l.images[0])} alt="" loading="lazy" decoding="async" /> : <MiniRadar l={l} meta={maps.meta[l.map]} />}
        {(l.video?.url || l.video?.local || team.state.clips[l.id]) && <span className="ut-card-badge" title={team.state.clips[l.id] ? 'Has a team clip' : 'Has a video'}><Icon name="replay" size={13} /></span>}
        <button className="ut-card-3d" onClick={e => { e.stopPropagation(); preview(l) }} title="Preview in 3D"><Icon name="cube" size={15} /> Preview in 3D</button>
      </div>
      <div className="ut-card-foot">
        {showMap && <span className="ut-card-map">{mapName(l.map)}</span>}
        <SideBadge side={l.side} />
        <span className="ut-card-tech">{l.technique.map(t => techLabel(lib, t)).join(' + ')}</span>
        <span className="ut-dots">{tags.slice(0, 4).map(t => <i key={t.id} style={{ background: t.color }} title={t.name} />)}</span>
      </div>
    </article>
  )
}

/** Zeile; wide = Listenansicht (Tags als Chips), sonst schmale Spalte (Tags als Punkte) */
export function LineupRow({ l, onOpen, onMove, selected, onSelect, active, onHover, n, wide }: {
  l: Lineup; onOpen: () => void; onMove?: (d: string, t: string) => void
  selected?: boolean; onSelect?: (on: boolean) => void; active?: boolean; onHover?: (on: boolean) => void; n?: number; wide?: boolean
}) {
  const { lib, preview } = useUtil()
  const tags = lib.tags.filter(t => !t.deleted && l.tags.includes(t.id))
  return (
    <div className={`ut-row ${active ? 'on' : ''}`} onClick={onOpen} onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} {...dragProps(l.id, onMove)}>
      {onMove && <span className="ut-grip" title="Drag to reorder">⋮⋮</span>}
      {onSelect && <input type="checkbox" checked={!!selected} onClick={e => e.stopPropagation()} onChange={e => onSelect(e.target.checked)} title="Select (export, playbook)" />}
      {n != null && <span className="ut-row-n">{n}</span>}
      <TypeIcon type={l.type} size={26} />
      <div className="ut-row-main">
        <b title={l.description ? `${l.title}: ${l.description}` : l.title}>{l.title || 'Untitled'}<TeamTag l={l} /></b>
        <span className="ut-row-sub">
          <SideBadge side={l.side} /> {l.technique.map(t => techLabel(lib, t)).join(' + ')}
          {wide && tags.map(t => <span key={t.id} className="ut-tag" style={{ '--c': t.color } as React.CSSProperties}>{t.name}</span>)}
        </span>
      </div>
      {!wide && tags.length > 0 && <span className="ut-dots" title={tags.map(t => t.name).join(', ')}>{tags.slice(0, 4).map(t => <i key={t.id} style={{ background: t.color }} />)}</span>}
      {wide && l.images.length > 0 && <span className="ut-row-meta" title="Images"><Icon name="layers" size={14} />{l.images.length}</span>}
      {n == null && <Star l={l} />}
      <button className="ut-icon-btn" onClick={e => { e.stopPropagation(); preview(l) }} title="Preview in 3D"><Icon name="cube" size={16} /></button>
    </div>
  )
}
