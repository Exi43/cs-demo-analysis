// Ereignisse aus CS2-Clips (*.vnmclip_c) statisch per VRF -b DATA (Port von spike/animsound clipevents.mjs):
// CNmSoundEvent → [Sekunde, Soundevent], CNmIDEvent WPN_BLOCK_INSPECT → block-Fenster, WPN_RELOAD_LOOP / WPN_INSPECT_LOOP → loop-Fenster.
// Zeiten im Clip sind normiert (0..1), daher × m_flDuration. Nur Dateien lesen, nie cs2.exe.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { vrf } from './cs2.ts'
import type { Ctx } from './map.ts'

export interface ClipEvents { snd: [t: number, ev: string][]; win: { block?: [number, number][]; loop?: [number, number] } }

/** Clips (VRF-Pfad ohne .vnmclip) gebündelt dumpen, ≤ 150 je Aufruf (Kommandozeile < 32 k) → Pfad → Ereignisse */
export function clipEvents(c: Ctx, paths: string[], work: string): Record<string, ClipEvents> {
  const out: Record<string, ClipEvents> = {}
  for (let i = 0; i < paths.length; i += 150) {
    const f = join(work, `clipdata${i}.txt`)
    vrf(c.exe, ['-i', c.cs2.pak, '-f', paths.slice(i, i + 150).map(p => p + '.vnmclip_c').join(','), '-b', 'DATA'], f)
    Object.assign(out, parseClipEvents(readFileSync(f, 'utf8')))
  }
  return out
}

const r3 = (x: number) => +x.toFixed(3)

/** VRF-Ausgabe '[i/n] <pfad>.vnmclip_c' + DATA-Block (KV3-Text) je Clip */
export function parseClipEvents(text: string): Record<string, ClipEvents> {
  const out: Record<string, ClipEvents> = {}
  for (const part of text.split(/^\[\d+\/\d+\] /m).slice(1)) {
    const name = part.slice(0, part.indexOf('\n')).trim().replace(/\.vnmclip_c$/, '')
    const dur = +(/^\tm_flDuration = ([\d.]+)/m.exec(part)?.[1] ?? NaN)
    const e: ClipEvents = { snd: [], win: {} }
    out[name] = e
    const a = part.indexOf('\n\tm_events = \n') // Ereignisliste des Clips (eine Ebene tief), nicht die leeren der Unterstrukturen
    if (a < 0 || !(dur > 0)) continue
    const body = part.slice(a, part.indexOf('\n\t]', a))
    for (const it of body.split('\n\t\t{').slice(1)) {
      const cls = /_class = "(\w+)"/.exec(it)?.[1]
      const st = +(/m_flStartTime = \s*\{\s*m_flValue = ([-\d.e]+)/.exec(it)?.[1] ?? NaN)
      const du = +(/m_flDuration = \s*\{\s*m_flValue = ([-\d.e]+)/.exec(it)?.[1] ?? 0)
      if (!(st >= 0)) continue
      if (cls === 'CNmSoundEvent') { const ev = /\bm_name = "([^"]+)"/.exec(it)?.[1]; if (ev) e.snd.push([r3(st * dur), ev]) }
      else if (cls === 'CNmIDEvent') {
        const id = /\bm_ID = "([^"]+)"/.exec(it)?.[1], w: [number, number] = [r3(st * dur), r3((st + du) * dur)]
        if (id === 'WPN_BLOCK_INSPECT') (e.win.block ??= []).push(w)
        else if (id === 'WPN_RELOAD_LOOP' || id === 'WPN_INSPECT_LOOP') e.win.loop = w
      }
    }
    e.snd.sort((x, y) => x[0] - y[0])
  }
  return out
}
