// Scrim-/Match-Notizen und Review-Playlists: Liste links, Notiz rechts, Runden-Lesezeichen öffnen die lokale Demo im 2D/3D-Replay
// (demoKey = Match-ID, siehe logic.ts). Ändern: Autor oder Admin.
import { useState } from 'react'
import type { Bookmark, Note } from '../../shared/team'
import { api } from '../api'
import { Icon } from '../icons'
import { VirtualRows } from '../utility/ui'
import { mapName } from '../utility/maps'
import { team } from '.'
import { isAdmin, matchForKey, uid } from './logic'
import { TI, errText, nameOf, poolOf, useTeam } from './tui'

const KIND: Record<Note['kind'], string> = { scrim: 'Scrim', match: 'Match', review: 'Review' }
const day = (t: number) => new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })

export function NotesPage({ id }: { id?: string }) {
  const { s, go } = useTeam()
  const [draft, setDraft] = useState<Note>()
  const notes = s.notes.filter(n => !n.deleted).sort((a, b) => b.date - a.date)
  const cur = draft ?? notes.find(n => n.id === id) ?? notes[0]
  const add = () => setDraft({ id: uid(), teamId: s.team!.id, kind: 'scrim', title: '', date: Date.now(), text: '', bookmarks: [], author: s.me!.id, updatedAt: Date.now() })
  return (
    <div className="tm-notes-page">
      <aside className="tm-notes-list">
        <button className="ut-btn primary" onClick={add}><TI name="plus" size={15} /> New note</button>
        <VirtualRows items={notes} rowH={70} gap={6} render={n => (
          <button key={n.id} className={`tm-nrow ${cur?.id === n.id ? 'on' : ''}`} onClick={() => { setDraft(undefined); go({ page: 'notes', id: n.id }) }}>
            <span className={`tm-nkind ${n.kind}`}>{KIND[n.kind]}</span>
            <span className="tm-nrow-main"><b>{n.title || 'Untitled'}</b><span className="muted small">{day(n.date)}{n.map && `, ${mapName(n.map)}`}{n.opponent && ` vs. ${n.opponent}`}</span></span>
            {n.result && <span className="tm-result">{n.result}</span>}
            {n.bookmarks.length > 0 && <span className="tm-srow-meta" title="Rounds to review"><TI name="flag" size={13} />{n.bookmarks.length}</span>}
          </button>
        )} empty={<div className="ut-empty small">No notes yet. Write down what happened in your last scrim.</div>} />
      </aside>
      {cur ? <NoteEditor key={cur.id} note={cur} isNew={!!draft} onDone={id => { setDraft(undefined); go({ page: 'notes', id }) }} /> : <div className="ut-empty pad">Pick a note or create one.</div>}
    </div>
  )
}

function NoteEditor({ note, isNew, onDone }: { note: Note; isNew: boolean; onDone: (id?: string) => void }) {
  const { s, matches, run, openDemo, notify } = useTeam()
  const [d, setD] = useState(note)
  const [bm, setBm] = useState({ demo: '', round: '', sec: '', label: '' })
  const can = isNew || note.author === s.me?.id || isAdmin(s)
  const dirty = isNew || JSON.stringify(d) !== JSON.stringify(note)
  const upd = (p: Partial<Note>) => setD(x => ({ ...x, ...p }))
  const save = () => run(team.saveNote(d), 'Note saved').then(ok => ok && onDone(d.id))

  const addBm = async () => {
    const m = matches.find(x => x.id === bm.demo), round = Math.max(1, Number(bm.round) || 1)
    if (!m) return
    let tick = 0 // 0 = Rundenbeginn (das Replay springt auf den Start der Runde)
    if (bm.sec) {
      try { const md = await api.loadMatch(m.id), r = md.rounds[Math.min(md.rounds.length, round) - 1]; tick = r.freezeEndTick + Math.round(Number(bm.sec) * md.tickrate) }
      catch (e) { return notify(`Could not read the demo: ${errText(e)}`, true) }
    }
    const b: Bookmark = { demoKey: m.id, demoName: m.fileName, round, tick, label: bm.label.trim() || `Round ${round}` }
    upd({ bookmarks: [...d.bookmarks, b] }); setBm({ ...bm, round: '', sec: '', label: '' })
  }

  return (
    <div className="tm-note">
      <div className="tm-note-head">
        <div className="ut-seg small">{(Object.keys(KIND) as Note['kind'][]).map(k => <button key={k} className={d.kind === k ? 'on' : ''} disabled={!can} onClick={() => upd({ kind: k })}>{KIND[k]}</button>)}</div>
        <span className="muted small">by {nameOf(s, d.author)}</span>
        <div className="tm-book-actions">
          {can && !isNew && <button className="ut-btn ghost danger" onClick={() => confirm(`Delete “${note.title || 'this note'}”?`) && run(team.saveNote({ ...note, deleted: true }), 'Note deleted').then(ok => ok && onDone())}><TI name="trash" size={15} /> Delete</button>}
          {can && <button className="ut-btn primary" disabled={!dirty} onClick={save}><Icon name="check" size={16} /> {dirty ? 'Save' : 'Saved'}</button>}
        </div>
      </div>
      <input className="ut-input big" value={d.title} readOnly={!can} onChange={e => upd({ title: e.target.value })} placeholder={d.kind === 'review' ? 'Playlist name, e.g. Pistol rounds' : 'e.g. Scrim vs. Orbit'} maxLength={60} />
      <div className="tm-note-props">
        <label className="tm-field"><span>Date</span><input className="ut-input" type="date" readOnly={!can} value={new Date(d.date - new Date(d.date).getTimezoneOffset() * 60e3).toISOString().slice(0, 10)} onChange={e => e.target.valueAsNumber && upd({ date: e.target.valueAsNumber })} /></label>
        <label className="tm-field"><span>Map</span><select className="ut-select" disabled={!can} value={d.map ?? ''} onChange={e => upd({ map: e.target.value || undefined })}><option value="">–</option>{poolOf(s).map(p => <option key={p.map} value={p.map}>{mapName(p.map)}</option>)}</select></label>
        {d.kind !== 'review' && <>
          <label className="tm-field"><span>Opponent</span><input className="ut-input" readOnly={!can} value={d.opponent ?? ''} onChange={e => upd({ opponent: e.target.value || undefined })} maxLength={32} /></label>
          <label className="tm-field small"><span>Result</span><input className="ut-input" readOnly={!can} value={d.result ?? ''} onChange={e => upd({ result: e.target.value || undefined })} placeholder="13:9" maxLength={7} /></label>
        </>}
      </div>
      <textarea className="ut-book-notes tm-note-text" readOnly={!can} value={d.text} onChange={e => upd({ text: e.target.value })} placeholder="What worked, what did not, what we practise next" />

      <section className="tm-sec">
        <h3><TI name="flag" size={17} /> Rounds to review</h3>
        {!d.bookmarks.length && <div className="ut-empty small">No rounds yet. Pick an imported demo and a round below.</div>}
        <ol className="tm-bms">
          {d.bookmarks.map((b, i) => {
            const m = matchForKey(matches, b.demoKey)
            return (
              <li key={i} className={m ? '' : 'missing'}>
                <span className="tm-bm-n">{i + 1}</span>
                <span className="tm-bm-main"><b>{b.label}</b><span className="muted small">Round {b.round}, {b.demoName}</span></span>
                {m ? <>
                  <button className="ut-btn small" onClick={() => openDemo(m.id, b.round, b.tick, 'replay')} title="Open in the 2D replay"><Icon name="replay" size={14} /> 2D</button>
                  <button className="ut-btn small" onClick={() => openDemo(m.id, b.round, b.tick, 'replay3d')} title="Open in the 3D replay"><Icon name="cube" size={14} /> 3D</button>
                </> : <span className="muted small" title="Import this demo on this PC to watch it">Not on this PC</span>}
                {can && <button className="ut-icon-btn" onClick={() => upd({ bookmarks: d.bookmarks.filter((_, k) => k !== i) })} title="Remove"><Icon name="x" size={14} /></button>}
              </li>
            )
          })}
        </ol>
        {can && (
          <div className="tm-bm-add">
            <select className="ut-select" value={bm.demo} onChange={e => setBm({ ...bm, demo: e.target.value })}>
              <option value="">{matches.length ? 'Pick an imported demo…' : 'No demos imported on this PC'}</option>
              {[...matches].sort((a, b) => b.parsedAt.localeCompare(a.parsedAt)).map(m => <option key={m.id} value={m.id}>{mapName(m.map)}: {m.teams.map(t => m.finalScore[t]).join(':')}, {m.fileName}</option>)}
            </select>
            <input className="ut-input" type="number" min={1} max={60} value={bm.round} onChange={e => setBm({ ...bm, round: e.target.value })} placeholder="Round" />
            <input className="ut-input" type="number" min={0} max={200} value={bm.sec} onChange={e => setBm({ ...bm, sec: e.target.value })} placeholder="Second" title="Seconds after the freeze time (optional)" />
            <input className="ut-input" value={bm.label} onChange={e => setBm({ ...bm, label: e.target.value })} placeholder="What to look at" maxLength={50} />
            <button className="ut-btn" disabled={!bm.demo} onClick={addBm}><TI name="plus" size={14} /> Add round</button>
          </div>
        )}
      </section>
    </div>
  )
}
