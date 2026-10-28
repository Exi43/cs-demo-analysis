// Utility-Dashboard: Radar mit Zoom (Mausrad um den Zeiger, Doppelklick, Knöpfe) und Verschieben (Ziehen). Nur bei Eingaben neu
// gezeichnet, kein Bildtakt. Inhalt als SVG in Radar-Pixeln 0..1024; children(s) bekommt die Gegenskalierung für Marker.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { radarUrl } from './maps'

export function Radar({ map, lower = false, onPick, children, top }: {
  map: string; lower?: boolean
  /** Klick ins Radar (ohne Ziehen) in Radar-Pixeln */
  onPick?: (px: number, py: number) => void
  children?: (s: number) => ReactNode
  /** Bedienelemente oben links (z. B. Zurück, Ebene) */
  top?: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [v, setV] = useState({ k: 1, x: 0, y: 0 })
  const moved = useRef(false)
  const fit = (n: { k: number; x: number; y: number }) => {
    const w = box.current?.clientWidth ?? 0, h = box.current?.clientHeight ?? 0
    return { k: n.k, x: Math.min(0, Math.max(w - w * n.k, n.x)), y: Math.min(0, Math.max(h - h * n.k, n.y)) }
  }
  const zoom = (f: number, cx?: number, cy?: number) => setV(o => {
    const w = box.current?.clientWidth ?? 0, h = box.current?.clientHeight ?? 0, k = Math.min(8, Math.max(1, o.k * f)), s = k / o.k, x0 = cx ?? w / 2, y0 = cy ?? h / 2
    return fit({ k, x: x0 - (x0 - o.x) * s, y: y0 - (y0 - o.y) * s })
  })
  useEffect(() => {
    const el = box.current!
    const wheel = (e: WheelEvent) => { e.preventDefault(); const r = el.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.25 : 0.8, e.clientX - r.left, e.clientY - r.top) }
    el.addEventListener('wheel', wheel, { passive: false }) // React-onWheel ist passiv: die Seite würde mitscrollen
    return () => el.removeEventListener('wheel', wheel)
  }, [])
  useEffect(() => setV({ k: 1, x: 0, y: 0 }), [map])
  // Marker in Bildschirm-Pixeln: Radar-Pixel je Bildschirm-Pixel, beim Zoomen etwas mitwachsen (√k)
  const [w, setW] = useState(600)
  useEffect(() => { const el = box.current!, ro = new ResizeObserver(() => setW(el.clientWidth || 600)); ro.observe(el); return () => ro.disconnect() }, [])

  const down = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const sx = e.clientX, sy = e.clientY, o = v
    moved.current = false
    const move = (m: PointerEvent) => {
      if (!moved.current && Math.hypot(m.clientX - sx, m.clientY - sy) < 5) return
      moved.current = true
      setV(fit({ k: o.k, x: o.x + m.clientX - sx, y: o.y + m.clientY - sy }))
    }
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up) }
    addEventListener('pointermove', move); addEventListener('pointerup', up)
  }
  const at = (e: React.MouseEvent) => { const r = box.current!.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top, 1024 / r.width] as const }
  const s = 1024 / w / Math.sqrt(v.k)
  return (
    <div ref={box} className={`ut-radar ${onPick ? 'pick' : ''} ${v.k > 1 ? 'zoomed' : ''}`} onPointerDown={down}
      onClick={e => { if (moved.current || !onPick) return; const [x, y, f] = at(e); onPick(((x - v.x) / v.k) * f, ((y - v.y) / v.k) * f) }}
      onDoubleClick={e => { if (onPick) return; const [x, y] = at(e); zoom(2, x, y) }}>
      <div className="ut-radar-in" style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.k})` }}>
        <img src={radarUrl(map, lower)} alt="" draggable={false} />
        <svg viewBox="0 0 1024 1024">{children?.(s)}</svg>
      </div>
      {top && <div className="ut-radar-top" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()}>{top}</div>}
      <div className="ut-zoom" onPointerDown={e => e.stopPropagation()} onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
        <button onClick={() => zoom(1.5)} title="Zoom in (mouse wheel)">+</button>
        <button onClick={() => zoom(1 / 1.5)} title="Zoom out">−</button>
        {v.k > 1 && <button onClick={() => setV({ k: 1, x: 0, y: 0 })} title="Reset view">⟲</button>}
      </div>
    </div>
  )
}
