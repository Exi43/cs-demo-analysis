import { useEffect, useState } from 'react'
import type { MatchSummary } from '../../shared/model'
import { api } from '../api'
import { mapLabel } from '../format'

export function Library({ onOpen, onAnalyze }: { onOpen: (id: string) => void; onAnalyze: (ids: string[]) => void }) {
  const [list, setList] = useState<MatchSummary[]>([])
  const [sel, setSel] = useState<Set<string>>(new Set())
  const selMaps = new Set(list.filter(m => sel.has(m.id)).map(m => m.map))
  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const [busy, setBusy] = useState<{ file: string; pct: number; msg: string } | null>(null)
  const [queue, setQueue] = useState<string[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [drag, setDrag] = useState(false)

  const refresh = () => api.listMatches().then(l => setList(l.sort((a, b) => b.parsedAt.localeCompare(a.parsedAt))))
  useEffect(() => { refresh(); return api.onProgress(setBusy) }, [])

  async function importFiles(files: string[]) {
    setQueue(q => [...q, ...files])
    for (const f of files) {
      try { await api.importDemo(f) } catch (e: any) { setErrors(er => [...er, `${f.split(/[\\/]/).pop()}: ${e.message}`]) }
      setQueue(q => q.filter(x => x !== f))
      refresh()
    }
    setBusy(null)
  }

  return (
    <div className="library"
      onDragOver={e => { e.preventDefault(); setDrag(true) }}
      onDragLeave={() => setDrag(false)}
      onDrop={e => {
        e.preventDefault(); setDrag(false)
        importFiles([...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(p => /\.(dem|gz|zst|zip)$/i.test(p)))
      }}>
      <div className={`drop ${drag ? 'over' : ''}`} onClick={async () => importFiles(await api.pickDemos())}>
        <div className="drop-big">Drop demos here</div>
        <div className="muted">or click to browse · .dem, .zip, .dem.gz, .dem.zst · multiple files at once</div>
        {queue.length > 0 && (
          <div className="progress">
            <div className="bar"><div style={{ width: `${busy?.pct ?? 0}%` }} /></div>
            <div className="small">{busy ? `${busy.file.split(/[\\/]/).pop()}: ${busy.msg}` : 'Starting…'} · {queue.length} left in queue</div>
          </div>
        )}
      </div>
      {errors.map((e, i) => <div key={i} className="error">{e}</div>)}

      <div className="lib-actions">
        <button className={sel.size >= 2 && selMaps.size === 1 ? 'on' : ''} disabled={sel.size < 2 || selMaps.size !== 1}
          onClick={() => onAnalyze([...sel])}>Analyze selected together ({sel.size})</button>
        <span className="muted small">
          {selMaps.size > 1 ? 'Please select demos of the same map only.' : 'Tick several demos of the same map, e.g. all Mirage matches of one opponent.'}
        </span>
      </div>

      <table className="matches">
        <thead><tr><th /><th>Map</th><th>Teams</th><th>Score</th><th>Rounds</th><th>File</th><th>Imported</th><th /></tr></thead>
        <tbody>
          {list.map(m => (
            <tr key={m.id} onClick={() => onOpen(m.id)}>
              <td onClick={e => e.stopPropagation()}><input type="checkbox" checked={sel.has(m.id)} onChange={() => toggle(m.id)} /></td>
              <td><b>{mapLabel(m.map)}</b></td>
              <td>{m.teams.join(' vs ')}</td>
              <td>{m.teams.map(t => m.finalScore[t]).join(' : ')}</td>
              <td>{m.rounds}</td>
              <td className="muted small">{m.fileName}</td>
              <td className="muted small">{new Date(m.parsedAt).toLocaleString('en-GB')}</td>
              <td><button className="ghost" onClick={async e => { e.stopPropagation(); if (confirm('Delete match?')) { await api.deleteMatch(m.id); refresh() } }}>🗑</button></td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={8} className="muted center">No demos imported yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}
