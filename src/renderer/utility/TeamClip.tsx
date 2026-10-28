// Utility-Dashboard, Team-Lineups: Clip abspielen (einmal laden, dann lokal), hinzufügen/ersetzen (Datei → zuschneiden → in der App
// verkleinern → hochladen) und die Speicheranzeige des Teams (Warnung ab 80 %).
import { useEffect, useRef, useState } from 'react'
import type { Lineup } from '../../shared/utility'
import { fixDuration, makeTestVideo, MAX_CLIP_S, shrinkClip } from '../team/clips/shrink'
import { Icon } from '../icons'
import { Modal, fmtBytes, useUtil } from './ui'

const errText = (e: unknown) => String((e as Error)?.message ?? e)
const mb = (n: number) => `${Math.round(n / 2 ** 20)} MB`
const sec = (n: number) => `${n.toFixed(1)} s`

export function StorageMeter({ s }: { s?: { bytes: number; limit: number } }) {
  if (!s) return <div className="ut-storage muted">Checking team storage…</div>
  const p = s.bytes / s.limit
  return (
    <div className={`ut-storage ${p >= 0.8 ? 'warn' : ''}`}>
      <div className="ut-storage-bar"><i style={{ width: `${Math.min(100, p * 100)}%` }} /></div>
      <span>{s.bytes ? fmtBytes(s.bytes) : '0 MB'} of {mb(s.limit)} team storage used{p >= 0.8 ? ' · almost full, delete old clips' : ''}</span>
    </div>
  )
}

/** Clip eines Team-Lineups (Detailseite, Editor); lokale Lineups: nichts */
export function TeamClip({ l }: { l: Lineup }) {
  const { team, notify } = useUtil()
  const clip = team.state.clips[l.id]
  const [shown, setShown] = useState<{ path: string; url: string }>()
  const [loading, setLoading] = useState(false)
  const [dlg, setDlg] = useState(false)
  if (l.owner === 'local') return null
  const play = () => {
    if (!clip) return
    setLoading(true)
    team.store.clipUrl(clip).then(url => setShown({ path: clip.path, url }), e => notify(`Clip could not be loaded: ${errText(e)}`, true)).finally(() => setLoading(false))
  }
  return (
    <section className="ut-clip">
      <div className="ut-clip-head">
        <b><Icon name="replay" size={15} /> Team clip</b>
        {team.store.canEdit(l.id) && <button className="ut-btn small" onClick={() => setDlg(true)}><Icon name="upload" size={13} /> {clip ? 'Replace' : 'Add clip'}</button>}
      </div>
      {clip && shown?.path === clip.path && <video src={shown.url} controls autoPlay muted loop onLoadedMetadata={e => fixDuration(e.currentTarget)} />}
      {clip && shown?.path !== clip.path && (
        <button className="ut-clip-play" onClick={play} disabled={loading}>
          <span className="ut-clip-ico"><Icon name="replay" size={20} /></span>
          <span><b>{loading ? 'Loading…' : 'Play clip'}</b><small>{sec(clip.durationS)} · {fmtBytes(clip.bytes)} · downloads once, then plays from this PC</small></span>
        </button>
      )}
      {!clip && <p className="ut-clip-none">No clip yet. {team.store.canEdit(l.id) ? 'Add your own video of this throw (up to 60 s).' : ''}</p>}
      {dlg && <ClipDialog lineupId={l.id} onClose={() => setDlg(false)} />}
    </section>
  )
}

/** Datei wählen → Start/Ende → verkleinern (Echtzeit) → hochladen; selftest = eigenes Testvideo, Ausschnitt 1–5 s, Messwerte auf die Konsole */
export function ClipDialog({ lineupId, onClose, selftest }: { lineupId: string; onClose: () => void; selftest?: boolean }) {
  const { team, notify } = useUtil()
  const [file, setFile] = useState<{ blob: Blob; url: string; name: string }>()
  const [dur, setDur] = useState(0)
  const [range, setRange] = useState<[number, number]>([0, 0])
  const [phase, setPhase] = useState<'pick' | 'trim' | 'shrink' | 'upload' | 'done'>('pick')
  const [pct, setPct] = useState(0)
  const [storage, setStorage] = useState<{ bytes: number; limit: number }>()
  const [result, setResult] = useState<{ bytes: number; s: number; took: number; error?: string }>()
  const abort = useRef<AbortController>(undefined)
  const vid = useRef<HTMLVideoElement>(null)
  const busy = phase === 'shrink' || phase === 'upload'

  useEffect(() => { team.store.storage().then(setStorage, () => {}) }, [])
  useEffect(() => () => { abort.current?.abort(); if (file) URL.revokeObjectURL(file.url) }, [file])
  const pick = (blob: Blob, name: string) => { setFile({ blob, url: URL.createObjectURL(blob), name }); setResult(undefined); setPhase('trim') }
  const meta = (v: HTMLVideoElement) => {
    if (v.duration === Infinity) { fixDuration(v); return } // durationchange kommt danach
    if (!Number.isFinite(v.duration) || dur) return
    setDur(v.duration); setRange(selftest ? [1, Math.min(5, v.duration)] : [0, Math.min(v.duration, MAX_CLIP_S)])
  }
  const setPoint = (i: 0 | 1, t: number) => {
    const r: [number, number] = [...range]
    r[i] = Math.max(0, Math.min(dur, t))
    if (i === 0 && r[1] - r[0] > MAX_CLIP_S) r[1] = r[0] + MAX_CLIP_S
    if (i === 1 && r[1] - r[0] > MAX_CLIP_S) r[0] = r[1] - MAX_CLIP_S
    if (r[1] <= r[0]) r[i === 0 ? 1 : 0] = i === 0 ? Math.min(dur, r[0] + 1) : Math.max(0, r[1] - 1)
    setRange(r)
    if (vid.current) vid.current.currentTime = r[i]
  }

  async function go() {
    if (!file) return
    abort.current = new AbortController()
    setPhase('shrink'); setPct(0)
    const t0 = performance.now()
    let out: { blob: Blob; durationS: number } | undefined
    try {
      out = await shrinkClip(file.blob, range[0], range[1], setPct, abort.current.signal)
      const took = (performance.now() - t0) / 1000
      setResult({ bytes: out.blob.size, s: out.durationS, took })
      if (selftest) console.warn(`clip-selftest: in ${file.blob.size} B ${sec(dur)}, cut ${range.join('-')} s → out ${out.blob.size} B ${sec(out.durationS)} (${(out.blob.size * 8 / out.durationS / 1e6).toFixed(2)} Mbit/s), shrink took ${took.toFixed(1)} s`)
      if (storage && storage.bytes + out.blob.size > storage.limit) throw new Error('Team storage is full (800 MB). Delete old clips first.')
      setPhase('upload')
      await team.store.uploadClip(lineupId, out.blob, out.durationS)
      setPhase('done')
      notify('Clip uploaded for your team')
      team.store.storage().then(setStorage, () => {})
    } catch (e) {
      setPhase('trim')
      if ((e as Error)?.name === 'AbortError') return
      if (out) setResult(r => r && { ...r, error: errText(e) })
      if (selftest) console.warn(`clip-selftest: ${errText(e)}`)
      else notify(errText(e), true)
    }
  }
  // Selbsttest: Testvideo erzeugen (6 s, 1080p, 8 Mbit/s), dann wie ein Klick auf „Shrink & upload“
  useEffect(() => { if (selftest) makeTestVideo(6).then(b => pick(b, 'testvideo.webm')) }, [])
  useEffect(() => { if (selftest && phase === 'trim' && dur && !result) void go() }, [dur, phase])

  const len = range[1] - range[0], close = () => { if (!busy || confirm('Stop this clip?')) onClose() }
  return (
    <Modal title={<><Icon name="replay" size={18} /> Team clip</>} onClose={close} foot={<>
      <StorageMeter s={storage} />
      <button className="ut-btn" onClick={close}>{phase === 'done' ? 'Close' : 'Cancel'}</button>
      {phase !== 'done' && <button className="ut-btn primary" disabled={!file || busy || len <= 0} onClick={go}><Icon name="upload" size={15} /> Shrink & upload</button>}
    </>}>
      {!file && (
        <label className="ut-clip-pick" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) pick(f, f.name) }}>
          <Icon name="upload" size={26} />
          <b>Choose a video of this throw</b>
          <small>Any length; you cut out up to {MAX_CLIP_S} s. The app shrinks it to 720p without sound (about 7 MB per minute).</small>
          <input type="file" accept="video/*" hidden onChange={e => { const f = e.target.files?.[0]; if (f) pick(f, f.name) }} />
        </label>
      )}
      {file && (
        <div className="ut-clip-edit">
          <video ref={vid} src={file.url} muted controls={!busy} onLoadedMetadata={e => meta(e.currentTarget)} onDurationChange={e => meta(e.currentTarget)} />
          <div className="ut-clip-range">
            {([0, 1] as const).map(i => (
              <label key={i}>
                <span>{i ? 'End' : 'Start'} <b>{sec(range[i])}</b></span>
                <input type="range" min={0} max={dur || 1} step={0.1} value={range[i]} disabled={busy || !dur} onChange={e => setPoint(i, Number(e.target.value))} />
                <button className="ut-btn small" disabled={busy || !dur} onClick={() => vid.current && setPoint(i, vid.current.currentTime)}>Use current frame</button>
              </label>
            ))}
            <p className={len > MAX_CLIP_S ? 'bad' : 'muted'}>{file.name} · clip length {sec(len)} (max {MAX_CLIP_S} s) · about {fmtBytes(len * 1e6 / 8 + 50e3)}</p>
          </div>
          {busy && (
            <div className="ut-clip-progress">
              <span>{phase === 'shrink' ? `Shrinking… ${Math.round(pct * 100)} % (runs in real time)` : 'Uploading…'}</span>
              <div className="ut-storage-bar"><i style={{ width: `${phase === 'shrink' ? pct * 100 : 100}%` }} /></div>
              {phase === 'shrink' && <button className="ut-link small" onClick={() => abort.current?.abort()}>Stop</button>}
            </div>
          )}
          {result && (
            <p className={`ut-clip-result ${result.error ? 'bad' : ''}`}>
              <Icon name={result.error ? 'x' : 'check'} size={15} /> Shrunk to {fmtBytes(result.bytes)} ({sec(result.s)}, was {fmtBytes(file.blob.size)}) in {sec(result.took)}
              {result.error ? <> · upload failed: {result.error}</> : phase === 'done' ? ' · uploaded' : ''}
            </p>
          )}
        </div>
      )}
    </Modal>
  )
}
