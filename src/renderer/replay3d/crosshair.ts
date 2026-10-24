// CS2-Crosshair zeichnen (Port von spike/fp/crosshair/crosshairRender.ts, Pixel-System seit 22.09.2026).
// Skalierung wie CS2: Werte sind Pixel bei c.screenHeight, s = Zielhöhe / screenHeight, je Größe gerundet.
// Geometrie wie CS:GO DrawCrosshair: Mittelquadrat T×T ab (cx − ⌊T/2⌋, cy − ⌊T/2⌋), Balken L×T G Pixel außerhalb davon;
// Reihenfolge links, rechts, oben, unten, Punkt; je Element erst Outline (±O, halb = nur oben/links), dann Füllung.
// Sicher: Kreuz-Styles 0/2/4/5, Dot Only (6), T-Style, Outline. NÄHERUNG: Kreis (1/3), Quad (7/9), Square (8) – Valve-Code fehlt.
import type { CrosshairRender } from '../../shared/crosshair'

type RGBA = [number, number, number, number]
export type Prim =
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rgba: RGBA }
  | { kind: 'ring'; cx: number; cy: number; r0: number; r1: number; rgba: RGBA }

const DYNAMIC = new Set([0, 1, 2, 7])

/** height = Zielhöhe in Geräte-Pixeln, cx/cy = Bildmitte (abgerundet), spread = Öffnung dynamischer Styles in Referenz-Pixeln */
export function buildCrosshair(c: CrosshairRender, height: number, cx: number, cy: number, spread = 0): Prim[] {
  const s = height / c.screenHeight, px = (n: number) => Math.round(n * s)
  const T = Math.max(1, px(c.thickness)), L = px(c.length), O = Math.max(1, px(c.outlineThickness))
  // Patchnotes 30.09.2026: negative Lücke nur beim klassisch-dynamischen Stil (2)
  let G = c.style === 2 ? px(c.gap) : Math.max(0, px(c.gap))
  if (DYNAMIC.has(c.style) && spread) G += px(Math.min(Math.max(spread, 0), c.dynamicSpreadLimit))
  const x0 = Math.floor(cx) - (T >> 1), y0 = Math.floor(cy) - (T >> 1), x1 = x0 + T, y1 = y0 + T
  const out: Prim[] = [], half = c.outlineMode === 2
  // Element = Gruppe: erst alle Outlines, dann die Füllungen (Winkel/Rahmen ohne innere Outline-Kanten)
  const group = (...rs: [number, number, number, number][]) => {
    const ok = rs.filter(([, , w, h]) => w > 0 && h > 0)
    if (c.outlineMode) for (const [x, y, w, h] of ok) out.push({ kind: 'rect', x: x - O, y: y - O, w: w + (half ? O : 2 * O), h: h + (half ? O : 2 * O), rgba: c.outlineColor })
    for (const [x, y, w, h] of ok) out.push({ kind: 'rect', x, y, w, h, rgba: c.color })
  }
  switch (c.style) {
    case 1: case 3: { // Kreis: Ring der Breite T durch die Balkenmitte (NÄHERUNG)
      const ri = Math.max(0, G + L / 2), mx = (x0 + x1) / 2, my = (y0 + y1) / 2
      if (c.outlineMode) out.push({ kind: 'ring', cx: mx, cy: my, r0: Math.max(0, ri - O), r1: ri + T + O, rgba: c.outlineColor })
      out.push({ kind: 'ring', cx: mx, cy: my, r0: ri, r1: ri + T, rgba: c.color })
      break
    }
    case 6: break // nur Punkt (unten)
    case 8: { // Static Square: geschlossener Rahmen (NÄHERUNG)
      const a = x0 - G - T, b = x1 + G, t = y0 - G - T, d = y1 + G, side = b + T - a
      group([a, t, side, T], [a, d, side, T], [a, t + T, T, d - t - T], [b, t + T, T, d - t - T])
      break
    }
    case 7: case 9: { // Quad: vier Eckwinkel (NÄHERUNG)
      const a = x0 - G - T, b = x1 + G, t = y0 - G - T, d = y1 + G, leg = Math.max(T, Math.min(L, Math.ceil((b + T - a) / 3)))
      group([a, t, leg, T], [a, t + T, T, leg - T]); group([b + T - leg, t, leg, T], [b, t + T, T, leg - T])
      group([a, d, leg, T], [a, d + T - leg, T, leg - T]); group([b + T - leg, d, leg, T], [b, d + T - leg, T, leg - T])
      break
    }
    default: // 0, 2, 4, 5: Kreuz
      group([x0 - G - L, y0, L, T]); group([x1 + G, y0, L, T])
      if (!c.tStyle) group([x0, y0 - G - L, T, L])
      group([x0, y1 + G, T, L])
  }
  if (c.dot || c.style === 6) group([x0, y0, T, T])
  return out
}

/** ctx in Geräte-Pixeln (Transform = Identität); nur fillRect/arc → pixelgenau */
export function drawCrosshair(ctx: CanvasRenderingContext2D, c: CrosshairRender, height: number, cx: number, cy: number) {
  for (const p of buildCrosshair(c, height, cx, cy)) {
    ctx.fillStyle = `rgba(${p.rgba[0]},${p.rgba[1]},${p.rgba[2]},${p.rgba[3] / 255})`
    if (p.kind === 'rect') { ctx.fillRect(p.x, p.y, p.w, p.h); continue }
    ctx.beginPath(); ctx.arc(p.cx, p.cy, p.r1, 0, Math.PI * 2)
    if (p.r0 > 0) { ctx.moveTo(p.cx + p.r0, p.cy); ctx.arc(p.cx, p.cy, p.r0, 0, Math.PI * 2, true) }
    ctx.fill('evenodd')
  }
}
