// Strat-Seite „Wer macht was“: Taktik-Board links, rechts bis 5 Slots (Rolle, Spieler, Start, Lineups in Reihenfolge, Timing, Aufgabe),
// Notizen, Lern-Status; Vorschläge mit Abstimmung. Bearbeiten: Admin direkt, Spieler als Vorschlag (neu oder Änderung mit baseId).
import { useState } from 'react'
import { BUILTIN_ROLES, type Strat, type StratSlot, type TeamState } from '../../shared/team'
import { Icon } from '../icons'
import { SideBadge, TypeIcon } from '../utility/ui'
import { mapName } from '../utility/maps'
import { team } from '.'
import { Board, type BoardValue } from './Board'
import { KINDS, SLOT_COLORS, inBook, isAdmin, isOpen, kindLabel, roleLabel, uid } from './logic'
import { ProposalInfo } from './Proposals'
import { Avatar, LearnSeg, TI, nameOf, poolOf, useTeam } from './tui'

export const newStrat = (s: TeamState, map: string): Strat => ({
  id: uid(), teamId: s.team?.id ?? '', map, side: 'T', kind: 'default', title: '', slots: [], board: [], tags: [],
  status: isAdmin(s) ? 'approved' : 'proposed', author: s.me?.id ?? '', createdAt: Date.now(), updatedAt: Date.now(),
})
/** Änderungsvorschlag: Kopie mit neuer ID, baseId = Original */
export const suggestChange = (s: TeamState, st: Strat): Strat => ({ ...st, id: uid(), baseId: st.id, status: 'proposed', author: s.me?.id ?? '', decidedBy: undefined, createdAt: Date.now(), updatedAt: Date.now() })

export function StratPage({ id, draft, isNew }: { id: string; draft?: Strat; isNew?: boolean }) {
  const { s, go, run } = useTeam()
  const [d, setD] = useState(draft)
  const [focus, setFocus] = useState<{ i: number; n: number }>()
  const st = d ?? s.strats.find(x => x.id === id)
  if (!st || st.deleted) return <div className="ut-empty pad">This strat was removed. <button className="ut-link" onClick={() => go({ page: 'strats' })}>Back to the stratbook</button></div>
  const edit = !!d, admin = isAdmin(s)
  const upd = (p: Partial<Strat>) => setD(x => x && { ...x, ...p })
  const back = () => go(edit && !isNew && !d!.baseId ? { page: 'strat', id: st.id } : edit && d!.baseId ? { page: 'strat', id: d!.baseId } : { page: 'strats', map: st.map })
  const save = async (status: Strat['status']) => {
    if (!d!.title.trim()) return run(Promise.reject(new Error('Give the strat a title')))
    const ok = await run(team.saveStrat({ ...d!, title: d!.title.trim(), status }), status === 'proposed' ? 'Proposal sent. Your team can vote now.' : 'Saved to the stratbook')
    if (ok) go({ page: 'strat', id: d!.id })
  }
  const setBoard = (v: BoardValue) => upd(v)
  const value: BoardValue = { board: st.board, slots: st.slots }
  const proposal = st.status !== 'approved' || !!st.baseId

  return (
    <div className="tm-strat">
      <div className="ut-detail-head tm-strat-head">
        <button className="ut-icon-btn big" onClick={back} title="Back"><Icon name="arrow" className="flip" /></button>
        {edit ? (
          <div className="tm-strat-form">
            <input className="ut-input big" value={d!.title} onChange={e => upd({ title: e.target.value })} placeholder="Strat name, e.g. Mid split A" maxLength={60} autoFocus={isNew} />
            <input className="ut-input" value={d!.description ?? ''} onChange={e => upd({ description: e.target.value || undefined })} placeholder="One line: what is the idea?" maxLength={120} />
            <div className="tm-strat-props">
              <select className="ut-select" value={d!.map} onChange={e => upd({ map: e.target.value, slots: d!.slots.map(sl => ({ ...sl, start: undefined, lineupIds: [] })), board: [] })} disabled={!!d!.baseId} title="Map">
                {poolOf(s).map(p => <option key={p.map} value={p.map}>{mapName(p.map)}{p.status === 'permaban' ? ' (permaban)' : ''}</option>)}
              </select>
              <div className="ut-seg small">{(['T', 'CT'] as const).map(x => <button key={x} className={d!.side === x ? 'on' : ''} onClick={() => upd({ side: x })}>{x}</button>)}</div>
              <select className="ut-select" value={d!.kind} onChange={e => upd({ kind: e.target.value as Strat['kind'] })} title="Type">{KINDS.map(k => <option key={k.id} value={k.id}>{k.label}</option>)}</select>
              <input className="ut-input small" value={d!.tags.join(', ')} onChange={e => upd({ tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })} placeholder="Tags, comma separated" />
            </div>
          </div>
        ) : (
          <h1>
            <span className={`tm-kind-tag ${st.kind}`}>{kindLabel(st.kind)}</span>{st.title}
            {st.description && <small className="ut-desc">{st.description}</small>}
          </h1>
        )}
        <div className="ut-detail-actions">
          {!edit && <span className="tm-strat-meta"><SideBadge side={st.side} /> {mapName(st.map)}</span>}
          {!edit && inBook(st) && admin && <button className="ut-btn" onClick={() => go({ page: 'edit', draft: st })}><TI name="pen" size={15} /> Edit</button>}
          {!edit && inBook(st) && <button className={`ut-btn ${admin ? '' : 'primary'}`} onClick={() => go({ page: 'edit', draft: suggestChange(s, st) })}><TI name="vote" size={15} /> Suggest change</button>}
          {!edit && isOpen(st) && st.author === s.me?.id && <button className="ut-btn" onClick={() => go({ page: 'edit', draft: st })}><TI name="pen" size={15} /> Edit proposal</button>}
          {!edit && inBook(st) && admin && <button className="ut-btn danger" onClick={() => confirm(`Archive “${st.title}”? It leaves the stratbook.`) && run(team.saveStrat({ ...st, status: 'archived' }), 'Strat archived').then(ok => ok && go({ page: 'strats', map: st.map }))}><TI name="trash" size={15} /> Archive</button>}
          {edit && <button className="ut-btn ghost" onClick={back}>Cancel</button>}
          {edit && admin && !d!.baseId && d!.status !== 'proposed' && <>
            {isNew && <button className="ut-btn" onClick={() => save('proposed')} title="Let the team vote first">Propose to team</button>}
            <button className="ut-btn primary" onClick={() => save('approved')}><Icon name="check" size={16} /> {isNew ? 'Add to stratbook' : 'Save'}</button>
          </>}
          {edit && (!admin || d!.baseId || d!.status === 'proposed') && <button className="ut-btn primary" onClick={() => save('proposed')}><TI name="vote" size={15} /> Send proposal</button>}
        </div>
      </div>

      <div className="tm-strat-body">
        <div className="tm-strat-board">
          <Board map={st.map} value={value} onChange={edit ? setBoard : undefined} slotFocus={focus} />
          {edit && d!.baseId && <p className="tm-hint">You are suggesting a change. The original stays in the stratbook until an admin approves your version.</p>}
        </div>
        <aside className="tm-strat-side">
          {proposal && !edit && <ProposalInfo st={st} />}
          {!edit && inBook(st) && s.strats.filter(x => isOpen(x) && x.baseId === st.id).map(p => (
            <button key={p.id} className="ut-linkcard" onClick={() => go({ page: 'strat', id: p.id })}><span className="ut-linkcard-ico"><TI name="vote" size={18} /></span><span><b>Open change proposal</b><small>by {nameOf(s, p.author)}, vote now</small></span></button>
          ))}
          {!edit && inBook(st) && <div className="tm-card tm-row-between"><b>Your status</b><LearnSeg refTo={{ strat: st.id }} /></div>}
          <div className="tm-slots-head"><h3>Who does what</h3>{edit && st.slots.length < 5 && <button className="ut-btn small" onClick={() => upd({ slots: [...st.slots, { role: BUILTIN_ROLES[2 + Math.min(st.slots.length, 5)]?.id ?? 'support', lineupIds: [], task: '' }] })}><TI name="plus" size={14} /> Player</button>}</div>
          {!st.slots.length && <div className="ut-empty small">{edit ? 'Add up to 5 players: role, start, utility, task.' : 'No roles yet.'}</div>}
          {st.slots.map((sl, i) => edit
            ? <SlotEdit key={i} i={i} sl={sl} map={st.map} side={st.side} onFocus={() => setFocus({ i, n: Date.now() })}
                onChange={n => upd({ slots: st.slots.map((x, k) => (k === i ? n : x)) })}
                onRemove={() => upd({ slots: st.slots.filter((_, k) => k !== i), board: st.board.map(b => ({ ...b, slot: b.slot === i ? undefined : b.slot != null && b.slot > i ? b.slot - 1 : b.slot })) })} />
            : <SlotView key={i} i={i} sl={sl} />)}
          <h3 className="tm-notes-h">Notes</h3>
          {edit
            ? <textarea className="ut-book-notes tm-notes" value={d!.notes ?? ''} onChange={e => upd({ notes: e.target.value || undefined })} placeholder="Calls, what to do if it fails, against which setups it works" />
            : st.notes ? <p className="tm-notes-text">{st.notes}</p> : <div className="muted small">No notes.</div>}
          {!edit && st.tags.length > 0 && <div className="ut-chips">{st.tags.map(t => <span key={t} className="ut-tag">{t}</span>)}</div>}
        </aside>
      </div>
    </div>
  )
}

function SlotView({ i, sl }: { i: number; sl: StratSlot }) {
  const { s, go, preview } = useTeam()
  const m = s.members.find(x => x.id === sl.memberId)
  return (
    <div className="tm-slot" style={{ '--c': SLOT_COLORS[i] } as React.CSSProperties}>
      <div className="tm-slot-head">
        <span className="tm-slot-n">{i + 1}</span>
        <b>{roleLabel(sl.role)}</b>
        <span className="tm-slot-who">{m ? <><Avatar m={m} size={22} />{m.name}</> : <span className="muted">open</span>}</span>
        {sl.timing && <span className="tm-timing"><Icon name="clock" size={12} /> {sl.timing}</span>}
      </div>
      {sl.task && <p className="tm-slot-task">{sl.task}</p>}
      {sl.lineupIds.length > 0 && (
        <div className="tm-slot-lineups">
          {sl.lineupIds.map((lid, k) => {
            const l = s.lineups.find(x => x.id === lid)
            return l ? (
              <span key={lid + k} className="tm-lchip">
                <button onClick={() => go({ page: 'lineup', id: lid })} title="Open lineup"><em>{k + 1}</em><TypeIcon type={l.type} size={18} />{l.title}</button>
                <button className="tm-lchip-3d" onClick={() => preview(l)} title="Preview in 3D"><Icon name="cube" size={13} /></button>
              </span>
            ) : <span key={lid + k} className="tm-lchip gone">Lineup removed</span>
          })}
        </div>
      )}
      {!sl.start && <span className="tm-slot-nostart muted small">No start position</span>}
    </div>
  )
}

function SlotEdit({ i, sl, map, side, onChange, onRemove, onFocus }: { i: number; sl: StratSlot; map: string; side: 'T' | 'CT'; onChange: (s: StratSlot) => void; onRemove: () => void; onFocus: () => void }) {
  const { s } = useTeam()
  const up = (p: Partial<StratSlot>) => onChange({ ...sl, ...p })
  const pool = s.lineups.filter(l => !l.deleted && l.map === map && (l.side === side || l.side === 'both'))
  const move = (k: number, dir: number) => { const ids = [...sl.lineupIds]; [ids[k], ids[k + dir]] = [ids[k + dir], ids[k]]; up({ lineupIds: ids }) }
  return (
    <div className="tm-slot edit" style={{ '--c': SLOT_COLORS[i] } as React.CSSProperties}>
      <div className="tm-slot-head">
        <span className="tm-slot-n">{i + 1}</span>
        <select className="ut-select" value={sl.role} onChange={e => up({ role: e.target.value })} aria-label="Role">
          {BUILTIN_ROLES.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          {!BUILTIN_ROLES.some(r => r.id === sl.role) && <option value={sl.role}>{sl.role}</option>}
        </select>
        <select className="ut-select" value={sl.memberId ?? ''} onChange={e => up({ memberId: e.target.value || undefined })} aria-label="Player">
          <option value="">Open</option>
          {s.members.map(m => <option key={m.id} value={m.id}>{m.name}{m.roles.includes(sl.role) ? ` (${roleLabel(sl.role)})` : ''}</option>)}
        </select>
        <button className="ut-icon-btn" onClick={onRemove} title="Remove player"><Icon name="x" size={15} /></button>
      </div>
      <div className="tm-slot-row">
        <button className={`ut-btn small ${sl.start ? 'on' : ''}`} onClick={onFocus} title="Then click the map"><TI name="start" size={14} /> {sl.start ? 'Move start' : 'Set start'}</button>
        <input className="ut-input" value={sl.timing ?? ''} onChange={e => up({ timing: e.target.value || undefined })} placeholder="Timing, e.g. 1:15" maxLength={24} />
      </div>
      <textarea className="ut-book-notes tm-task" value={sl.task} onChange={e => up({ task: e.target.value })} placeholder="Task, e.g. entry A after the pop flash" rows={2} />
      <div className="tm-slot-lineups edit">
        {sl.lineupIds.map((lid, k) => {
          const l = s.lineups.find(x => x.id === lid)
          return (
            <div key={lid + k} className="tm-lrow">
              <em>{k + 1}</em>{l ? <><TypeIcon type={l.type} size={18} /><span>{l.title}</span></> : <span className="muted">Lineup removed</span>}
              <button className="ut-icon-btn" disabled={!k} onClick={() => move(k, -1)} title="Throw earlier">↑</button>
              <button className="ut-icon-btn" disabled={k === sl.lineupIds.length - 1} onClick={() => move(k, 1)} title="Throw later">↓</button>
              <button className="ut-icon-btn" onClick={() => up({ lineupIds: sl.lineupIds.filter((_, x) => x !== k) })} title="Remove"><Icon name="x" size={13} /></button>
            </div>
          )
        })}
        <select className="ut-select" value="" onChange={e => e.target.value && up({ lineupIds: [...sl.lineupIds, e.target.value] })}>
          <option value="">{pool.length ? '+ Add team lineup…' : `No team lineups for ${side} on ${mapName(map)} yet`}</option>
          {pool.map(l => <option key={l.id} value={l.id}>{l.title}</option>)}
        </select>
      </div>
    </div>
  )
}
