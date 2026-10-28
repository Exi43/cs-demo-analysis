// Ampel-Grenzen der „At a glance“-Karten (Pro-Analyse, Sicht = unser Team). Hier zentral, damit Berat sie später anpassen kann.
// higher: Wert >= good → grün, Wert < bad → rot. lower: Wert < good → grün, Wert > bad → rot. Dazwischen gelb.

export type Light = 'good' | 'warn' | 'bad'
export interface Limit { good: number; bad: number; higher: boolean }

export const LIMITS = {
  /** % gewonnene Opening-Duelle */
  opening: { good: 55, bad: 45, higher: true },
  /** % ungetradete Tode (ohne Tode als Letzter) */
  untraded: { good: 70, bad: 85, higher: false }, // mit der 5-s-Trade-Regel sind echte Demos 84–93 % ungetradet
  /** % verlorene Runden nach Überzahl (5v4, 4v3 …) */
  advantage: { good: 25, bad: 35, higher: false },
  /** teure Niederlagen: verlorene Anti-Ecos + verlorene 2. Runde nach Pistol-Sieg (0 grün, 1 gelb, ab 2 rot) */
  roundTypes: { good: 1, bad: 1, higher: false },
  /** % T-Runden mit Plant */
  plant: { good: 60, bad: 45, higher: true },
  /** % gewonnene Runden nach eigenem Plant */
  postPlant: { good: 65, bad: 50, higher: true },
  /** % gewonnene Retakes (nur echte Versuche) */
  retake: { good: 40, bad: 25, higher: true },
  /** Runden mit zu früher Rotation (> 10 s vor dem Hit) */
  earlyRotation: { good: 1, bad: 1, higher: false },
  /** geblendete Gegner (>= 0,7 s) je geworfener Flash */
  flash: { good: 0.7, bad: 0.45, higher: true },
  /** % Teamflashes an allen Blendungen durch uns */
  teamFlash: { good: 25, bad: 40, higher: false },
} satisfies Record<string, Limit>

/** Unter so vielen Fällen keine Ampel (zu wenig Runden) */
export const MIN_SAMPLE = 3

export function light(v: number, l: Limit): Light {
  if (l.higher) return v >= l.good ? 'good' : v < l.bad ? 'bad' : 'warn'
  return v < l.good ? 'good' : v > l.bad ? 'bad' : 'warn'
}

const RANK: Record<Light, number> = { good: 0, warn: 1, bad: 2 }
/** schlechteste Ampel; undefined (zu wenig Daten) zählt nicht */
export const worst = (...ls: (Light | undefined)[]): Light | undefined =>
  ls.reduce<Light | undefined>((a, b) => (!b ? a : !a || RANK[b] > RANK[a] ? b : a), undefined)
