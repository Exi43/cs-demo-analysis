// Optionen des 3D-Replays als kleiner Store (ohne three/React). Engine, Effekte, Audio, HUD und Bildtakt lesen getOptions()
// und hören auf onOptions; das Zahnrad-Menü schreibt mit setOptions (React: useSyncExternalStore(onOptions, getOptions)).
// Gespeichert pro PC in localStorage; fehlt der Speicher oder ist er kaputt → Standard, unbekannte/falsche Werte → Standard.
// Selbsttest: 7. Hash-Segment von #auto/replay3d/<runde>/<sek>/<kamera>/<spielerindex>/<opts>, z. B. 'xray,impacts,nadeCam,fpsCap=0'
// oder 'minimap=0,hideAll' (Name allein = an, Name=0 = aus). Gilt nur für diese Sitzung und wird nie gespeichert.

/** einzeln verbergbare HUD-Teile (Zahnrad → UI elements) */
export type UiElement = 'scoreboard' | 'teams' | 'minimap' | 'killfeed' | 'panel' | 'labels' | 'crosshair'
/** Bilder/s, 0 = ohne Limit */
export type FpsCap = 0 | 30 | 60 | 120

export interface Replay3DOptions {
  /** X-Ray-Umrisse durch Wände und Rauch, dazu das Schadens-Blinken (früher eigene Option 'damage', gespeicherte Werte werden ignoriert) */
  xray: boolean
  /** Granaten-Flugbahn, nur sichtbar zusammen mit xray */
  nadeTrails: boolean
  /** Bullet Impacts: Kästchen am Einschlag (rot = Spieler getroffen, blau = nicht) */
  impacts: boolean
  /** Granaten-Kamera (kleines Bild unten links) */
  nadeCam: boolean
  /** WASD-/Tasten-Anzeige */
  showKeys: boolean
  voice: boolean
  /** Lautstärke 0..1 */
  volume: number
  /** reine Render-Option, wirkt sofort (engine/index.ts applyLow): Render-Skala, MSAA, Bloom, Schatten, Granaten-Kamera, Effekt-Lichter */
  lowQuality: boolean
  fpsCap: FpsCap
  /** Limit ohne Fensterfokus */
  fpsCapUnfocused: FpsCap
  ui: Record<UiElement, boolean> & { demobarAutoHide: boolean }
  /** alles verbergen (sauberes Bild) */
  hideAll: boolean
}

export const DEFAULT_OPTIONS: Readonly<Replay3DOptions> = {
  xray: false, nadeTrails: true, impacts: false, nadeCam: false, showKeys: false, voice: true, volume: 0.8,
  lowQuality: false, fpsCap: 60, fpsCapUnfocused: 30,
  ui: { scoreboard: true, teams: true, minimap: true, killfeed: true, panel: true, labels: true, crosshair: true, demobarAutoHide: false },
  hideAll: false,
}

export type OptionsPatch = Partial<Omit<Replay3DOptions, 'ui'>> & { ui?: Partial<Replay3DOptions['ui']> }

const KEY = 'csda.replay3d.options.v1'
const FPS: unknown[] = [0, 30, 60, 120]
const obj = (v: unknown) => (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
const valid = (k: string, v: unknown, def: unknown) =>
  typeof v === typeof def && (typeof v !== 'number' || (k.startsWith('fpsCap') ? FPS.includes(v) : v >= 0 && v <= 1))
/** base + alle gültigen bekannten Werte aus p (Speicher, Patch oder Hash) */
function merge(base: Replay3DOptions, p: unknown): Replay3DOptions {
  const pick = <T extends object>(b: T, s: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, valid(k, s[k], v) ? s[k] : v])) as T
  const src = obj(p)
  return { ...pick(base, src), ui: pick(base.ui, obj(src.ui)) }
}

function fromHash(hash: string): Record<string, unknown> | null {
  const seg = hash.startsWith('#auto/replay3d/') ? hash.slice(1).split('/')[6] : undefined
  if (!seg) return null
  const top: Record<string, unknown> = {}, ui: Record<string, unknown> = {}
  for (const t of decodeURIComponent(seg).split(',')) {
    const [k, v] = t.split('='), isUi = k in DEFAULT_OPTIONS.ui
    const def = obj(isUi ? DEFAULT_OPTIONS.ui : DEFAULT_OPTIONS)[k]
    ;(isUi ? ui : top)[k] = v === undefined ? true : typeof def === 'number' ? Number(v) : v !== '0' && v !== 'false'
  }
  return { ...top, ui }
}

let saved = merge(DEFAULT_OPTIONS, (() => { try { return JSON.parse(localStorage.getItem(KEY) ?? 'null') } catch { return null } })())
const override = fromHash(globalThis.location?.hash ?? '')
let cur = override ? merge(saved, override) : saved
const subs = new Set<(o: Replay3DOptions) => void>()

/** gleiches Objekt bis zur nächsten Änderung (für useSyncExternalStore) */
export const getOptions = (): Readonly<Replay3DOptions> => cur

/** übernimmt gültige Werte, speichert (ohne Selbsttest-Override) und benachrichtigt */
export function setOptions(p: OptionsPatch) {
  saved = merge(saved, p)
  cur = override ? merge(cur, p) : saved
  try { localStorage.setItem(KEY, JSON.stringify(saved)) } catch { /* privater Modus/voll: nur für diese Sitzung */ }
  for (const cb of subs) cb(cur)
}

export function onOptions(cb: (o: Replay3DOptions) => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** HUD-Teil sichtbar? (Hide all schlägt alles) */
export const shown = (el: UiElement) => !cur.hideAll && cur.ui[el]
