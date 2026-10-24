// Zeichnet einen Zeitpunkt einer oder mehrerer Runden auf ein Canvas (1024x1024 Radar-Koordinaten).
import type { MatchData, Nade, PlayerTrack, Round, Side } from '../../shared/model'
import type { MapMeta } from '../api'

import { weaponIcon } from '../weapons'

const C4_IMG = new Image()
C4_IMG.src = weaponIcon('c4') ?? ''

export const TICKRATE = 64
export const ROUND_TIME = 115 // s ab Freezetime-Ende
export const BOMB_TIME = 40

export const COLORS = {
  CT: '#5ea8ff', T: '#f0a830',
  smoke: 'rgba(200,205,215,0.55)', smokeEdge: 'rgba(230,235,245,0.9)',
  molotov: 'rgba(255,90,30,0.40)', molotovEdge: 'rgba(255,140,40,0.95)',
  flash: '#ffffff', he: '#ff4d4d', decoy: '#9aa0a6',
}
const NADE_COLOR: Record<string, string> = { smoke: '#d0d5de', flash: '#ffffff', he: '#ff6060', molotov: '#ff8a30', decoy: '#9aa0a6' }
const SMOKE_R = 144 // Weltradius
const FIRE_R = 120

export interface View {
  map: MapMeta
  /** 'upper' | 'lower' bei Maps mit zwei Ebenen */
  level: 'upper' | 'lower'
}

export const toRadar = (m: MapMeta, x: number, y: number): [number, number] => [(x - m.pos_x) / m.scale, (m.pos_y - y) / m.scale]

export function isLower(m: MapMeta, z: number) {
  const low = m.verticalsections?.lower
  return low ? z < Number(low.AltitudeMax) : false
}

/** Frame-Index (mit Bruchteil) für einen Tick */
export function frameAt(r: Round, tick: number): number {
  const ft = r.frameTicks
  if (!ft.length) return 0
  if (tick <= ft[0]) return 0
  if (tick >= ft[ft.length - 1]) return ft.length - 1
  let lo = 0, hi = ft.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ft[mid] <= tick) lo = mid; else hi = mid }
  return lo + (tick - ft[lo]) / (ft[hi] - ft[lo])
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
function lerpAngle(a: number, b: number, t: number) {
  let d = ((b - a + 540) % 360) - 180
  return a + d * t
}

export interface PState {
  steamid: string; side: Side; x: number; y: number; z: number; yaw: number; hp: number; armor: number
  weapon: string; place: string; money: number
}

export function playerAt(r: Round, tr: PlayerTrack, f: number): PState {
  const i = Math.floor(f), j = Math.min(i + 1, tr.x.length - 1), a = f - i
  // Bei Teleport (Respawn/Rundenstart) nicht interpolieren
  const jump = Math.hypot(tr.x[j] - tr.x[i], tr.y[j] - tr.y[i]) > 300
  const t = jump ? 0 : a
  return {
    steamid: tr.steamid, side: tr.side,
    x: lerp(tr.x[i], tr.x[j], t), y: lerp(tr.y[i], tr.y[j], t), z: lerp(tr.z[i], tr.z[j], t),
    yaw: lerpAngle(tr.yaw[i], tr.yaw[j], t), hp: a < 0.5 ? tr.hp[i] : tr.hp[j], armor: tr.armor[i],
    weapon: r.weapons[tr.weapon[i]] ?? '', place: r.places[tr.place[i]] ?? '', money: tr.money[i],
  }
}

/** Position einer Granate im Flug */
function nadePos(n: Nade, tick: number): [number, number, number] | undefined {
  const p = n.path
  if (tick < p[0][0]) return undefined
  for (let k = 1; k < p.length; k++) {
    if (p[k][0] >= tick) {
      const a = (tick - p[k - 1][0]) / (p[k][0] - p[k - 1][0] || 1)
      return [lerp(p[k - 1][1], p[k][1], a), lerp(p[k - 1][2], p[k][2], a), lerp(p[k - 1][3], p[k][3], a)]
    }
  }
  const l = p[p.length - 1]
  return [l[1], l[2], l[3]]
}

/** Heatmap: Punkte (Weltkoordinaten) als eingefärbte Dichte über das Radar legen */
export function drawHeat(ctx: CanvasRenderingContext2D, m: MapMeta, zoom: number, pts: [number, number][], radius = 22) {
  if (!pts.length) return
  const W = ctx.canvas.width, H = ctx.canvas.height
  const off = document.createElement('canvas'); off.width = W; off.height = H
  const o = off.getContext('2d')!
  const r = radius * zoom
  const a = Math.min(0.5, 6 / Math.sqrt(pts.length + 1))
  for (const [wx, wy] of pts) {
    const [x, y] = toRadar(m, wx, wy); const px = x * zoom, py = y * zoom
    const g = o.createRadialGradient(px, py, 0, px, py, r)
    g.addColorStop(0, `rgba(0,0,0,${a})`); g.addColorStop(1, 'rgba(0,0,0,0)')
    o.fillStyle = g; o.fillRect(px - r, py - r, r * 2, r * 2)
  }
  const img = o.getImageData(0, 0, W, H); const d = img.data
  let max = 1
  for (let i = 3; i < d.length; i += 4) if (d[i] > max) max = d[i]
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i + 3] / max; if (v <= 0.02) { d[i + 3] = 0; continue }
    // blau → grün → gelb → rot
    const c = v < 0.33 ? [40, 120 + 400 * v, 255 - 300 * v] : v < 0.66 ? [255 * (v - 0.33) * 3, 230, 60] : [255, 230 - 500 * (v - 0.66), 40]
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 60 + 170 * v
  }
  o.putImageData(img, 0, 0)
  ctx.drawImage(off, 0, 0)
}

export interface Layer {
  round: Round
  tick: number
  alpha: number
  /** Nur diese Seite zeichnen (Multi-Runden-Ansicht) */
  side?: Side
  /** Pfade der letzten N Sekunden als Spur zeichnen (Infinity = seit Freezetime-Ende) */
  trail?: number
  /** Alle bisher geworfenen Granaten als Linie Wurf→Landung zeigen */
  nadeHistory?: boolean
  /** Farbe überschreiben (Multi-Runden: eine Farbe pro Runde) */
  color?: string
  showNames?: boolean
  highlight?: string // steamid
  /** Nur diese Spieler zeigen (leer/undefined = alle) */
  players?: Set<string>
}

/** zoom = Pixel pro Radar-Pixel (Lage), mark = Größe von Markern, Linien und Schrift (3D-Minimap: größer als zoom, sonst unlesbar) */
export function drawScene(ctx: CanvasRenderingContext2D, match: MatchData, view: View, img: HTMLImageElement | undefined, layers: Layer[], zoom: number, mark = zoom) {
  const m = view.map
  const s = mark
  ctx.save()
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.fillStyle = '#0b0d11'
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height)
  if (img) ctx.drawImage(img, 0, 0, 1024 * zoom, 1024 * zoom)

  const P = (x: number, y: number): [number, number] => { const [a, b] = toRadar(m, x, y); return [a * zoom, b * zoom] }
  const onLevel = (z: number) => (view.level === 'lower') === isLower(m, z)
  const nameOf = new Map(match.players.map(p => [p.steamid, p.name]))
  const sideOfIn = (r: Round, sid: string) => r.tracks.find(t => t.steamid === sid)?.side

  for (const L of layers) {
    const { round: r, tick } = L
    ctx.globalAlpha = L.alpha
    const f = frameAt(r, tick)

    // --- Granaten-Wirkung (unter den Spielern) ---
    for (const n of r.nades) {
      if ((L.side && sideOfIn(r, n.thrower) !== L.side) || (L.players && !L.players.has(n.thrower))) continue
      const end = n.path[n.path.length - 1]
      if (!onLevel(end[3])) continue
      if (n.type === 'smoke' && tick >= n.detTick && tick <= n.endTick) {
        const [x, y] = P(end[1], end[2])
        const left = (n.endTick - tick) / TICKRATE
        const grow = Math.min(1, (tick - n.detTick) / (TICKRATE * 0.8))
        ctx.beginPath(); ctx.arc(x, y, (SMOKE_R / m.scale) * zoom * grow, 0, Math.PI * 2)
        ctx.fillStyle = COLORS.smoke; ctx.fill()
        ctx.strokeStyle = COLORS.smokeEdge; ctx.lineWidth = 1.5; ctx.stroke()
        ctx.fillStyle = '#111'; ctx.font = `bold ${11 * Math.max(1, s * 0.8)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
        ctx.fillText(left.toFixed(0), x, y)
      }
      if (n.type === 'molotov' && tick >= n.detTick && tick <= n.endTick && n.endTick > n.detTick) {
        const [x, y] = P(end[1], end[2])
        ctx.beginPath(); ctx.arc(x, y, (FIRE_R / m.scale) * zoom, 0, Math.PI * 2)
        ctx.fillStyle = COLORS.molotov; ctx.fill(); ctx.strokeStyle = COLORS.molotovEdge; ctx.lineWidth = 1.5; ctx.stroke()
      }
      if ((n.type === 'flash' || n.type === 'he') && tick >= n.detTick && tick <= n.detTick + TICKRATE * 0.5) {
        const [x, y] = P(end[1], end[2])
        const a = 1 - (tick - n.detTick) / (TICKRATE * 0.5)
        ctx.beginPath(); ctx.arc(x, y, (n.type === 'he' ? 30 : 22) * s * (1.2 - a * 0.5), 0, Math.PI * 2)
        ctx.fillStyle = n.type === 'he' ? `rgba(255,77,77,${0.6 * a})` : `rgba(255,255,255,${0.8 * a})`; ctx.fill()
      }
      // Flug
      if (tick >= n.throwTick && tick < n.detTick) {
        const pos = nadePos(n, tick)
        if (pos) {
          ctx.strokeStyle = NADE_COLOR[n.type]; ctx.lineWidth = 1.2 * s; ctx.setLineDash([3 * s, 3 * s]); ctx.beginPath()
          let first = true
          for (const p of n.path) { if (p[0] > tick) break; const [x, y] = P(p[1], p[2]); first ? ctx.moveTo(x, y) : ctx.lineTo(x, y); first = false }
          const [cx, cy] = P(pos[0], pos[1]); ctx.lineTo(cx, cy); ctx.stroke(); ctx.setLineDash([])
          ctx.beginPath(); ctx.arc(cx, cy, 3.5 * s, 0, Math.PI * 2); ctx.fillStyle = NADE_COLOR[n.type]; ctx.fill()
        }
      }
    }

    // --- Bombe ---
    if (r.plant && tick >= r.plant.tick && !(r.defuse && tick > r.defuse.tick + TICKRATE * 2) && !(r.exploded && tick > r.exploded + TICKRATE * 2)) {
      const [x, y] = P(r.plant.pos[0], r.plant.pos[1])
      ctx.beginPath(); ctx.arc(x, y, 11 * s, 0, Math.PI * 2)
      ctx.fillStyle = r.defuse && tick >= r.defuse.tick ? '#2e7d32' : '#b3261e'; ctx.fill()
      ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5 * s; ctx.stroke()
      if (C4_IMG.complete) { const w = 15 * s, h = w * (C4_IMG.naturalHeight / C4_IMG.naturalWidth || 0.6); ctx.drawImage(C4_IMG, x - w / 2, y - h / 2, w, h) }
    }

    // --- Granaten-Historie ---
    if (L.nadeHistory) {
      for (const n of r.nades) {
        if (n.throwTick > tick || (L.side && sideOfIn(r, n.thrower) !== L.side) || (L.players && !L.players.has(n.thrower))) continue
        const a = n.path[0], b = n.path[n.path.length - 1]
        const [ax, ay] = P(a[1], a[2]); const [bx, by] = P(b[1], b[2])
        ctx.strokeStyle = NADE_COLOR[n.type] + '88'; ctx.lineWidth = 1 * s; ctx.setLineDash([2 * s, 3 * s])
        ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.setLineDash([])
        ctx.beginPath(); ctx.arc(bx, by, 4 * s, 0, Math.PI * 2); ctx.fillStyle = NADE_COLOR[n.type]; ctx.fill()
        ctx.strokeStyle = '#000'; ctx.lineWidth = 1; ctx.stroke()
      }
    }

    // --- Spuren ---
    if (L.trail) {
      const fStart = frameAt(r, r.freezeEndTick)
      const fBack = Math.max(fStart, f - L.trail * (TICKRATE / 4))
      for (const tr of r.tracks) {
        if ((L.side && tr.side !== L.side) || (L.players && !L.players.has(tr.steamid))) continue
        ctx.strokeStyle = (L.color ?? COLORS[tr.side]) + (L.highlight && L.highlight !== tr.steamid ? '33' : 'cc')
        ctx.lineWidth = (L.highlight === tr.steamid ? 2.5 : 1.5) * s; ctx.beginPath()
        let pen = false
        for (let i = Math.floor(fBack); i <= Math.floor(f); i++) {
          if (tr.hp[i] <= 0) break
          const [x, y] = P(tr.x[i], tr.y[i])
          pen ? ctx.lineTo(x, y) : ctx.moveTo(x, y); pen = true
        }
        ctx.stroke()
      }
    }

    // --- Kill-Linien (1,5 s) ---
    for (const k of r.kills) {
      if (tick < k.tick || tick > k.tick + TICKRATE * 1.5 || !k.attackerPos) continue
      if (L.side && sideOfIn(r, k.attacker!) !== L.side && sideOfIn(r, k.victim) !== L.side) continue
      const [ax, ay] = P(k.attackerPos[0], k.attackerPos[1]); const [vx, vy] = P(k.victimPos[0], k.victimPos[1])
      ctx.strokeStyle = `rgba(255,255,255,${1 - (tick - k.tick) / (TICKRATE * 1.5)})`; ctx.lineWidth = 1.2 * s
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(vx, vy); ctx.stroke()
    }

    // --- Spieler ---
    const R = 7.5 * s
    for (const tr of r.tracks) {
      if ((L.side && tr.side !== L.side) || (L.players && !L.players.has(tr.steamid))) continue
      const p = playerAt(r, tr, f)
      const [x, y] = P(p.x, p.y)
      const dim = onLevel(p.z) ? 1 : 0.3
      ctx.globalAlpha = L.alpha * dim
      if (p.hp <= 0) {
        // Todesort
        const death = r.kills.find(k => k.victim === tr.steamid && k.tick <= tick)
        if (death) {
          const [dx, dy] = P(death.victimPos[0], death.victimPos[1])
          ctx.strokeStyle = COLORS[tr.side]; ctx.lineWidth = 2 * s; const d = 4 * s
          ctx.beginPath(); ctx.moveTo(dx - d, dy - d); ctx.lineTo(dx + d, dy + d); ctx.moveTo(dx + d, dy - d); ctx.lineTo(dx - d, dy + d); ctx.stroke()
        }
        continue
      }
      // Blickrichtung
      const yaw = (-p.yaw * Math.PI) / 180
      ctx.fillStyle = COLORS[tr.side] + '55'
      ctx.beginPath(); ctx.moveTo(x, y); ctx.arc(x, y, R * 3.2, yaw - 0.35, yaw + 0.35); ctx.closePath(); ctx.fill()
      // Körper
      ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.fillStyle = L.color ?? COLORS[tr.side]; ctx.fill()
      ctx.lineWidth = (L.highlight === tr.steamid ? 3 : 1.5) * s; ctx.strokeStyle = L.highlight === tr.steamid ? '#fff' : '#0b0d11'; ctx.stroke()
      // HP-Ring
      ctx.beginPath(); ctx.arc(x, y, R + 2.5 * s, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * p.hp) / 100)
      ctx.strokeStyle = p.hp > 50 ? '#7bd88f' : p.hp > 20 ? '#f5c542' : '#ff5c5c'; ctx.lineWidth = 2 * s; ctx.stroke()
      // geblendet
      const blind = r.blinds.find(b => b.victim === tr.steamid && tick >= b.tick && tick <= b.tick + b.duration * TICKRATE)
      if (blind) { ctx.beginPath(); ctx.arc(x, y, R * 0.6, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill() }
      // Bombenträger
      if (tr.side === 'T' && p.weapon === 'C4 Explosive' && C4_IMG.complete) { const w = 11 * s; ctx.drawImage(C4_IMG, x + R * 0.6, y - R * 1.6, w, w * 0.6) }
      if (L.showNames !== false) {
        ctx.font = `600 ${10 * Math.max(0.9, s * 0.75)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'top'
        ctx.lineWidth = 3; ctx.strokeStyle = '#000a'; const label = nameOf.get(tr.steamid) ?? ''
        ctx.strokeText(label, x, y + R + 4 * s); ctx.fillStyle = '#fff'; ctx.fillText(label, x, y + R + 4 * s)
      }
    }
    ctx.globalAlpha = 1
  }
  ctx.restore()
}
