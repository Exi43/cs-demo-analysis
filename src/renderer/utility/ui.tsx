// Utility-Dashboard: kleine gemeinsame Bausteine (Kontext, Icons, Marker, Mini-Radar, virtuelle Liste, Modal, localStorage-Zustand)
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import type { TeamState } from '../../shared/team'
import type { Lineup, NadeType, Side, UtilityLibrary } from '../../shared/utility'
import type { TeamStore } from '../team/store'
import type { RadarMeta } from '../../shared/utility-api'
import { BUILTIN_TECHNIQUES } from '../../shared/utility-lib'
import { Icon } from '../icons'
import { isLower, radarUrl, toRadar, typeIcon, typeOf } from './maps'

/** Lineup im Editor: Stand und Ziel fehlen, bis sie aufs Radar geklickt sind */
export type Draft = Omit<Lineup, 'stand' | 'target'> & { stand?: Lineup['stand']; target?: Lineup['target'] }
export type Route =
  | { page: 'home' }
  | { page: 'map'; map: string; playbook?: string; focus?: string }
  | { page: 'lineup'; id: string; back: Route }
  | { page: 'edit'; draft: Draft; isNew: boolean; step?: number; back: Route }

export interface Ctx {
  lib: UtilityLibrary
  update: (f: (l: UtilityLibrary) => UtilityLibrary) => void
  maps: { meta: Record<string, RadarMeta>; radars: string[] }
  go: (r: Route) => void
  route: Route
  /** kurze Meldung unten; undo → Knopf „Undo“ */
  notify: (msg: string, bad?: boolean, undo?: () => void) => void
  preview: (l: Lineup) => void
  /** Export-Dialog, optional mit Auswahl (Lineup-IDs) */
  openExport: (ids?: string[]) => void
  /** Team-Sync: Team-Lineups stehen zusätzlich in lib.lineups (owner { team }), Änderungen daran gehen über store.saveLineup */
  team: { store: TeamStore; state: TeamState }
  /** lokale Lineups ins Team kopieren */
  share: (ids: string[]) => void
}
export const UtilCtx = createContext<Ctx>(null as never)
export const useUtil = () => useContext(UtilCtx)

/** Zustand pro PC in localStorage (Ansicht, gespeicherte Filter); kaputt/fehlend → Vorgabe */
export function useLocal<T>(key: string, def: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key); return s ? (JSON.parse(s) as T) : def } catch { return def } })
  return [v, (n: T) => { setV(n); try { localStorage.setItem(key, JSON.stringify(n)) } catch {} }]
}

export const live = (lib: UtilityLibrary) => lib.lineups.filter(l => !l.deleted)
export const techLabel = (lib: UtilityLibrary, id: string) => (BUILTIN_TECHNIQUES.find(t => t.id === id) ?? lib.techniques.find(t => t.id === id))?.label ?? id
export const sideLabel = (s: Side) => (s === 'both' ? 'T + CT' : s)

export function TypeIcon({ type, size = 26 }: { type: NadeType; size?: number }) {
  return <span className={`ut-type ${type}`} style={{ width: size, height: size }} title={typeOf(type).label}><img src={typeIcon(type)} alt="" /></span>
}
export function SideBadge({ side }: { side: Side }) {
  return <span className={`ut-side ${side}`}>{sideLabel(side)}</span>
}

// ---------------------------------------------------------------- Marker (SVG in Radar-Pixeln 0..1024; s = Gegenskalierung beim Zoomen)

const HEX = Array.from({ length: 6 }, (_, i) => { const a = (Math.PI / 3) * i + Math.PI / 6; return `${(Math.cos(a) * 14).toFixed(2)},${(Math.sin(a) * 14).toFixed(2)}` }).join(' ')
export function TargetMarker({ x, y, type, side, count = 1, s = 1, active, dim, onClick, onHover }: {
  x: number; y: number; type: NadeType; side: Side; count?: number; s?: number; active?: boolean; dim?: boolean
  onClick?: () => void; onHover?: (on: boolean) => void
}) {
  return (
    <g className={`ut-mk ${side} ${active ? 'on' : ''} ${dim ? 'dim' : ''} ${onClick ? 'click' : ''}`} transform={`translate(${x} ${y}) scale(${s})`}
      onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onClick?.() }}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <polygon points={HEX} className="ut-mk-body" />
      <image href={typeIcon(type)} x={-5.5} y={-9} width={11} height={18} className="ut-mk-ico" />
      {count > 1 && <g transform="translate(12 -12)"><circle r={8} className="ut-mk-n" /><text dy={3.5}>{count}</text></g>}
    </g>
  )
}
export function StandMarker({ x, y, side, s = 1, n, active, onClick, onHover }: {
  x: number; y: number; side: Side; s?: number; n?: number; active?: boolean; onClick?: () => void; onHover?: (on: boolean) => void
}) {
  return (
    <g className={`ut-stand ${side} ${active ? 'on' : ''} ${onClick ? 'click' : ''}`} transform={`translate(${x} ${y}) scale(${s})`}
      onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); onClick?.() }}
      onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)}>
      <circle r={n ? 9 : 6} />
      {n != null && <text dy={3.5}>{n}</text>}
    </g>
  )
}
export const Throw = ({ a, b, s = 1, active }: { a: { x: number; y: number }; b: { x: number; y: number }; s?: number; active?: boolean }) =>
  <line className={`ut-throw ${active ? 'on' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={{ strokeWidth: 2 * s, strokeDasharray: `${6 * s} ${5 * s}` }} />

/** Ausschnitt des Radars um Stand und Ziel (Karten ohne Bild, Detailansicht) */
export function MiniRadar({ l, meta, aspect = 16 / 9 }: { l: Lineup; meta?: RadarMeta; aspect?: number }) {
  if (!meta) return <div className="ut-mini empty" />
  const a = toRadar(meta, l.stand), b = toRadar(meta, l.target), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2
  const w = Math.max(Math.abs(a.x - b.x) + 140, (Math.abs(a.y - b.y) + 140) * aspect, 260), h = w / aspect
  return (
    <svg className="ut-mini" viewBox={`${cx - w / 2} ${cy - h / 2} ${w} ${h}`} preserveAspectRatio="xMidYMid slice">
      <image href={radarUrl(l.map, isLower(meta, l.target.z ?? l.stand.z))} width={1024} height={1024} />
      <Throw a={a} b={b} s={w / 340} active />
      <StandMarker x={a.x} y={a.y} side={l.side} s={w / 340} />
      <TargetMarker x={b.x} y={b.y} type={l.type} side={l.side} s={w / 340} />
    </svg>
  )
}

/** Liste/Raster, das nur sichtbare Zeilen zeichnet (feste Zeilenhöhe, beim Raster aus der Spaltenbreite; minColW → so viele Spalten wie passen) */
export function VirtualRows<T>({ items, rowH: rh, minColW, gap = 12, render, className = '', empty }: {
  items: T[]; rowH: number | ((colW: number) => number); minColW?: number; gap?: number; render: (it: T, i: number) => ReactNode; className?: string; empty?: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ top: 0, h: 800, w: 900 })
  useEffect(() => {
    const el = ref.current!, upd = () => setBox(b => (b.top === el.scrollTop && b.h === el.clientHeight && b.w === el.clientWidth ? b : { top: el.scrollTop, h: el.clientHeight, w: el.clientWidth }))
    upd()
    const ro = new ResizeObserver(upd)
    ro.observe(el); el.addEventListener('scroll', upd, { passive: true })
    return () => { ro.disconnect(); el.removeEventListener('scroll', upd) }
  }, [])
  const cols = minColW ? Math.max(1, Math.floor((box.w + gap) / (minColW + gap))) : 1
  const rowH = typeof rh === 'number' ? rh : Math.round(rh((box.w - gap * (cols - 1)) / cols) + gap)
  const rows = Math.ceil(items.length / cols), first = Math.max(0, Math.floor(box.top / rowH) - 2), last = Math.min(rows, Math.ceil((box.top + box.h) / rowH) + 2)
  return (
    <div ref={ref} className={`ut-virtual ${className}`}>
      {!items.length && empty}
      <div style={{ height: rows * rowH, position: 'relative' }}>
        {Array.from({ length: Math.max(0, last - first) }, (_, k) => {
          const r = first + k
          return (
            <div key={r} className="ut-vrow" style={{ top: r * rowH, height: rowH - gap, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gap }}>
              {items.slice(r * cols, r * cols + cols).map((it, i) => render(it, r * cols + i))}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function Modal({ title, onClose, children, foot, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }; addEventListener('keydown', k); return () => removeEventListener('keydown', k) }, [onClose])
  return (
    <div className="ut-modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className={`ut-modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div className="ut-modal-head"><h2>{title}</h2><button className="ut-icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
        <div className="ut-modal-body">{children}</div>
        {foot && <div className="ut-modal-foot">{foot}</div>}
      </div>
    </div>
  )
}

/** Segment-Schalter (eine Auswahl) */
export function Seg<T extends string>({ value, options, onChange, small }: { value: T; options: [T, ReactNode][]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`ut-seg ${small ? 'small' : ''}`}>
      {options.map(([v, label]) => <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>{label}</button>)}
    </div>
  )
}

export const fmtBytes = (n: number) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`)
