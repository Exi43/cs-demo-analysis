// Kleine Helfer der Pro-Analyse (Tags, Rundenuhr, Zaehlen).
import type { Tag } from './types.ts'

/** n von N passenden Runden → HABIT (n >= 3), PATTERN (n = 2), ONCE (sonst) */
export const tagOf = (n: number, N: number): Tag => ({ kind: n >= 3 ? 'HABIT' : n === 2 ? 'PATTERN' : 'ONCE', n, N })

/** Sekunden ab Freeze-Ende → Rundenuhr (1:55 → 0:00) */
export const clock = (sec: number) => { const l = Math.max(0, 115 - sec); return `${Math.floor(l / 60)}:${String(Math.floor(l % 60)).padStart(2, '0')}` }
/** Zeitspanne als Uhr; gleiche Uhrzeit nur einmal ('1:54' statt '1:54–1:54') */
export const clockSpan = (from: number, to: number) => { const a = clock(from), b = clock(to); return a === b ? a : `${a}–${b}` }

/** Haeufigkeit je Schluessel, absteigend; undefined/'' wird ignoriert */
export function countBy<T>(arr: T[], key: (x: T) => string | undefined): [string, number][] {
  const m = new Map<string, number>()
  for (const x of arr) { const k = key(x); if (k) m.set(k, (m.get(k) ?? 0) + 1) }
  return [...m].sort((a, b) => b[1] - a[1])
}

export function median(xs: number[]): number | undefined {
  if (!xs.length) return undefined
  const s = [...xs].sort((a, b) => a - b), h = s.length >> 1
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2
}

/** gerundete Prozent, 0 bei b = 0 */
export const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0)
