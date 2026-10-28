// Stratbook: Map-Leiste (Pool, Permaban ausgegraut), Filter Seite/Art/Suche, virtuelle Liste der freigegebenen Strats
import { useState } from 'react'
import type { Strat } from '../../shared/team'
import { Icon } from '../icons'
import { SideBadge, VirtualRows, useLocal } from '../utility/ui'
import { mapName } from '../utility/maps'
import { KINDS, ago, inBook, isAdmin, isOpen, kindLabel, progressOf } from './logic'
import { newStrat } from './StratPage'
import { Avatar, LearnDot, MapStrip, TI, poolOf, useTeam } from './tui'

export function Stratbook() {
  const { s, route, go, map: last, setMap } = useTeam()
  const map = (route.page === 'strats' && route.map) || last
  const [side, setSide] = useLocal<'all' | 'T' | 'CT'>('tm-side', 'all')
  const [kinds, setKinds] = useState<string[]>([])
  const [q, setQ] = useState('')
  const book = s.strats.filter(inBook)
  const status = poolOf(s).find(p => p.map === map)?.status
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const list = book
    .filter(x => x.map === map && (side === 'all' || x.side === side) && (!kinds.length || kinds.includes(x.kind)))
    .filter(x => words.every(w => `${x.title} ${x.description ?? ''} ${x.tags.join(' ')} ${kindLabel(x.kind)}`.toLowerCase().includes(w)))
    .sort((a, b) => a.side.localeCompare(b.side) || KINDS.findIndex(k => k.id === a.kind) - KINDS.findIndex(k => k.id === b.kind) || a.title.localeCompare(b.title))
  const open = s.strats.filter(x => isOpen(x) && x.map === map).length
  const pick = (m: string) => { setMap(m); go({ page: 'strats', map: m }) }

  return (
    <div className="tm-page tm-book">
      <MapStrip value={map} onPick={pick} count={m => book.filter(x => x.map === m).length} />
      <div className="tm-book-bar">
        <h1 className="ut-mapname">{mapName(map)}</h1>
        {status === 'permaban' && <span className="tm-pill rejected">Permaban</span>}
        <div className="ut-seg small">{(['all', 'T', 'CT'] as const).map(x => <button key={x} className={side === x ? 'on' : ''} onClick={() => setSide(x)}>{x === 'all' ? 'Both sides' : x}</button>)}</div>
        <div className="ut-chips">
          {KINDS.filter(k => book.some(x => x.map === map && x.kind === k.id) || kinds.includes(k.id)).map(k => (
            <button key={k.id} className={`ut-chip ${kinds.includes(k.id) ? 'on' : ''}`} onClick={() => setKinds(kinds.includes(k.id) ? kinds.filter(x => x !== k.id) : [...kinds, k.id])}>
              <i className={`tm-kdot ${k.id}`} />{k.label}
            </button>
          ))}
        </div>
        <input className="ut-search tm-book-search" placeholder="Search strats" value={q} onChange={e => setQ(e.target.value)} />
        <div className="tm-book-actions">
          {open > 0 && <button className="ut-btn ghost" onClick={() => go({ page: 'proposals' })}><TI name="vote" size={15} /> {open} open</button>}
          <button className="ut-btn primary" onClick={() => go({ page: 'edit', draft: newStrat(s, map), isNew: true })}><TI name="plus" size={15} /> {isAdmin(s) ? 'New strat' : 'Suggest a strat'}</button>
        </div>
      </div>
      <VirtualRows items={list} rowH={74} gap={8} className="tm-book-list" render={st => <StratRow key={st.id} st={st} />}
        empty={<div className="ut-empty"><b>No strats{words.length || kinds.length || side !== 'all' ? ' match these filters' : ` for ${mapName(map)} yet`}.</b> {isAdmin(s) ? 'Add the first one' : 'Suggest one'} with the button above.</div>} />
    </div>
  )
}

export function StratRow({ st, showMap }: { st: Strat; showMap?: boolean }) {
  const { s, go } = useTeam()
  const nades = st.slots.reduce((n, sl) => n + sl.lineupIds.length, 0)
  return (
    <button className="tm-srow" onClick={() => go({ page: 'strat', id: st.id })}>
      <span className={`tm-kind-tag ${st.kind}`}>{kindLabel(st.kind)}</span>
      <span className="tm-srow-main">
        <b>{st.title}</b>
        <span className="muted small">{showMap && `${mapName(st.map)}, `}{st.description ?? `${st.slots.length} players`}</span>
      </span>
      <SideBadge side={st.side} />
      <span className="tm-srow-team">{st.slots.slice(0, 5).map((sl, i) => <Avatar key={i} m={s.members.find(m => m.id === sl.memberId) ?? { id: '', name: '?' }} size={22} />)}</span>
      <span className="tm-srow-meta" title={`${nades} grenades`}><Icon name="nade" size={14} />{nades}</span>
      <span className="tm-srow-meta muted small">{ago(st.updatedAt)}</span>
      <LearnDot status={progressOf(s.progress, s.me?.id, { strat: st.id })} />
    </button>
  )
}
