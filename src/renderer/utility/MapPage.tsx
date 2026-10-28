// Utility-Dashboard Map-Seite: links Filter (Typ, Seite, Favoriten, Tags, Suche, gespeicherte Filter, Playbooks, „From demo“),
// Mitte Radar mit Zielen (gleiche Landestelle + Typ = ein Marker mit Zahl; Klick zeigt Standpunkte), Liste oder Karten; rechts die Treffer.
import { useEffect, useMemo, useState } from 'react'
import type { Lineup, NadeType, ThrowCandidate } from '../../shared/utility'
import { parseLibrary } from '../../shared/utility-lib'
import { api } from '../api'
import { Icon } from '../icons'
import { LineupCard, LineupRow, beforeOf, dragProps } from './cards'
import { POOL, TYPES, isLower, mapName, toRadar } from './maps'
import { deletePlaybook, moveId, moveLineup, newDraft, playbookItems, saveLineup, savePlaybook, uid } from './ops'
import { Radar } from './Radar'
import { Modal, Seg, StandMarker, TargetMarker, Throw, TypeIcon, VirtualRows, live, useLocal, useUtil } from './ui'

type Mode = 'radar' | 'list' | 'cards'
interface Filter { type: NadeType | 'all'; side: 'any' | 'T' | 'CT'; fav: boolean; tags: string[]; q: string }
const NONE: Filter = { type: 'all', side: 'any', fav: false, tags: [], q: '' }
/** gleiche Landestelle (Weltunits) und gleicher Typ = ein Marker */
const CLUSTER = 80

// Würfe aus Demos (3D-Vorschau-Zweig): einmal je Sitzung holen; fehlt die IPC oder schlägt sie fehl → leer (Bereich bleibt verborgen)
let throws: Promise<ThrowCandidate[]> | undefined
const loadThrows = () => (throws ??= (api.utilityThrows?.() ?? Promise.resolve([])).then(r => (Array.isArray(r) ? r : []), () => []))

export function MapPage({ map, playbook, mode: forced, focus: focus0 }: { map: string; playbook?: string; mode?: Mode; focus?: string }) {
  const { lib, maps, update, go, route, notify, openExport, team, share } = useUtil()
  const meta = maps.meta[map]
  const hasLower = maps.radars.includes(`${map}_lower`)
  const [stored, setStored] = useLocal<Mode>('csda.utility.view.v1', 'radar')
  const [chosen, setChosen] = useState<Mode>(forced ?? stored)
  const mode = playbook ? 'radar' : chosen
  const setMode = (m: Mode) => { setChosen(m); setStored(m) }
  const [f, setF] = useState<Filter>(NONE)
  const [saved, setSaved] = useLocal<{ name: string; f: Filter }[]>('csda.utility.filters.v1', [])
  const [naming, setNaming] = useState<string>()
  const [lower, setLower] = useState(false)
  const [focus, setFocus] = useState<string | undefined>(focus0)
  const [hover, setHover] = useState<string>()
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [cands, setCands] = useState<ThrowCandidate[]>([])
  const [demoOpen, setDemoOpen] = useState(false)
  useEffect(() => { loadThrows().then(setCands) }, [])

  const all = useMemo(() => live(lib).filter(l => l.map === map), [lib, map])
  const tagName = useMemo(() => new Map(lib.tags.filter(t => !t.deleted).map(t => [t.id, t.name.toLowerCase()])), [lib.tags])
  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase()
    return all.filter(l => (f.type === 'all' || l.type === f.type) && (f.side === 'any' || l.side === f.side || l.side === 'both') && (!f.fav || l.favorite)
      && (!f.tags.length || l.tags.some(t => f.tags.includes(t)))
      && (!q || [l.title, l.description ?? '', ...l.steps, ...Object.values(l.fields ?? {}), ...l.tags.map(t => tagName.get(t) ?? '')].some(s => s.toLowerCase().includes(q))))
  }, [all, f, tagName])
  const onLevel = (l: Lineup) => !hasLower || isLower(meta, l.target.z ?? l.stand.z) === lower
  const clusters = useMemo(() => {
    const out: { id: string; x: number; y: number; items: Lineup[] }[] = []
    for (const l of shown.filter(onLevel)) {
      const c = out.find(c => c.items[0].type === l.type && Math.hypot(c.x - l.target.x, c.y - l.target.y) < CLUSTER)
      if (c) c.items.push(l); else out.push({ id: l.id, x: l.target.x, y: l.target.y, items: [l] })
    }
    return out
  }, [shown, lower])
  const focused = clusters.find(c => c.items.some(l => l.id === focus))
  const book = playbook ? lib.playbooks.find(p => p.id === playbook && !p.deleted) : undefined
  const bookItems = book ? book.lineupIds.map(id => all.find(l => l.id === id)).filter((l): l is Lineup => !!l) : []
  const list = book ? bookItems : focused ? focused.items : shown
  const books = lib.playbooks.filter(p => !p.deleted && (p.map === map || (!p.map && p.lineupIds.some(id => all.some(l => l.id === id)))))
  const mapCands = cands.filter(c => c.map === map)

  const open = (l: Lineup) => go({ page: 'lineup', id: l.id, back: route })
  const add = () => go({ page: 'edit', draft: newDraft(map), isNew: true, step: 2, back: route })
  const move = (d: string, t: string) => update(x => moveLineup(x, d, beforeOf(list.map(l => l.id), d, t)))
  const toggleSel = (id: string, on: boolean) => setSel(s => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })
  const newBook = (ids: string[] = []) => { const id = uid(); update(x => savePlaybook(x, { id, name: `${mapName(map)} playbook ${books.length + 1}`, map, lineupIds: ids })); go({ page: 'map', map, playbook: id }) }
  const R = (l: Lineup, which: 'stand' | 'target') => toRadar(meta, l[which])

  const radar = meta && (
    <Radar map={map} lower={lower}
      top={<>
        {(focused || book) && <button className="ut-chip-btn" onClick={() => (book ? go({ page: 'map', map }) : setFocus(undefined))}><Icon name="arrow" size={14} className="flip" /> {book ? 'Close playbook' : 'All lineups'}</button>}
        {hasLower && <Seg small value={lower ? 'lower' : 'upper'} options={[['upper', 'Upper'], ['lower', 'Lower']]} onChange={v => setLower(v === 'lower')} />}
      </>}>
      {s => book ? (
        <>
          {bookItems.filter(onLevel).map(l => <Throw key={`t${l.id}`} a={R(l, 'stand')} b={R(l, 'target')} s={s} active={hover === l.id} />)}
          {bookItems.filter(onLevel).map(l => { const b = R(l, 'target'); return <TargetMarker key={`m${l.id}`} x={b.x} y={b.y} type={l.type} side={l.side} s={s} onClick={() => open(l)} /> })}
          {bookItems.map((l, i) => { if (!onLevel(l)) return null; const a = R(l, 'stand'); return <StandMarker key={`s${l.id}`} x={a.x} y={a.y} side={l.side} s={s} n={i + 1} active={hover === l.id} onClick={() => open(l)} onHover={on => setHover(on ? l.id : undefined)} /> })}
        </>
      ) : (
        <>
          {clusters.map(c => {
            const show = focused ? focused === c : c.items.some(l => l.id === hover)
            return show && c.items.map(l => <Throw key={`t${l.id}`} a={R(l, 'stand')} b={R(l, 'target')} s={s} active={hover === l.id} />)
          })}
          {clusters.map(c => {
            const b = toRadar(meta, c), sides = new Set(c.items.map(l => l.side))
            return <TargetMarker key={c.id} x={b.x} y={b.y} type={c.items[0].type} side={sides.size === 1 ? c.items[0].side : 'both'} count={c.items.length} s={s}
              active={focused === c} dim={!!focused && focused !== c} onClick={() => setFocus(focused === c ? undefined : c.items[0].id)} onHover={on => !focused && setHover(on ? c.items[0].id : undefined)} />
          })}
          {focused?.items.map(l => { const a = R(l, 'stand'); return <StandMarker key={`s${l.id}`} x={a.x} y={a.y} side={l.side} s={s} active={hover === l.id} onClick={() => open(l)} onHover={on => setHover(on ? l.id : undefined)} /> })}
        </>
      )}
    </Radar>
  )

  return (
    <div className={`ut-mappage ${mode}`}>
      <aside className="ut-filters">
        <button className="ut-back" onClick={() => go({ page: 'home' })}><Icon name="arrow" size={15} className="flip" /> All maps</button>
        <h1 className="ut-mapname">{mapName(map)}</h1>
        <div className="muted small">{all.length} lineup{all.length === 1 ? '' : 's'}{all.some(l => l.favorite) ? ` · ${all.filter(l => l.favorite).length} favourites` : ''}</div>

        <div className="ut-box">
          <h4>Grenades</h4>
          <button className={`ut-typerow ${f.type === 'all' ? 'on' : ''}`} onClick={() => setF({ ...f, type: 'all' })}><span className="ut-type all"><Icon name="library" size={14} /></span>All<small>{all.length}</small></button>
          {TYPES.filter(t => t.id !== 'decoy' || f.type === 'decoy' || all.some(l => l.type === 'decoy')).map(t => (
            <button key={t.id} className={`ut-typerow ${f.type === t.id ? 'on' : ''}`} onClick={() => setF({ ...f, type: f.type === t.id ? 'all' : t.id })}>
              <TypeIcon type={t.id} size={24} />{t.plural}<small>{all.filter(l => l.type === t.id).length}</small>
            </button>
          ))}
          <h4>Side</h4>
          <Seg value={f.side} options={[['any', 'Any'], ['T', 'T'], ['CT', 'CT']]} onChange={side => setF({ ...f, side })} />
          <h4>Filters</h4>
          <div className="ut-chips">
            <button className={`ut-chip ${f.fav ? 'on' : ''}`} onClick={() => setF({ ...f, fav: !f.fav })}><Icon name="star" size={13} /> Favourites</button>
            {lib.tags.filter(t => !t.deleted).map(t => (
              <button key={t.id} className={`ut-chip ${f.tags.includes(t.id) ? 'on' : ''}`} style={{ '--c': t.color } as React.CSSProperties}
                onClick={() => setF({ ...f, tags: f.tags.includes(t.id) ? f.tags.filter(x => x !== t.id) : [...f.tags, t.id] })}><i />{t.name}</button>
            ))}
          </div>
          <input className="ut-search" placeholder="Search title, description, tags…" value={f.q} onChange={e => setF({ ...f, q: e.target.value })} />
          {(saved.length > 0 || JSON.stringify(f) !== JSON.stringify(NONE)) && (
            <div className="ut-saved">
              {saved.map((s, i) => (
                <span key={i} className="ut-chip saved"><button onClick={() => setF(s.f)} title="Apply saved filter"><Icon name="bolt" size={12} /> {s.name}</button><button onClick={() => setSaved(saved.filter((_, j) => j !== i))} title="Remove"><Icon name="x" size={11} /></button></span>
              ))}
              {JSON.stringify(f) !== JSON.stringify(NONE) && (naming === undefined
                ? <><button className="ut-link small" onClick={() => setNaming('')}>Save filter</button><button className="ut-link small" onClick={() => setF(NONE)}>Reset</button></>
                : <input autoFocus className="ut-search" placeholder="Name, then Enter" value={naming} onChange={e => setNaming(e.target.value)} onBlur={() => setNaming(undefined)}
                    onKeyDown={e => { if (e.key === 'Enter' && naming.trim()) { const name = naming.trim().slice(0, 30); setSaved([...saved.filter(s => s.name !== name), { name, f }]); setNaming(undefined) } if (e.key === 'Escape') setNaming(undefined) }} />)}
            </div>
          )}
        </div>

        <div className="ut-box">
          <h4>Playbooks <button className="ut-link small" onClick={() => newBook()}>+ New</button></h4>
          {books.map(p => <button key={p.id} className={`ut-menu-item ${p.id === playbook ? 'on' : ''}`} onClick={() => go({ page: 'map', map, playbook: p.id })}>{p.name}<small>{p.lineupIds.length}</small></button>)}
          {!books.length && <div className="muted small">Ordered sets, e.g. an A execute.</div>}
        </div>

        {mapCands.length > 0 && <button className={`ut-btn ${demoOpen ? 'on' : ''}`} onClick={() => setDemoOpen(o => !o)}><Icon name="replay" size={15} /> From your demos <small>{mapCands.length}</small></button>}
        <button className="ut-btn primary" onClick={add}>+ Add lineup</button>

        <div className="ut-box ut-maplist">
          <h4>Maps</h4>
          {[...POOL, ...maps.radars.filter(r => !r.endsWith('_lower') && !POOL.includes(r) && maps.meta[r] && live(lib).some(l => l.map === r))].filter(m => maps.meta[m]).map(m => (
            <button key={m} className={`ut-menu-item ${m === map ? 'on' : ''}`} onClick={() => go({ page: 'map', map: m })}>{mapName(m)}<small>{live(lib).filter(l => l.map === m).length || ''}</small></button>
          ))}
        </div>
      </aside>

      <section className="ut-center">
        <div className="ut-toolbar">
          {!book && <Seg value={mode} options={[['radar', <><Icon name="target" size={14} /> Radar</>], ['list', <><Icon name="stats" size={14} /> List</>], ['cards', <><Icon name="library" size={14} /> Cards</>]]} onChange={setMode} />}
          {book && <b className="ut-toolbar-title"><Icon name="multi" size={16} /> {book.name}</b>}
          <span className="ut-toolbar-info">{book ? `${bookItems.length} steps` : `${shown.length} of ${all.length} shown`}</span>
          {sel.size > 0 && mode !== 'radar' && (
            <div className="ut-selbar">
              <b>{sel.size} selected</b>
              <button className="ut-btn small" onClick={() => openExport([...sel])}>Export</button>
              {team.state.team && <button className="ut-btn small" onClick={() => { share([...sel]); setSel(new Set()) }} title={`Copy the selected lineups to ${team.state.team.name}`}><Icon name="multi" size={13} /> Share to team</button>}
              <select className="ut-select" value="" onChange={e => {
                const v = e.target.value, ids = [...sel]
                if (v === 'new') newBook(ids)
                else if (v) { update(x => playbookItems(x, v, cur => [...cur, ...ids.filter(i => !cur.includes(i))])); notify('Added to playbook') }
              }}>
                <option value="">Add to playbook…</option>
                {books.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                <option value="new">New playbook</option>
              </select>
              <button className="ut-link small" onClick={() => setSel(new Set())}>Clear</button>
            </div>
          )}
        </div>
        {mode === 'radar' && <div className="ut-radar-wrap">{radar}</div>}
        {mode === 'list' && (
          <VirtualRows className="ut-listview" items={shown} rowH={66} gap={6} empty={<Empty filtered={all.length > 0} onAdd={add} />}
            render={l => <LineupRow key={l.id} l={l} wide onOpen={() => open(l)} onMove={move} selected={sel.has(l.id)} onSelect={on => toggleSel(l.id, on)} />} />
        )}
        {mode === 'cards' && (
          <VirtualRows className="ut-cardview" items={shown} rowH={w => w * 9 / 16 + 100} minColW={250} gap={14} empty={<Empty filtered={all.length > 0} onAdd={add} />}
            render={l => <LineupCard key={l.id} l={l} onOpen={() => open(l)} onMove={move} />} />
        )}
      </section>

      {mode === 'radar' && (
        <aside className="ut-results">
          {demoOpen ? <FromDemo map={map} list={cands} onClose={() => setDemoOpen(false)} /> : book ? (
            <PlaybookPanel key={book.id} id={book.id} items={bookItems} hover={hover} setHover={setHover} onOpen={open}
              onDelete={() => { if (confirm(`Delete playbook "${book.name}"? The lineups stay.`)) { update(x => deletePlaybook(x, book.id)); go({ page: 'map', map }) } }} />
          ) : (
            <>
              <div className="ut-results-head">
                {focused ? <><TypeIcon type={focused.items[0].type} size={22} /><b>{focused.items.length} lineup{focused.items.length === 1 ? '' : 's'} to this spot</b></> : <b>{shown.length} lineup{shown.length === 1 ? '' : 's'}</b>}
              </div>
              <VirtualRows items={list} rowH={66} gap={6} empty={<Empty filtered={all.length > 0} onAdd={add} />}
                render={l => <LineupRow key={l.id} l={l} onOpen={() => open(l)} active={hover === l.id} onHover={on => setHover(on ? l.id : undefined)} />} />
            </>
          )}
        </aside>
      )}
    </div>
  )
}

function Empty({ filtered, onAdd }: { filtered: boolean; onAdd: () => void }) {
  return <div className="ut-empty">{filtered ? 'Nothing matches these filters.' : <><b>No lineups on this map yet.</b> <button className="ut-link" onClick={onAdd}>Add the first one</button></>}</div>
}

function PlaybookPanel({ id, items, hover, setHover, onOpen, onDelete }: {
  id: string; items: Lineup[]; hover?: string; setHover: (id?: string) => void; onOpen: (l: Lineup) => void; onDelete: () => void
}) {
  const { lib, update } = useUtil()
  const p = lib.playbooks.find(x => x.id === id)!
  const set = (patch: Partial<typeof p>) => update(x => savePlaybook(x, { ...p, ...patch }))
  return (
    <div className="ut-book">
      <input className="ut-book-name" defaultValue={p.name} maxLength={120} onBlur={e => { const n = e.target.value.trim(); if (n && n !== p.name) set({ name: n }) }} />
      <textarea className="ut-book-notes" placeholder="Notes, e.g. timing or who throws what" defaultValue={p.notes ?? ''} maxLength={5000} onBlur={e => { if (e.target.value !== (p.notes ?? '')) set({ notes: e.target.value }) }} />
      <div className="ut-book-list">
        {items.map((l, i) => (
          <div key={l.id} className="ut-book-item" {...dragProps(l.id, (d, t) => update(x => playbookItems(x, id, ids => moveId(ids, d, beforeOf(ids, d, t)))))}>
            <LineupRow l={l} n={i + 1} onOpen={() => onOpen(l)} active={hover === l.id} onHover={on => setHover(on ? l.id : undefined)} />
            <button className="ut-icon-btn" title="Remove from playbook" onClick={() => update(x => playbookItems(x, id, ids => ids.filter(i => i !== l.id)))}><Icon name="x" size={14} /></button>
          </div>
        ))}
        {!items.length && <div className="ut-empty small">Empty. Add lineups with “Add to playbook” on a lineup page or by selecting them in the list view.</div>}
      </div>
      <button className="ut-link small danger" onClick={onDelete}>Delete playbook</button>
    </div>
  )
}

/** Würfe aus importierten Demos als Vorschlag; ein Klick übernimmt ihn als Lineup (Test: fromdemo.test.tsx) */
export function FromDemo({ map, list, onClose }: { map: string; list: ThrowCandidate[]; onClose: () => void }) {
  const { lib, update, notify } = useUtil()
  const [m, setM] = useState(map), [type, setType] = useState<NadeType | 'all'>('all'), [player, setPlayer] = useState('all'), [sort, setSort] = useState<'common' | 'round'>('common')
  const [info, setInfo] = useState<ThrowCandidate>()
  const onMap = list.filter(c => c.map === m)
  const shown = onMap.filter(c => (type === 'all' || c.type === type) && (player === 'all' || c.player === player))
    .sort((a, b) => (sort === 'common' ? b.similar - a.similar : a.matchId.localeCompare(b.matchId) || a.round - b.round || a.tick - b.tick))
  const key = (d: { matchId: string; tick: number; steamid: string }) => `${d.matchId}/${d.tick}/${d.steamid}`
  const have = new Set(lib.lineups.filter(l => !l.deleted && l.demo).map(l => key(l.demo!)))
  const take = (c: ThrowCandidate) => {
    const now = Date.now(), l: Lineup = { ...c.lineup, demo: c.lineup.demo ?? { matchId: c.matchId, tick: c.tick, steamid: c.steamid, player: c.player, round: c.round }, id: uid(), owner: 'local', createdAt: now, updatedAt: now }
    try { parseLibrary({ version: 1, lineups: [l], tags: [], playbooks: [], techniques: [] }) } catch (e) { notify(`Could not add this throw: ${e instanceof Error ? e.message : e}`, true); return }
    update(x => saveLineup(x, l)); notify(`Added “${l.title}”`)
  }
  return (
    <div className="ut-demo">
      <div className="ut-results-head"><Icon name="replay" size={16} /><b>From your demos</b><button className="ut-icon-btn" onClick={onClose} title="Close"><Icon name="x" size={15} /></button></div>
      <div className="ut-demo-filters">
        <select className="ut-select" value={m} onChange={e => setM(e.target.value)}>{[...new Set(list.map(c => c.map))].sort().map(x => <option key={x} value={x}>{mapName(x)}</option>)}</select>
        <select className="ut-select" value={type} onChange={e => setType(e.target.value as NadeType | 'all')}><option value="all">All types</option>{TYPES.map(t => <option key={t.id} value={t.id}>{t.plural}</option>)}</select>
        <select className="ut-select" value={player} onChange={e => setPlayer(e.target.value)}><option value="all">All players</option>{[...new Set(onMap.map(c => c.player))].sort().map(p => <option key={p}>{p}</option>)}</select>
        <Seg small value={sort} options={[['common', 'Most common'], ['round', 'By round']]} onChange={setSort} />
      </div>
      <VirtualRows items={shown} rowH={62} gap={6} empty={<div className="ut-empty small">No throws for these filters.</div>}
        render={c => (
          <div key={key(c)} className="ut-row demo" onClick={() => setInfo(c)}>
            <TypeIcon type={c.type} size={26} />
            <div className="ut-row-main"><b title={c.lineup.title}>{c.lineup.title}</b><span className="ut-row-sub">{c.player} · round {c.round} · {c.side}</span></div>
            {c.similar > 1 && <span className="ut-often" title="Similar throws in your demos">{c.similar}×</span>}
            {have.has(key(c)) ? <span className="ut-row-meta"><Icon name="check" size={14} /> Added</span>
              : <button className="ut-btn small primary" onClick={e => { e.stopPropagation(); take(c) }}>Add</button>}
          </div>
        )} />
      {info && (
        <Modal title={info.lineup.title} onClose={() => setInfo(undefined)} foot={<button className="ut-btn primary" disabled={have.has(key(info))} onClick={() => { take(info); setInfo(undefined) }}>Add as lineup</button>}>
          <p className="muted">{info.player}, round {info.round}, {info.side} side. {info.similar > 1 ? `Thrown like this ${info.similar} times in your demos.` : ''}</p>
        </Modal>
      )}
    </div>
  )
}
