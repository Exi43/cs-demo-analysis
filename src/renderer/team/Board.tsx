// Taktik-Board auf dem Radar: Positionen, Pfeile, Laufwege, Zonen, Text und die Startpositionen der Slots; Farbe je Slot.
// Zeichnen per Klick (Pfeil: 2 Klicks, Laufweg/Zone: Punkte setzen, letzten Punkt nochmal klicken oder Enter), Löschen, Rückgängig.
// shortcut: nur die obere Ebene (Nuke/Vertigo unten fehlt), erst nötig, wenn Berat Strats für untere Ebenen zeichnen will
import { useEffect, useState } from 'react'
import type { BoardItem, StratSlot } from '../../shared/team'
import { Radar } from '../utility/Radar'
import { fromRadar, toRadar } from '../utility/maps'
import { SLOT_COLORS, roleLabel } from './logic'
import { TI, useTeam } from './tui'

export interface BoardValue { board: BoardItem[]; slots: StratSlot[] }
type Tool = BoardItem['kind'] | 'start' | 'erase'
const TOOLS: [Tool, string, Parameters<typeof TI>[0]['name']][] = [
  ['start', 'Start position of the selected player', 'start'], ['pos', 'Position', 'pos'], ['arrow', 'Arrow (2 clicks)', 'arrow'],
  ['path', 'Route (click points, click the last one again to finish)', 'path'], ['zone', 'Zone (click corners, click the last one again)', 'zone'], ['text', 'Text', 'text'], ['erase', 'Erase: click a drawing', 'erase'],
]
const NEUTRAL = '#f2f2f4'
export const colorOf = (it: Pick<BoardItem, 'slot' | 'color'>) => (it.slot != null ? SLOT_COLORS[it.slot] : it.color ?? NEUTRAL)

export function Board({ map, value, onChange, slotFocus }: { map: string; value: BoardValue; onChange?: (v: BoardValue) => void; slotFocus?: { i: number; n: number } }) {
  const { maps } = useTeam()
  const meta = maps.meta[map]
  const [tool, setTool] = useState<Tool>('arrow')
  const [color, setColor] = useState(0)
  const [label, setLabel] = useState('')
  const [pending, setPending] = useState<{ x: number; y: number }[]>([])
  const [hist, setHist] = useState<BoardValue[]>([])
  const edit = !!onChange
  useEffect(() => { if (slotFocus) { setColor(slotFocus.i); setTool('start') } }, [slotFocus?.n])

  const commit = (v: BoardValue) => { setHist(h => [...h.slice(-49), value]); onChange?.(v) }
  const add = (it: BoardItem) => commit({ ...value, board: [...value.board, it] })
  const slotOf = color >= 0 ? color : undefined
  const finish = (pts = pending) => {
    const kind = tool as 'path' | 'zone'
    if (pts.length >= (kind === 'zone' ? 3 : 2)) add({ kind, pts, slot: slotOf })
    setPending([])
  }
  useEffect(() => {
    if (!edit) return
    const k = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA') return
      if (e.key === 'Escape') setPending([])
      if (e.key === 'Enter') finish()
      if (e.key === 'z' && e.ctrlKey) undo()
    }
    addEventListener('keydown', k); return () => removeEventListener('keydown', k)
  })
  const undo = () => { if (pending.length) return setPending(p => p.slice(0, -1)); const last = hist.at(-1); if (last) { setHist(h => h.slice(0, -1)); onChange?.(last) } }

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

  const erase = (i: number) => commit({ ...value, board: value.board.filter((_, k) => k !== i) })
  return (
    <div className={`tm-board ${edit ? 'edit' : ''}`}>
      {edit && (
        <div className="tm-tools">
          <div className="tm-toolset">
            {TOOLS.map(([t, title, icon]) => (
              <button key={t} className={tool === t ? 'on' : ''} title={title} aria-label={title} onClick={() => { setTool(t); setPending([]) }}><TI name={icon} size={17} /></button>
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
        <Radar map={map} onPick={edit && tool !== 'erase' ? pick : undefined}>
          {s => meta && (
            <g className={tool === 'erase' && edit ? 'tm-erasing' : ''}>
              {value.board.map((it, i) => <Item key={i} it={it} pts={it.pts.map(p => toRadar(meta, p))} s={s} onClick={edit && tool === 'erase' ? () => erase(i) : undefined} />)}
              {value.slots.map((sl, i) => sl.start && <Start key={i} p={toRadar(meta, sl.start)} n={i + 1} c={SLOT_COLORS[i]} s={s} />)}
              {pending.length > 0 && (
                <g className="tm-pending">
                  <polyline points={pending.map(p => { const r = toRadar(meta, p); return `${r.x},${r.y}` }).join(' ')} style={{ stroke: color >= 0 ? SLOT_COLORS[color] : NEUTRAL, strokeWidth: 2 * s }} />
                  {pending.map((p, i) => { const r = toRadar(meta, p); return <circle key={i} cx={r.x} cy={r.y} r={4 * s} /> })}
                </g>
              )}
            </g>
          )}
        </Radar>
      </div>
    </div>
  )
}

const hint = (t: Tool, n: number, color: number, hasSlot: boolean) =>
  t === 'start' ? (color >= 0 && hasSlot ? `Click where player ${color + 1} starts` : 'Pick a player colour first')
    : t === 'arrow' ? (n ? 'Click where it points to' : 'Click the start of the arrow')
      : t === 'path' || t === 'zone' ? (n ? `${n} point${n > 1 ? 's' : ''}. Click the last point again or press Enter` : `Click the first point of the ${t === 'path' ? 'route' : 'zone'}`)
        : t === 'erase' ? 'Click a drawing to remove it' : t === 'text' ? 'Type the text, then click the map' : 'Click the map'

function Item({ it, pts, s, onClick }: { it: BoardItem; pts: { x: number; y: number }[]; s: number; onClick?: () => void }) {
  const c = colorOf(it), line = pts.map(p => `${p.x},${p.y}`).join(' ')
  const ev = onClick ? { onPointerDown: (e: React.PointerEvent) => e.stopPropagation(), onClick: (e: React.MouseEvent) => { e.stopPropagation(); onClick() }, className: 'tm-it click' } : { className: 'tm-it' }
  const hit = onClick && <polyline points={it.kind === 'zone' ? `${line} ${pts[0].x},${pts[0].y}` : line} className="tm-hit" style={{ strokeWidth: 16 * s }} />
  if (it.kind === 'pos') return <g {...ev}><circle cx={pts[0].x} cy={pts[0].y} r={8 * s} style={{ fill: c, strokeWidth: 2.5 * s }} className="tm-pos" />{onClick && <circle cx={pts[0].x} cy={pts[0].y} r={14 * s} className="tm-hit" />}</g>
  if (it.kind === 'text') return <g {...ev}><text x={pts[0].x} y={pts[0].y} className="tm-text" style={{ fill: c, fontSize: 15 * s, strokeWidth: 3.5 * s }}>{it.label}</text></g>
  if (it.kind === 'zone') return <g {...ev}><polygon points={line} className="tm-zone" style={{ fill: c, stroke: c, strokeWidth: 2 * s, strokeDasharray: `${6 * s} ${4 * s}` }} />{hit}</g>
  // Pfeil/Laufweg: Linie + Spitze am Ende
  const a = pts.at(-2) ?? pts[0], b = pts.at(-1)!, ang = Math.atan2(b.y - a.y, b.x - a.x), L = 13 * s, W = 7 * s
  const head = `${b.x},${b.y} ${b.x - L * Math.cos(ang) + W * Math.sin(ang)},${b.y - L * Math.sin(ang) - W * Math.cos(ang)} ${b.x - L * Math.cos(ang) - W * Math.sin(ang)},${b.y - L * Math.sin(ang) + W * Math.cos(ang)}`
  const dash = it.kind === 'path' ? { strokeDasharray: `${9 * s} ${6 * s}` } : {}
  return (
    <g {...ev}>
      <polyline points={line} className="tm-line" style={{ stroke: c, strokeWidth: (it.kind === 'arrow' ? 4 : 3) * s, ...dash }} />
      <polygon points={head} style={{ fill: c }} />
      {hit}
    </g>
  )
}
const Start = ({ p, n, c, s }: { p: { x: number; y: number }; n: number; c: string; s: number }) => (
  <g className="tm-start" transform={`translate(${p.x} ${p.y}) scale(${s})`}><circle r={11} style={{ fill: c }} /><text dy={4}>{n}</text></g>
)
