// Tastenbelegung des 3D-Replays (ohne three/React): alle Aktionen mit Gruppe, englischem Label und Standardtaste; eigene Belegung
// pro PC in localStorage (kaputte Einträge → Standard). Taste = KeyboardEvent.code, optional mit 'Ctrl+' / 'Shift+' / 'Alt+'
// davor (in dieser Reihenfolge, siehe comboOf), z. B. 'KeyX', 'Ctrl+KeyH'; null = keine Taste.
// Globale Aktionen: window keydown → matchAction(e) (nicht in Eingabefeldern, nicht während der Tasten-Aufnahme; e.repeat prüft
// der Aufrufer). Free-Cam-Tasten liest die Engine selbst aus getHotkeys() und vergleicht nur e.code (Shift = schneller + W).

export type HotkeyGroup = 'Playback' | 'Camera' | 'Free cam' | 'Options'

export const HOTKEYS = [
  { action: 'playPause', group: 'Playback', label: 'Play / pause', key: 'Space' },
  { action: 'slower', group: 'Playback', label: 'Slower', key: 'BracketLeft' },
  { action: 'faster', group: 'Playback', label: 'Faster', key: 'BracketRight' },
  { action: 'back15', group: 'Playback', label: 'Back 15 s', key: 'ArrowLeft' },
  { action: 'fwd15', group: 'Playback', label: 'Forward 15 s', key: 'ArrowRight' },
  { action: 'prevRound', group: 'Playback', label: 'Previous round', key: 'PageUp' },
  { action: 'nextRound', group: 'Playback', label: 'Next round', key: 'PageDown' },
  { action: 'prevPlayer', group: 'Playback', label: 'Previous player', key: 'Comma' },
  { action: 'nextPlayer', group: 'Playback', label: 'Next player', key: 'Period' },
  { action: 'nextEvent', group: 'Playback', label: 'Next event', key: 'KeyN' },
  { action: 'slot1', group: 'Playback', label: 'Player 1', key: 'Digit1' },
  { action: 'slot2', group: 'Playback', label: 'Player 2', key: 'Digit2' },
  { action: 'slot3', group: 'Playback', label: 'Player 3', key: 'Digit3' },
  { action: 'slot4', group: 'Playback', label: 'Player 4', key: 'Digit4' },
  { action: 'slot5', group: 'Playback', label: 'Player 5', key: 'Digit5' },
  { action: 'slot6', group: 'Playback', label: 'Player 6', key: 'Digit6' },
  { action: 'slot7', group: 'Playback', label: 'Player 7', key: 'Digit7' },
  { action: 'slot8', group: 'Playback', label: 'Player 8', key: 'Digit8' },
  { action: 'slot9', group: 'Playback', label: 'Player 9', key: 'Digit9' },
  { action: 'slot0', group: 'Playback', label: 'Player 0', key: 'Digit0' },
  { action: 'camToggle', group: 'Camera', label: 'First person / free cam', key: 'KeyC' },
  { action: 'camForward', group: 'Free cam', label: 'Forward', key: 'KeyW' },
  { action: 'camBack', group: 'Free cam', label: 'Back', key: 'KeyS' },
  { action: 'camLeft', group: 'Free cam', label: 'Left', key: 'KeyA' },
  { action: 'camRight', group: 'Free cam', label: 'Right', key: 'KeyD' },
  { action: 'camUp', group: 'Free cam', label: 'Up', key: 'KeyE' },
  { action: 'camDown', group: 'Free cam', label: 'Down', key: 'KeyQ' },
  { action: 'camFast', group: 'Free cam', label: 'Faster (hold)', key: 'ShiftLeft' },
  { action: 'xray', group: 'Options', label: 'X-Ray', key: 'KeyX' },
  { action: 'nadeTrails', group: 'Options', label: 'Grenade trails', key: 'KeyT' },
  { action: 'impacts', group: 'Options', label: 'Bullet impacts', key: 'KeyI' },
  { action: 'nadeCam', group: 'Options', label: 'Grenade camera', key: 'KeyG' },
  { action: 'showKeys', group: 'Options', label: 'Show keys (WASD)', key: 'KeyK' },
  { action: 'labels', group: 'Options', label: 'Overhead labels', key: 'KeyL' },
  { action: 'voice', group: 'Options', label: 'Voice', key: 'KeyV' },
  { action: 'hideAll', group: 'Options', label: 'Hide all UI', key: 'KeyH' },
  { action: 'settings', group: 'Options', label: 'Settings', key: 'KeyO' },
] as const satisfies readonly { action: string; group: HotkeyGroup; label: string; key: string }[]

export type HotkeyAction = (typeof HOTKEYS)[number]['action']
export type HotkeyMap = Record<HotkeyAction, string | null>
export const DEFAULT_HOTKEYS: Readonly<HotkeyMap> = Object.fromEntries(HOTKEYS.map(h => [h.action, h.key])) as HotkeyMap

type KeyEv = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'shiftKey' | 'altKey'>
const KEY = 'csda.replay3d.hotkeys.v1'
const MOD = /^(Control|Shift|Alt|Meta)/
const COMBO = /^(Ctrl\+)?(Shift\+)?(Alt\+)?[A-Z][A-Za-z0-9]+$/

/** Taste eines keydown als Belegungs-Text; eine Modifier-Taste allein (z. B. ShiftLeft) ohne Präfix */
export const comboOf = (e: KeyEv) =>
  MOD.test(e.code) ? e.code : `${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${e.altKey ? 'Alt+' : ''}${e.code}`

let map: HotkeyMap = (() => {
  let raw: Record<string, unknown> = {}
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') ?? {} } catch { /* fehlt/kaputt → Standard */ }
  const ok = (v: unknown) => v === null || (typeof v === 'string' && COMBO.test(v))
  return Object.fromEntries(HOTKEYS.map(h => [h.action, ok(raw[h.action]) ? raw[h.action] : h.key])) as HotkeyMap
})()
const subs = new Set<(m: HotkeyMap) => void>()
function set(m: HotkeyMap) {
  map = m
  try { localStorage.setItem(KEY, JSON.stringify(m)) } catch { /* nur für diese Sitzung */ }
  for (const cb of subs) cb(map)
}

/** gleiches Objekt bis zur nächsten Änderung (für useSyncExternalStore) */
export const getHotkeys = (): Readonly<HotkeyMap> => map
export const setHotkey = (action: HotkeyAction, code: string | null) => set({ ...map, [action]: code })
export const resetHotkeys = () => set({ ...DEFAULT_HOTKEYS })
export function onHotkeys(cb: (m: HotkeyMap) => void): () => void {
  subs.add(cb)
  return () => { subs.delete(cb) }
}

/** Tasten mit mehr als einer Aktion (Reihenfolge wie HOTKEYS) */
export function conflicts(m: Readonly<HotkeyMap> = map): { code: string; actions: HotkeyAction[] }[] {
  const by = new Map<string, HotkeyAction[]>()
  for (const h of HOTKEYS) { const c = m[h.action]; if (c) by.set(c, [...(by.get(c) ?? []), h.action]) }
  return [...by].filter(([, a]) => a.length > 1).map(([code, actions]) => ({ code, actions }))
}

/** globale Aktion zu einem keydown, ohne Free-Cam-Aktionen; ohne eigene Shift-Belegung zählt Shift+Taste wie die Taste (Shift = Free-Cam schnell) */
export function matchAction(e: KeyEv): HotkeyAction | null {
  const c = comboOf(e)
  for (const h of HOTKEYS) if (h.group !== 'Free cam' && map[h.action] === c) return h.action
  return e.shiftKey && !e.ctrlKey && !e.altKey && !MOD.test(e.code) ? matchAction({ code: e.code, ctrlKey: false, shiftKey: false, altKey: false }) : null
}
