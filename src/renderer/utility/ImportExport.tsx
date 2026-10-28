// Utility-Dashboard: Export (alles / eine Map / ein Playbook / Auswahl, Größe vorher, lokale Videos nur auf Wunsch) und
// Import mit Vorschau (neu / doppelt / Konflikt je Eintrag, Entscheidung je Eintrag oder „für alle“). Abgleich: shared/utility-lib.ts
import { useEffect, useMemo, useState } from 'react'
import type { UtilityLibrary } from '../../shared/utility'
import { applyImport, chooseAll, choicesFor, planImport, subsetLibrary, type ImportChoice, type ImportItem, type ImportStatus } from '../../shared/utility-lib'
import { api } from '../api'
import { Icon } from '../icons'
import { mapName, typeOf } from './maps'
import { Modal, Seg, SideBadge, TypeIcon, VirtualRows, fmtBytes, live, useUtil } from './ui'

const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
const CHOICE: Record<ImportChoice, string> = { add: 'Import', skip: 'Skip', replace: 'Replace', both: 'Keep both' }
const STATUS: Record<ImportStatus, string> = { new: 'New', duplicate: 'Duplicate', conflict: 'Conflict' }

export function ExportDialog({ ids, onClose }: { ids?: string[]; onClose: () => void }) {
  const { lib, route, notify } = useUtil()
  const all = live(lib)
  const mapsWith = [...new Set(all.map(l => l.map))].sort()
  const books = lib.playbooks.filter(p => !p.deleted && p.lineupIds.length)
  const here = route.page === 'map' ? route.map : undefined
  const [scope, setScope] = useState<'all' | 'map' | 'playbook' | 'selection'>(ids?.length ? 'selection' : here && mapsWith.includes(here) ? 'map' : 'all')
  const [map, setMap] = useState(here && mapsWith.includes(here) ? here : mapsWith[0] ?? '')
  const [book, setBook] = useState(route.page === 'map' && route.playbook ? route.playbook : books[0]?.id ?? '')
  const [videos, setVideos] = useState(false)
  const [size, setSize] = useState<{ base: number; videos: number; imageCount: number; videoCount: number }>()
  const [busy, setBusy] = useState(false)
  const chosen = scope === 'all' ? all.map(l => l.id) : scope === 'map' ? all.filter(l => l.map === map).map(l => l.id)
    : scope === 'playbook' ? lib.playbooks.find(p => p.id === book)?.lineupIds ?? [] : ids ?? []
  const key = chosen.join()
  const sub = useMemo(() => subsetLibrary(lib, chosen, videos), [lib, key, videos])
  useEffect(() => { setSize(undefined); api.utilityExportSize(subsetLibrary(lib, chosen, true)).then(setSize, () => {}) }, [lib, key])
  const name = scope === 'map' ? `${mapName(map)} lineups` : scope === 'playbook' ? lib.playbooks.find(p => p.id === book)?.name ?? 'Playbook' : scope === 'selection' ? 'Selected lineups' : 'All lineups'
  const run = async () => {
    setBusy(true)
    try { const p = await api.utilityExport(sub, videos, name); if (p) { notify(`Exported ${sub.lineups.length} lineups to ${p}`); onClose() } } catch (e) { notify(errText(e), true) } finally { setBusy(false) }
  }
  const opt = (v: typeof scope, label: string, n: number, extra?: React.ReactNode) => (
    <label className={`ut-scope ${scope === v ? 'on' : ''} ${n ? '' : 'off'}`}>
      <input type="radio" name="scope" checked={scope === v} disabled={!n} onChange={() => setScope(v)} />
      <span>{label}</span>{extra}<small>{n} lineup{n === 1 ? '' : 's'}</small>
    </label>
  )
  return (
    <Modal title="Export lineups" onClose={onClose}
      foot={<><button className="ut-btn" onClick={onClose}>Cancel</button><button className="ut-btn primary" disabled={!sub.lineups.length || busy} onClick={run}><Icon name="upload" size={15} /> Export {sub.lineups.length} lineup{sub.lineups.length === 1 ? '' : 's'}…</button></>}>
      <div className="ut-scopes">
        {opt('all', 'Everything', all.length)}
        {opt('map', 'One map', all.filter(l => l.map === map).length,
          <select className="ut-select" value={map} onChange={e => { setMap(e.target.value); setScope('map') }}>{mapsWith.map(m => <option key={m} value={m}>{mapName(m)}</option>)}</select>)}
        {opt('playbook', 'One playbook', lib.playbooks.find(p => p.id === book)?.lineupIds.length ?? 0,
          books.length ? <select className="ut-select" value={book} onChange={e => { setBook(e.target.value); setScope('playbook') }}>{books.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : undefined)}
        {opt('selection', 'Selection', ids?.length ?? 0, !ids?.length ? <span className="muted small">Tick lineups in the list view first</span> : undefined)}
      </div>
      {!!size?.videoCount && (
        <label className="ut-check"><input type="checkbox" checked={videos} onChange={e => setVideos(e.target.checked)} />
          Include local videos ({size.videoCount}, {fmtBytes(size.videos)}) <span className="muted small">Off by default: they stay on this PC.</span></label>
      )}
      <div className="ut-size">
        <Icon name="folder" size={16} />
        {size ? <>About <b>{fmtBytes(size.base + (videos ? size.videos : 0))}</b> · {sub.lineups.length} lineups · {size.imageCount} images{sub.tags.length ? ` · ${sub.tags.length} tags` : ''}{sub.playbooks.length ? ` · ${sub.playbooks.length} playbooks` : ''}</> : 'Calculating size…'}
      </div>
      <p className="muted small">The file (.csutil) contains the lineups with their images, steps and links. Others can import it with “Import” and choose what to keep.</p>
    </Modal>
  )
}

export interface ImportData { library: UtilityLibrary; file: string; images: number; videos: number }

export function ImportDialog({ data, onClose }: { data: ImportData; onClose: () => void }) {
  const { lib, update, notify } = useUtil()
  const [items, setItems] = useState<ImportItem[]>(() => planImport(lib, data.library))
  const [busy, setBusy] = useState(false)
  const n = (s: ImportStatus) => items.filter(i => i.status === s).length
  const changes = items.filter(i => i.choice !== 'skip').length
  const cancel = () => { api.utilityImportCancel(); onClose() }
  const apply = async () => {
    setBusy(true)
    try {
      await api.utilityImportCommit()
      update(cur => applyImport(cur, data.library, items))
      notify(`Imported ${changes} item${changes === 1 ? '' : 's'} from ${data.file}`); onClose()
    } catch (e) { notify(errText(e), true); setBusy(false) }
  }
  const lineup = (id: string) => data.library.lineups.find(l => l.id === id)
  const local = (it: ImportItem) => it.kind === 'lineup' ? lib.lineups.find(l => l.id === it.localId)?.title : it.kind === 'tag' ? lib.tags.find(t => t.id === it.localId)?.name : lib.playbooks.find(p => p.id === it.localId)?.name
  const all = (s: ImportStatus, c: ImportChoice) => setItems(chooseAll(items, s, c))
  const allValue = (s: ImportStatus) => { const c = new Set(items.filter(i => i.status === s).map(i => i.choice)); return c.size === 1 ? [...c][0] : ('' as ImportChoice) }

  return (
    <Modal wide title={<>Import <span className="ut-file">{data.file}</span></>} onClose={cancel}
      foot={<><button className="ut-btn" onClick={cancel}>Cancel</button><button className="ut-btn primary" disabled={busy || !changes} onClick={apply}><Icon name="check" size={15} /> Import {changes} item{changes === 1 ? '' : 's'}</button></>}>
      <div className="ut-imp-sum">
        <span className="ut-imp-count new"><b>{n('new')}</b> new</span>
        <span className="ut-imp-count duplicate"><b>{n('duplicate')}</b> duplicate</span>
        <span className="ut-imp-count conflict"><b>{n('conflict')}</b> conflict{n('conflict') === 1 ? '' : 's'}</span>
        <span className="muted small">{data.library.lineups.length} lineups · {data.library.tags.length} tags · {data.library.playbooks.length} playbooks · {data.images} images{data.videos ? ` · ${data.videos} videos` : ''}</span>
      </div>
      <div className="ut-imp-all">
        {n('conflict') > 0 && <span>All conflicts: <Seg small value={allValue('conflict')} options={(['skip', 'replace', 'both'] as const).map(c => [c, CHOICE[c]])} onChange={c => all('conflict', c)} /></span>}
        {n('new') > 0 && <span>All new: <Seg small value={allValue('new')} options={(['add', 'skip'] as const).map(c => [c, CHOICE[c]])} onChange={c => all('new', c)} /></span>}
      </div>
      <VirtualRows className="ut-imp-list" items={items} rowH={58} gap={4}
        render={(it, i) => {
          const l = it.kind === 'lineup' ? lineup(it.id) : undefined, t = it.kind === 'tag' ? data.library.tags.find(x => x.id === it.id) : undefined
          return (
            <div key={`${it.kind}${it.id}`} className={`ut-imp-row ${it.status} ${it.choice === 'skip' ? 'skipped' : ''}`}>
              <span className={`ut-imp-badge ${it.status}`}>{STATUS[it.status]}</span>
              {l ? <TypeIcon type={l.type} size={26} /> : t ? <span className="ut-imp-swatch" style={{ background: t.color }} /> : <span className="ut-imp-kind"><Icon name="multi" size={15} /></span>}
              <div className="ut-imp-main">
                <b>{it.name || 'Untitled'}</b>
                <span className="ut-row-sub">
                  {l ? <>{mapName(l.map)} · {typeOf(l.type).label} · <SideBadge side={l.side} /></> : it.kind === 'tag' ? 'Tag' : 'Playbook'}
                  {it.reason && it.status !== 'new' && <em> · {it.reason}{it.localId && local(it) && local(it) !== it.name ? ` (yours: “${local(it)}”)` : ''}</em>}
                </span>
              </div>
              <Seg small value={it.choice} options={choicesFor(it).map(c => [c, CHOICE[c]])} onChange={c => setItems(items.map((x, j) => (j === i ? { ...x, choice: c } : x)))} />
            </div>
          )
        }} />
    </Modal>
  )
}
