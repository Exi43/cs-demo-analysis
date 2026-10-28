// Taktik-Board auf dem Radar: Positionen, Pfeile, Laufwege, Zonen, Text, Freihand-Striche und die Startpositionen der Slots; Farbe je Slot.
// Zeichnen per Klick (Pfeil: 2 Klicks, Laufweg/Zone: Punkte setzen, letzten Punkt nochmal klicken oder Enter), Stift und Radierer
// mit gedrückter Maus, Rückgängig; Werkzeuge auch per Taste (Esc = Karte verschieben).
// shortcut: nur die obere Ebene (Nuke/Vertigo unten fehlt), erst nötig, wenn Berat Strats für untere Ebenen zeichnen will
import { useEffect, useRef, useState } from 'react'
import type { BoardItem, StratSlot } from '../../shared/team'
import { Radar } from '../utility/Radar'
import { fromRadar, toRadar } from '../utility/maps'
import { SLOT_COLORS, roleLabel, smoothStroke, touches } from './logic'
import { TI, useTeam } from './tui'

export interface BoardValue { board: BoardItem[]; slots: StratSlot[] }
type Tool = BoardItem['kind'] | 'start' | 'erase' | 'pen' | 'move'
type P = { x: number; y: number }
const TOOLS: [Tool, string, Parameters<typeof TI>[0]['name'], string][] = [
  ['move', 'Move and zoom the map', 'cursor', 'Esc'], ['start', 'Start position of the selected player', 'start', 'S'], ['pos', 'Position', 'pos', 'O'],
  ['arrow', 'Arrow (2 clicks)', 'arrow', 'A'], ['path', 'Route (click points, click the last one again to finish)', 'path', 'R'],
  ['zone', 'Zone (click corners, click the last one again)', 'zone', 'Z'], ['text', 'Text', 'text', 'T'],
  ['pen', 'Pen: hold the mouse button and draw', 'pen', 'P'], ['erase', 'Eraser: drag over drawings', 'erase', 'E'],
]
const NEUTRAL = '#f2f2f4'
/** Freihand-Strich = Laufweg mit label 'pen' (Vertrag bleibt gleich), gezeichnet als weiche Linie ohne Spitze */
const PEN = 'pen'
export const colorOf = (it: Pick<BoardItem, 'slot' | 'color'>) => (it.slot != null ? SLOT_COLORS[it.slot] : it.color ?? NEUTRAL)

export function Board({ map, value, onChange, slotFocus }: { map: string; value: BoardValue; onChange?: (v: BoardValue) => void; slotFocus?: { i: number; n: number } }) {
  const { maps } = useTeam()
  const meta = maps.meta[map]
  const [tool, setTool] = useState<Tool>('arrow')
  const [color, setColor] = useState(0)
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState<P[]>([])
  const [hist, setHist] = useState<BoardValue[]>([])
  const cur = useRef(value), live = useRef<SVGPolylineElement>(null), sc = useRef(1)
  cur.current = value // Stift/Radierer lesen den neuesten Stand (Strg+Z während des Ziehens)
  const edit = !!onChange
  useEffect(() => { if (slotFocus) { setColor(slotFocus.i); setTool('start') } }, [slotFocus?.n])

  const commit = (v: BoardValue) => { setHist(h => [...h.slice(-49), cur.current]); onChange?.(v) }
  const add = (it: BoardItem) => commit({ ...cur.current, board: [...cur.current.board, it] })
  const slotOf = color >= 0 ? color : undefined
  const choose = (t: Tool) => { setTool(t); setPending([]) }
  const finish = (pts = pending) => {
    const kind = tool as 'path' | 'zone'
    if (pts.length >= (kind === 'zone' ? 3 : 2)) add({ kind, pts, slot: slotOf })
    setPending([])
  }
  useEffect(() => {
    if (!edit) return
    const k = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return
      if (e.key === 'Escape') { if (pending.length) setPending([]); else setTool('move') }
      if (e.key === 'Enter') finish()
      if (e.key === 'z' && e.ctrlKey) undo()
      const t = !e.ctrlKey && !e.altKey && !e.metaKey && TOOLS.find(x => x[3] === e.key.toUpperCase())
      if (t) choose(t[0])
    }
    addEventListener('keydown', k); return () => removeEventListener('keydown', k)
  })
  const undo = () => { if (pending.length) return setPending(p => p.slice(0, -1)); const last = hist.at(-1); if (last) { setHist(h => h.slice(0, -1)); onChange?.(last) } }

  // Stift/Radierer: Ziehen mit gedrückter Maus. Punkte über das Rechteck in Radar-Pixel (stimmt bei Zoom/Verschieben);
  // der Strich wächst direkt im DOM, ohne React-Render je Mausbewegung
  const draw = (e: React.PointerEvent<SVGRectElement>) => {
    if (e.button !== 0 || !meta) return
    e.stopPropagation() // sonst verschiebt das Radar die Karte
    const el = e.currentTarget
    let px = 1 // Radar-Pixel je Bildschirm-Pixel
    const at = (m: { clientX: number; clientY: number }) => { const r = el.getBoundingClientRect(); px = 1024 / r.width; return { x: (m.clientX - r.left) * px, y: (m.clientY - r.top) * px } }
    let last = at(e), saved = false
    const pts = [last]
    const step = tool === 'pen'
      ? (p: P) => { if (Math.hypot(p.x - last.x, p.y - last.y) >= px) { pts.push((last = p)); live.current?.setAttribute('points', pts.map(q => `${q.x},${q.y}`).join(' ')) } }
      : (p: P) => {
          const v = cur.current, board = v.board.filter(it => !touches(it, it.pts.map(q => toRadar(meta, q)), last, p, 10 * px, sc.current))
          last = p
          if (board.length === v.board.length) return
          if (!saved) { saved = true; setHist(h => [...h.slice(-49), v]) } // ein Rückgängig-Schritt je Radier-Zug
          onChange?.((cur.current = { ...v, board }))
        }
    step(last)
    const move = (m: PointerEvent) => { const c = m.getCoalescedEvents(); (c.length ? c : [m]).forEach(x => step(at(x))) }
    const up = () => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up)
      if (tool !== 'pen') return
      live.current?.setAttribute('points', '')
      const out = smoothStroke(pts, px)
      if (out.length > 1) add({ kind: 'path', label: PEN, pts: out.map(p => fromRadar(meta, p.x, p.y)), slot: slotOf })
    }
    addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up)
  }

  const pick = (px: number, py: number) => {
    if (!meta) return
    const w = fromRadar(meta, px, py)
    if (tool === 'start') {
      if (color < 0 || !value.slots[color]) return
      commit({ ...value, slots: value.slots.map((sl, i) => (i === color ? { ...sl, start: w } : sl)) })
    } else if (tool === 'pos') add({ kind: 'pos', pts: [w], slot: slotOf })
    else if (tool === 'text') { if (label.trim()) add({ kind: 'text', pts: [w], label: label.trim(), slot: slotOf }) }
    else if (tool === 'arrow') { if (pending.length) { add({ kind: 'arrow', pts: [pending[0], w], slot: slotOf }); setPending([]) } else setPending([w]) }
    else if (tool === 'path' || tool === 'zone') {
      const last = pending.at(-1)
      if (last && Math.hypot(last.x - w.x, last.y - w.y) < meta.scale * 14) finish()
      else setPending(p => [...p, w])
    }
  }

  const free = edit && (tool === 'pen' || tool === 'erase')
  const ink = color >= 0 ? SLOT_COLORS[color] : NEUTRAL
  return (
    <div className={`tm-board ${edit ? 'edit' : ''}`}>
      {edit && (
        <div className="tm-tools">
          <div className="tm-toolset">
            {TOOLS.map(([t, title, icon, key]) => (
              <button key={t} className={tool === t ? 'on' : ''} title={`${title} (${key})`} aria-label={title} aria-keyshortcuts={key === 'Esc' ? 'Escape' : key} onClick={() => choose(t)}><TI name={icon} size={17} /></button>
            ))}
          </div>
          <div className="tm-swatches" role="group" aria-label="Colour = player">
            {SLOT_COLORS.map((c, i) => (
              <button key={c} className={color === i ? 'on' : ''} style={{ '--c': c } as React.CSSProperties} onClick={() => setColor(i)} disabled={!value.slots[i]}
                title={value.slots[i] ? `Player ${i + 1}: ${roleLabel(value.slots[i].role)}` : `Player ${i + 1} (add a player first)`}>{i + 1}</button>
            ))}
            <button className={color === -1 ? 'on' : ''} style={{ '--c': NEUTRAL } as React.CSSProperties} onClick={() => setColor(-1)} title="Neutral (team)">–</button>
          </div>
          {tool === 'text' && <input className="ut-input tm-label-input" placeholder="Text, then click the map" value={label} onChange={e => setLabel(e.target.value)} maxLength={40} />}
          <span className="tm-tools-hint">{hint(tool, pending.length, color, !!value.slots[color])}</span>
          <div className="tm-tools-end">
            {(tool === 'path' || tool === 'zone') && pending.length > 1 && <button className="ut-btn small" onClick={() => finish()}><TI name="plus" size={14} /> Finish</button>}
            <button className="ut-icon-btn" onClick={undo} disabled={!hist.length && !pending.length} title="Undo (Ctrl+Z)"><TI name="undo" size={17} /></button>
            <button className="ut-icon-btn" onClick={() => value.board.length && confirm('Clear all drawings?') && commit({ ...value, board: [] })} disabled={!value.board.length} title="Clear drawings"><TI name="trash" size={17} /></button>
          </div>
        </div>
      )}
      <div className="ut-radar-wrap tm-board-radar">
        <Radar map={map} onPick={edit && tool !== 'move' && !free ? pick : undefined}>
          {s => { sc.current = s; return meta && (
            <g>
              {value.board.map((it, i) => <Item key={i} it={it} pts={it.pts.map(p => toRadar(meta, p))} s={s} />)}
              {value.slots.map((sl, i) => sl.start && <Start key={i} p={toRadar(meta, sl.start)} n={i + 1} c={SLOT_COLORS[i]} s={s} />)}
              {pending.length > 0 && (
                <g className="tm-pending">
                  <polyline points={pending.map(p => { const r = toRadar(meta, p); return `${r.x},${r.y}` }).join(' ')} style={{ stroke: ink, strokeWidth: 2 * s }} />
                  {pending.map((p, i) => { const r = toRadar(meta, p); return <circle key={i} cx={r.x} cy={r.y} r={4 * s} /> })}
                </g>
              )}
              {tool === 'pen' && <polyline ref={live} className="tm-line" style={{ stroke: ink, strokeWidth: 3 * s }} />}
              {free && <rect width={1024} height={1024} className={`tm-draw ${tool}`} onPointerDown={draw} onDoubleClick={e => e.stopPropagation()} />}
            </g>
          ) }}
        </Radar>
      </div>
    </div>
  )
}

const hint = (t: Tool, n: number, color: number, hasSlot: boolean) =>
  t === 'start' ? (color >= 0 && hasSlot ? `Click where player ${color + 1} starts` : 'Pick a player colour first')
    : t === 'arrow' ? (n ? 'Click where it points to' : 'Click the start of the arrow')
      : t === 'path' || t === 'zone' ? (n ? `${n} point${n > 1 ? 's' : ''}. Click the last point again or press Enter` : `Click the first point of the ${t === 'path' ? 'route' : 'zone'}`)
        : t === 'erase' ? 'Drag over drawings to erase them' : t === 'pen' ? 'Hold the left mouse button and draw'
          : t === 'move' ? 'Drag to move the map, scroll to zoom' : t === 'text' ? 'Type the text, then click the map' : 'Click the map'

function Item({ it, pts, s }: { it: BoardItem; pts: P[]; s: number }) {
  const c = colorOf(it), line = pts.map(p => `${p.x},${p.y}`).join(' ')
  if (it.kind === 'pos') return <circle cx={pts[0].x} cy={pts[0].y} r={8 * s} style={{ fill: c, strokeWidth: 2.5 * s }} className="tm-pos" />
  if (it.kind === 'text') return <text x={pts[0].x} y={pts[0].y} className="tm-text" style={{ fill: c, fontSize: 15 * s, strokeWidth: 3.5 * s }}>{it.label}</text>
  if (it.kind === 'zone') return <polygon points={line} className="tm-zone" style={{ fill: c, stroke: c, strokeWidth: 2 * s, strokeDasharray: `${6 * s} ${4 * s}` }} />
  // Freihand: Kurve von Mitte zu Mitte, die Punkte dazwischen sind Kontrollpunkte
  if (it.label === PEN) {
    const mid = pts.slice(1, -1).map((q, i) => `Q${q.x},${q.y} ${(q.x + pts[i + 2].x) / 2},${(q.y + pts[i + 2].y) / 2}`).join('')
    return <path d={`M${pts[0].x},${pts[0].y}${mid}L${pts.at(-1)!.x},${pts.at(-1)!.y}`} className="tm-line" style={{ stroke: c, strokeWidth: 3 * s }} />
  }
  // Pfeil/Laufweg: Linie + Spitze am Ende
  const a = pts.at(-2) ?? pts[0], b = pts.at(-1)!, ang = Math.atan2(b.y - a.y, b.x - a.x), L = 13 * s, W = 7 * s
  const head = `${b.x},${b.y} ${b.x - L * Math.cos(ang) + W * Math.sin(ang)},${b.y - L * Math.sin(ang) - W * Math.cos(ang)} ${b.x - L * Math.cos(ang) - W * Math.sin(ang)},${b.y - L * Math.sin(ang) + W * Math.cos(ang)}`
  const dash = it.kind === 'path' ? { strokeDasharray: `${9 * s} ${6 * s}` } : {}
  return (
    <g>
      <polyline points={line} className="tm-line" style={{ stroke: c, strokeWidth: (it.kind === 'arrow' ? 4 : 3) * s, ...dash }} />
      <polygon points={head} style={{ fill: c }} />
    </g>
  )
}
const Start = ({ p, n, c, s }: { p: { x: number; y: number }; n: number; c: string; s: number }) => (
  <g className="tm-start" transform={`translate(${p.x} ${p.y}) scale(${s})`}><circle r={11} style={{ fill: c }} /><text dy={4}>{n}</text></g>
)
