// Utility-Dashboard: eigene Tags (Name + Farbe) anlegen, umbenennen, umfärben, löschen (weich)
import { useState } from 'react'
import type { Tag } from '../../shared/utility'
import { Icon } from '../icons'
import { deleteTag, saveTag, uid } from './ops'
import { useUtil } from './ui'

export const TAG_COLORS = ['#ffb21e', '#ff6b3d', '#f5d547', '#7bd16b', '#4fd1c5', '#6fb3ff', '#a78bfa', '#f472b6', '#d9dce3']

/** neuer Tag: Name + Farbe; onCreate bekommt die ID (z. B. um ihn gleich zuzuweisen) */
export function NewTag({ onCreate }: { onCreate?: (id: string) => void }) {
  const { lib, update } = useUtil()
  const [name, setName] = useState(''), [color, setColor] = useState(TAG_COLORS[lib.tags.length % TAG_COLORS.length])
  const add = () => {
    const n = name.trim()
    if (!n) return
    const same = lib.tags.find(t => !t.deleted && t.name.toLowerCase() === n.toLowerCase())
    const id = same?.id ?? uid()
    if (!same) update(l => saveTag(l, { id, name: n.slice(0, 60), color }))
    onCreate?.(id); setName('')
  }
  return (
    <div className="ut-newtag">
      <input type="color" value={color} onChange={e => setColor(e.target.value)} title="Tag color" />
      <input placeholder="New tag…" value={name} maxLength={60} onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
      <button className="ut-btn small" disabled={!name.trim()} onClick={add}>Add</button>
    </div>
  )
}

export function TagManager() {
  const { lib, update } = useUtil()
  const tags = lib.tags.filter(t => !t.deleted)
  const set = (t: Tag, p: Partial<Tag>) => update(l => saveTag(l, { ...t, ...p }))
  return (
    <div className="ut-tagman">
      {tags.map(t => (
        <div key={t.id} className="ut-tagman-row">
          <input type="color" value={t.color} onChange={e => set(t, { color: e.target.value })} title="Change color" />
          <input defaultValue={t.name} maxLength={60} onBlur={e => { const n = e.target.value.trim(); if (n && n !== t.name) set(t, { name: n }) }} />
          <span className="muted small">{lib.lineups.filter(l => !l.deleted && l.tags.includes(t.id)).length}</span>
          <button className="ut-icon-btn" title="Delete tag" onClick={() => { if (confirm(`Delete tag "${t.name}"? Lineups keep everything else.`)) update(l => deleteTag(l, t.id)) }}><Icon name="x" size={15} /></button>
        </div>
      ))}
      {!tags.length && <div className="muted small">No tags yet. Tags with colors help you group lineups, e.g. “Execute”, “Retake”, “Pistol round”.</div>}
      <NewTag />
    </div>
  )
}
