// Utility-Dashboard „Add lineup“ / Bearbeiten: Map → Granate + Seite → Stand und Ziel aufs Radar klicken → Technik → Titel, fertig.
// Alles Weitere (Schritte, Bilder, Video, Quelle, Tags, Zusatzfelder, Blickwinkel) ist optional im letzten Schritt.
import { useEffect, useState } from 'react'
import type { Lineup } from '../../shared/utility'
import { BUILTIN_TECHNIQUES, MAX_IMAGES, isWebUrl, parseLibrary } from '../../shared/utility-lib'
import { api } from '../api'
import { Icon } from '../icons'
import { GenerateImages } from './capture/GenerateImages'
import { POOL, TYPES, fromRadar, imageUrl, isLower, lowerMax, mapColor, mapName, radarUrl, suggestTitle, toRadar } from './maps'
import { addTechnique, saveLineup } from './ops'
import { Radar } from './Radar'
import { NewTag } from './tags'
import { TeamClip } from './TeamClip'
import { Seg, StandMarker, TargetMarker, Throw, TypeIcon, useUtil, type Draft, type Route } from './ui'

const STEPS = ['Map', 'Grenade', 'Position', 'Technique', 'Details']
const GROUPS: [string, string[]][] = [['Movement', ['stand', 'walk', 'run', 'crouch']], ['Jump', ['jumpthrow', 'wjumpthrow']], ['Mouse', ['left', 'right', 'both']]]
const ONE_OF = [['stand', 'walk', 'run'], ['jumpthrow', 'wjumpthrow'], ['left', 'right', 'both']]
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function Editor({ draft: initial, isNew, step: s0, back }: { draft: Draft; isNew: boolean; step?: number; back: Route }) {
  const { lib, maps, update, go, notify } = useUtil()
  const [d, setD] = useState<Draft>(initial)
  const [step, setStep] = useState(s0 ?? (isNew ? (initial.map ? 2 : 1) : 5))
  const [placing, setPlacing] = useState<'stand' | 'target'>(initial.stand ? 'target' : 'stand')
  const meta = maps.meta[d.map]
  const [lower, setLower] = useState(() => isLower(meta, initial.stand?.z))
  const [busy, setBusy] = useState(false)
  const [newTech, setNewTech] = useState('')
  const set = (p: Partial<Draft>) => setD(x => ({ ...x, ...p }))
  const suggestion = d.map ? suggestTitle(d.map, d.type, d.stand, d.target) : ''
  const placed = !!(d.stand && d.target)
  const reach = [true, true, !!d.map, !!d.map, !!d.map && placed, !!d.map && placed]
  const changed = JSON.stringify(d) !== JSON.stringify(initial)
  // neuer Lineup: Titelvorschlag eintragen, sobald Stand und Ziel feststehen (danach frei änderbar)
  useEffect(() => { if (step === 5 && isNew && !d.title) set({ title: suggestion }) }, [step])

  const leave = () => { if (!changed || confirm('Discard your changes?')) go(back) }
  const save = () => {
    if (!d.map || !d.stand || !d.target) return
    const l: Lineup = { ...d, map: d.map, stand: d.stand, target: d.target, title: d.title.trim() || suggestion, description: d.description?.trim() || undefined, steps: d.steps.map(s => s.trim()).filter(Boolean),
      fields: d.fields && Object.keys(d.fields).length ? Object.fromEntries(Object.entries(d.fields).filter(([k]) => k.trim())) : undefined }
    try { parseLibrary({ version: 1, lineups: [l], tags: [], playbooks: [], techniques: [] }) } catch (e) { notify(`Cannot save: ${errText(e)}`, true); return }
    update(x => saveLineup(x, l))
    notify(isNew ? 'Lineup added' : 'Lineup saved')
    go(back.page === 'lineup' && back.id === l.id ? back : { page: 'lineup', id: l.id, back })
  }
  // Klick ins Radar: Stand, dann Ziel. Nur vom Radar ist z unbekannt; auf der unteren Ebene steht z knapp unter deren Obergrenze
  // (nur Ebenen-Hinweis für Radar und 3D-Vorschau, keine echte Höhe)
  const pick = (px: number, py: number) => {
    const p = { ...fromRadar(meta, px, py), ...(lower && lowerMax(meta) != null ? { z: lowerMax(meta)! - 1 } : {}) }
    set({ [placing]: p })
    if (placing === 'stand' && !d.target) setPlacing('target')
  }
  const addImages = async (paths?: string[]) => {
    if (d.images.length >= MAX_IMAGES) return notify(`Up to ${MAX_IMAGES} images per lineup`, true)
    setBusy(true)
    try {
      const r = await api.utilityAddImages(paths)
      if (r.errors.length) notify(r.errors.join(' · '), true)
      setD(x => ({ ...x, images: [...new Set([...x.images, ...r.hashes])].slice(0, MAX_IMAGES) }))
    } catch (e) { notify(errText(e), true) } finally { setBusy(false) }
  }
  const pasteImages = async (files: File[]) => {
    setBusy(true)
    try {
      for (const f of files) { const h = await api.utilityAddImageData(new Uint8Array(await f.arrayBuffer())); setD(x => ({ ...x, images: [...new Set([...x.images, h])].slice(0, MAX_IMAGES) })) }
    } catch (e) { notify(errText(e), true) } finally { setBusy(false) }
  }
  const addVideo = async (path?: string) => {
    try { const name = await api.utilityAddVideo(path); if (name) set({ video: { ...d.video, local: name } }) } catch (e) { notify(errText(e), true) }
  }
  const tech = [...BUILTIN_TECHNIQUES, ...lib.techniques]
  // je Gruppe eins (Stand/Walk/Run, Jumpthrow oder W + Jumpthrow, eine Maustaste; Crouch passt zu allem); W + Jumpthrow ist schon die Bewegung
  const toggleTech = (id: string) => {
    if (d.technique.includes(id)) return set({ technique: d.technique.filter(t => t !== id) })
    const drop = [...(ONE_OF.find(ids => ids.includes(id)) ?? []), ...(id === 'wjumpthrow' ? ONE_OF[0] : [])]
    set({ technique: [...d.technique.filter(t => !drop.includes(t)), id] })
  }
  const fields = Object.entries(d.fields ?? {})
  const setFields = (list: [string, string][]) => set({ fields: Object.fromEntries(list) })
  const urlBad = (u?: string) => !!u && !isWebUrl(u)

  return (
    <div className="ut-editor" onPaste={e => { const f = [...e.clipboardData.files].filter(x => x.type.startsWith('image/')); if (f.length && step === 5) { e.preventDefault(); pasteImages(f) } }}>
      <div className="ut-editor-head">
        <button className="ut-icon-btn big" onClick={leave} title="Back"><Icon name="arrow" className="flip" /></button>
        <h1>{isNew ? 'Add lineup' : 'Edit lineup'}{d.map && <span> · {mapName(d.map)}</span>}</h1>
        <ol className="ut-stepper">
          {STEPS.map((s, i) => (
            <li key={s} className={`${step === i + 1 ? 'on' : ''} ${step > i + 1 || (!isNew && reach[i + 1]) ? 'done' : ''}`}>
              <button disabled={!reach[i + 1]} onClick={() => setStep(i + 1)}><span>{i + 1}</span>{s}</button>
            </li>
          ))}
        </ol>
      </div>

      <div className={`ut-editor-body step${step}`}>
        {step === 1 && (
          <div className="ut-pickmap">
            <h2>Which map?</h2>
            <div className="ut-pickmap-grid">
              {[...POOL, ...maps.radars.filter(r => !r.endsWith('_lower') && !POOL.includes(r))].filter(m => maps.meta[m] && maps.radars.includes(m)).map(m => (
                <button key={m} className={`ut-pickmap-tile ${d.map === m ? 'on' : ''} ${POOL.includes(m) ? '' : 'other'}`} style={{ '--m': mapColor(m) } as React.CSSProperties}
                  onClick={() => { if (m !== d.map) set({ map: m, stand: undefined, target: undefined }); setPlacing('stand'); setLower(false); setStep(2) }}>
                  <img src={radarUrl(m)} alt="" loading="lazy" decoding="async" /><span>{mapName(m)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="ut-picktype">
            <h2>Which grenade?</h2>
            <div className="ut-picktype-grid">
              {TYPES.map(t => (
                <button key={t.id} className={`ut-picktype-btn ${d.type === t.id ? 'on' : ''}`} onClick={() => set({ type: t.id })}>
                  <TypeIcon type={t.id} size={56} /><span>{t.label}</span>
                </button>
              ))}
            </div>
            <h2>Which side?</h2>
            <Seg value={d.side} options={[['T', 'Terrorist'], ['CT', 'Counter-Terrorist'], ['both', 'Both']]} onChange={side => set({ side })} />
          </div>
        )}

        {step === 3 && meta && (
          <div className="ut-place">
            <div className="ut-place-side">
              <h2>Where?</h2>
              <p className="muted">Click the radar: first where you <b>stand</b>, then where the grenade <b>lands</b>. Click again to move a point. Mouse wheel zooms.</p>
              <button className={`ut-place-btn stand ${placing === 'stand' ? 'on' : ''} ${d.stand ? 'set' : ''}`} onClick={() => setPlacing('stand')}>
                <span className={`ut-place-dot ${d.side}`} /> <span><b>1 · Stand here</b><small>{d.stand ? `${d.stand.x}, ${d.stand.y}` : 'Not set'}</small></span>
              </button>
              <button className={`ut-place-btn target ${placing === 'target' ? 'on' : ''} ${d.target ? 'set' : ''}`} onClick={() => setPlacing('target')}>
                <TypeIcon type={d.type} size={22} /> <span><b>2 · Lands here</b><small>{d.target ? `${d.target.x}, ${d.target.y}` : 'Not set'}</small></span>
              </button>
              {(lowerMax(meta) != null && maps.radars.includes(`${d.map}_lower`)) && (
                <><h4>Level</h4><Seg value={lower ? 'lower' : 'upper'} options={[['upper', 'Upper'], ['lower', 'Lower']]} onChange={v => setLower(v === 'lower')} /></>
              )}
              {d.demo && <p className="muted small">Positions come from a demo with exact height. Moving a point keeps only the radar position.</p>}
            </div>
            <div className="ut-radar-wrap">
              <Radar map={d.map} lower={lower} onPick={pick}>
                {s => {
                  const a = d.stand && toRadar(meta, d.stand), b = d.target && toRadar(meta, d.target)
                  return <>
                    {a && b && <Throw a={a} b={b} s={s} active />}
                    {b && <TargetMarker x={b.x} y={b.y} type={d.type} side={d.side} s={s * 1.2} active={placing === 'target'} />}
                    {a && <StandMarker x={a.x} y={a.y} side={d.side} s={s * 1.3} active={placing === 'stand'} />}
                  </>
                }}
              </Radar>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="ut-tech">
            <h2>How is it thrown?</h2>
            {GROUPS.map(([g, ids]) => (
              <div key={g} className="ut-tech-group">
                <h4>{g}</h4>
                <div className="ut-chips">{ids.map(id => <button key={id} className={`ut-chip big ${d.technique.includes(id) ? 'on' : ''}`} onClick={() => toggleTech(id)}>{tech.find(t => t.id === id)?.label}</button>)}</div>
              </div>
            ))}
            <div className="ut-tech-group">
              <h4>Your own</h4>
              <div className="ut-chips">
                {lib.techniques.map(t => <button key={t.id} className={`ut-chip big ${d.technique.includes(t.id) ? 'on' : ''}`} onClick={() => toggleTech(t.id)}>{t.label}</button>)}
                <input className="ut-input small" placeholder="Add your own…" value={newTech} maxLength={40} onChange={e => setNewTech(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && newTech.trim()) { const r = addTechnique(lib, newTech); update(() => r.lib); if (!d.technique.includes(r.id)) set({ technique: [...d.technique, r.id] }); setNewTech('') } }} />
              </div>
            </div>
          </div>
        )}

        {step === 5 && (
          <div className="ut-details">
            <div className="ut-details-main">
              <label className="ut-field big"><span>Title</span>
                <input className="ut-input big" value={d.title} placeholder={suggestion} maxLength={200} onChange={e => set({ title: e.target.value })} autoFocus={isNew} />
              </label>
              <label className="ut-field"><span>Short description</span>
                <input className="ut-input" value={d.description ?? ''} placeholder="e.g. Blocks the CT view from window, use on a B execute" maxLength={200} onChange={e => set({ description: e.target.value })} />
              </label>
              <div className="ut-optional"><span>Optional</span></div>

              <div className="ut-field"><span>Steps</span>
                {d.steps.map((s, i) => (
                  <div key={i} className="ut-steprow">
                    <b>{i + 1}</b>
                    <input className="ut-input" value={s} maxLength={2000} placeholder="e.g. Stand in the corner next to the barrel" onChange={e => set({ steps: d.steps.map((x, j) => (j === i ? e.target.value : x)) })} />
                    <button className="ut-icon-btn" title="Remove step" onClick={() => set({ steps: d.steps.filter((_, j) => j !== i) })}><Icon name="x" size={14} /></button>
                  </div>
                ))}
                {d.steps.length < 50 && <button className="ut-link small" onClick={() => set({ steps: [...d.steps, ''] })}>+ Add step</button>}
              </div>

              <div className="ut-field"><span>Images <small>{d.images.length}/{MAX_IMAGES} · first image is the cover</small></span>
                <div className="ut-drop" tabIndex={0} onDragOver={e => e.preventDefault()}
                  onDrop={e => { e.preventDefault(); const p = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean); if (p.length) addImages(p) }}>
                  {d.images.map((h, i) => (
                    <div key={h} className="ut-drop-img">
                      <img src={imageUrl(h)} alt="" loading="lazy" decoding="async" />
                      {i > 0 && <button className="ut-drop-cover" title="Make cover" onClick={() => set({ images: [h, ...d.images.filter(x => x !== h)] })}><Icon name="star" size={12} /></button>}
                      <button className="ut-drop-x" title="Remove image" onClick={() => set({ images: d.images.filter(x => x !== h) })}><Icon name="x" size={12} /></button>
                    </div>
                  ))}
                  {d.images.length < MAX_IMAGES && (
                    <button className="ut-drop-add" disabled={busy} onClick={() => addImages()}>
                      <Icon name="upload" size={22} /><span>{busy ? 'Processing…' : 'Drop, paste (Ctrl+V) or browse'}</span>
                    </button>
                  )}
                  <GenerateImages l={d} variant="tile" onImages={images => set({ images })} />
                </div>
              </div>

              <div className="ut-field"><span>Video <small>link (opens in the browser) or a local file (mp4/webm up to 50 MB, only on this PC)</small></span>
                <div className="ut-row2">
                  <input className={`ut-input ${urlBad(d.video?.url) ? 'bad' : ''}`} placeholder="https://…" value={d.video?.url ?? ''} maxLength={2000} onChange={e => set({ video: { ...d.video, url: e.target.value || undefined } })} />
                  {d.video?.local
                    ? <span className="ut-localvid"><Icon name="replay" size={14} /> Local video <button className="ut-icon-btn" title="Remove local video" onClick={() => set({ video: d.video?.url ? { url: d.video.url } : undefined })}><Icon name="x" size={13} /></button></span>
                    : <button className="ut-btn" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) addVideo(api.pathForFile(f)) }} onClick={() => addVideo()}>Local file…</button>}
                </div>
              </div>

              {!isNew && d.owner !== 'local' && d.stand && d.target && <TeamClip l={{ ...d, stand: d.stand, target: d.target }} />}

              <label className="ut-field"><span>Source link <small>where you learned it (only a link)</small></span>
                <input className={`ut-input ${urlBad(d.sourceUrl) ? 'bad' : ''}`} placeholder="https://…" value={d.sourceUrl ?? ''} maxLength={2000} onChange={e => set({ sourceUrl: e.target.value || undefined })} />
              </label>
            </div>

            <div className="ut-details-side">
              <div className="ut-field"><span>Tags</span>
                <div className="ut-chips">
                  {lib.tags.filter(t => !t.deleted).map(t => (
                    <button key={t.id} className={`ut-chip ${d.tags.includes(t.id) ? 'on' : ''}`} style={{ '--c': t.color } as React.CSSProperties}
                      onClick={() => set({ tags: d.tags.includes(t.id) ? d.tags.filter(x => x !== t.id) : [...d.tags, t.id] })}><i />{t.name}</button>
                  ))}
                </div>
                <NewTag onCreate={id => setD(x => ({ ...x, tags: x.tags.includes(id) ? x.tags : [...x.tags, id] }))} />
              </div>
              <div className="ut-field"><span>Custom fields <small>e.g. “Timing” → “After 1:40”</small></span>
                {fields.map(([k, v], i) => (
                  <div key={i} className="ut-steprow">
                    <input className="ut-input small" value={k} placeholder="Name" maxLength={100} onChange={e => setFields(fields.map((f, j) => (j === i ? [e.target.value, f[1]] : f)))} />
                    <input className="ut-input" value={v} placeholder="Value" maxLength={2000} onChange={e => setFields(fields.map((f, j) => (j === i ? [f[0], e.target.value] : f)))} />
                    <button className="ut-icon-btn" title="Remove field" onClick={() => setFields(fields.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
                  </div>
                ))}
                <button className="ut-link small" onClick={() => setFields([...fields, [`Field ${fields.length + 1}`, '']])}>+ Add field</button>
              </div>
              <div className="ut-field"><span>Aim <small>view angle when throwing (CS2 degrees), needed to generate images</small></span>
                <div className="ut-row2">
                  <input className="ut-input small" type="number" step="0.1" placeholder="Pitch" value={d.aim?.pitch ?? ''} onChange={e => set({ aim: e.target.value === '' ? undefined : { pitch: Math.max(-90, Math.min(90, Number(e.target.value))), yaw: d.aim?.yaw ?? 0 } })} />
                  <input className="ut-input small" type="number" step="0.1" placeholder="Yaw" value={d.aim?.yaw ?? ''} onChange={e => set({ aim: e.target.value === '' ? undefined : { pitch: d.aim?.pitch ?? 0, yaw: Math.max(-360, Math.min(360, Number(e.target.value))) } })} />
                </div>
              </div>
              <label className="ut-field"><span>Author</span>
                <input className="ut-input" value={d.author ?? ''} maxLength={100} placeholder="Your name" onChange={e => set({ author: e.target.value || undefined })} />
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="ut-editor-foot">
        <button className="ut-btn" onClick={() => (step > 1 ? setStep(step - 1) : leave())}>{step > 1 ? 'Back' : 'Cancel'}</button>
        <span className="ut-editor-hint">{step === 3 && !placed ? (d.stand ? 'Now click where the grenade lands' : 'Click where you stand') : ''}</span>
        {step < 5 && <button className="ut-btn primary" disabled={!reach[step + 1]} onClick={() => setStep(step + 1)}>Next</button>}
        {(step === 5 || (!isNew && placed)) && <button className="ut-btn primary big" disabled={!placed || urlBad(d.video?.url) || urlBad(d.sourceUrl)} onClick={save}><Icon name="check" size={17} /> {isNew ? 'Save lineup' : 'Save changes'}</button>}
      </div>
    </div>
  )
}
