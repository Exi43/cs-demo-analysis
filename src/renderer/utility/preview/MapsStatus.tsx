// Utility-Kopf: Stand des 3D-Vorbaus der Pool-Maps für die Lineup-Vorschau (main/assets3d/index.ts prebuildMaps, Status 'map:<name>'),
// nur lesend. Unsichtbar, solange nichts vorgebaut wird (kein CS2, noch nicht gestartet); fertig = kleiner Haken.
import { useEffect, useState, type JSX } from 'react'
import type { Prepare3DStatus } from '../../../shared/assets3d'
import { api } from '../../api'
import { Icon } from '../../icons'
import { POOL, mapName } from '../maps'
import './preview.css'

export function MapsStatus(): JSX.Element | null {
  const [st, setSt] = useState<Record<string, Prepare3DStatus>>({})
  useEffect(() => {
    let live = true
    const only = (l: Prepare3DStatus[]) => Object.fromEntries(l.filter(s => s.id.startsWith('map:')).map(s => [s.id.slice(4), s]))
    // Meldungen nach dem Abruf gelten (wie Library.tsx)
    api.prepareStatus().then(l => { if (live) setSt(p => ({ ...only(l), ...p })) })
    const off = api.onPrepareStatus(s => setSt(p => ({ ...p, ...only([s]) })))
    return () => { live = false; off() }
  }, [])
  const list = POOL.map(m => st[m]).filter(Boolean)
  if (!list.length) return null
  const ready = list.filter(s => s.state === 'ready').length, now = list.find(s => s.state === 'building'), bad = list.filter(s => s.state === 'error')
  const title = POOL.map(m => `${mapName(m)}: ${st[m] ? (st[m].state === 'building' ? `${st[m].msg} (${st[m].pct} %)` : st[m].state === 'error' ? `failed: ${st[m].msg}` : st[m].state) : 'not checked yet'}`).join('\n')
  return (
    <span className={`lp-maps ${ready === POOL.length ? 'done' : ''} ${bad.length ? 'bad' : ''}`} role="status" title={`3D maps for the lineup preview\n${title}`}>
      {ready === POOL.length ? <Icon name="check" size={14} /> : <i className="lp-maps-dot" />}
      3D maps {ready}/{POOL.length}
      {now && <small>{mapName(now.id.slice(4))} {now.pct} %</small>}
      {!now && bad.length > 0 && <small>{bad.length} failed</small>}
    </span>
  )
}
