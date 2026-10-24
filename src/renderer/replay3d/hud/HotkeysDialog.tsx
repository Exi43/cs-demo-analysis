// Hotkeys-Dialog (Zahnrad → Hotkeys…): alle Aktionen aus hotkeys.ts nach Gruppe, Klick auf die Taste = nächste Taste aufnehmen
// (Esc bricht ab; eine Modifier-Taste allein zählt beim Loslassen, z. B. Shift = Free-Cam schneller). Die Aufnahme hört im
// Capture-Phase-Listener auf window und stoppt das Ereignis (stopImmediatePropagation), damit globale Hotkeys nicht auslösen.
// Konflikte (eine Taste, mehrere Aktionen) rot mit Hinweis; Taste entfernen; 'Reset to defaults'. Speichern pro PC über setHotkey.
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { HOTKEYS, comboOf, conflicts, getHotkeys, onHotkeys, resetHotkeys, setHotkey, type HotkeyAction, type HotkeyGroup } from '../hotkeys'
import { log, type HudFixture } from './fixtures'
import './bottom.css'

const GROUPS: HotkeyGroup[] = ['Playback', 'Camera', 'Free cam', 'Options']
const NAMES: Record<string, string> = {
  BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
  Minus: '-', Equal: '=', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'Page Up', PageDown: 'Page Down',
  ShiftLeft: 'Left Shift', ShiftRight: 'Right Shift', ControlLeft: 'Left Ctrl', ControlRight: 'Right Ctrl', AltLeft: 'Left Alt',
  AltRight: 'Right Alt', MetaLeft: 'Win', MetaRight: 'Win', Escape: 'Esc',
}
/** Anzeige einer Belegung: 'Ctrl+KeyH' → 'Ctrl + H', null → '–' */
export const keyLabel = (combo: string | null) =>
  combo ? combo.split('+').map(k => NAMES[k] ?? k.replace(/^(Key|Digit)/, '').replace(/^Numpad/, 'Num ')).join(' + ') : '–'
const LABEL = Object.fromEntries(HOTKEYS.map(h => [h.action, h.label])) as Record<HotkeyAction, string>

export function HotkeysDialog({ onClose }: { onClose: () => void }) {
  const map = useSyncExternalStore(onHotkeys, getHotkeys)
  const [rec, setRec] = useState<HotkeyAction | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    let mod = ''
    const stop = (e: KeyboardEvent) => { e.preventDefault(); e.stopImmediatePropagation() }
    const down = (e: KeyboardEvent) => {
      if (!rec) { if (e.code === 'Escape') { stop(e); close.current() } return }
      stop(e)
      if (e.repeat || !e.code) return
      if (e.code === 'Escape') return setRec(null)
      if (/^(Control|Shift|Alt|Meta)/.test(e.code)) { mod = e.code; return }
      setHotkey(rec, comboOf(e))
      setRec(null)
    }
    const up = (e: KeyboardEvent) => {
      if (!rec) return
      stop(e)
      if (e.code === mod) { setHotkey(rec, mod); setRec(null) }
    }
    addEventListener('keydown', down, true)
    addEventListener('keyup', up, true)
    return () => { removeEventListener('keydown', down, true); removeEventListener('keyup', up, true) }
  }, [rec])

  const bad = conflicts(map), badOf = new Map(bad.flatMap(c => c.actions.map(a => [a, c.actions.filter(x => x !== a)] as const)))
  return (
    <div className="hu-hk-back" onMouseDown={e => { e.preventDefault(); if (e.target === e.currentTarget && !rec) onClose() }}>
      <div className="hu-menu hu-hk" data-hud="hotkeys" role="dialog" aria-label="Hotkeys">
        <header>
          <b>Hotkeys</b>
          <span>{rec ? `Press a key for “${LABEL[rec]}” · Esc cancels` : 'Click a key to change it. Saved on this PC.'}</span>
          <button className="x" title="Close (Esc)" onClick={onClose}>×</button>
        </header>
        {bad.length > 0 && (
          <div className="warn" data-hud="hotkeys-conflict">
            {bad.map(c => `${keyLabel(c.code)} is used by ${c.actions.map(a => LABEL[a]).join(' and ')}`).join(' · ')}. Press another key for one of them.
          </div>
        )}
        <div className="cols">
          {GROUPS.map(g => (
            <div key={g} className="grp">
              <h4>{g}</h4>
              {HOTKEYS.filter(h => h.group === g).map(h => {
                const code = map[h.action], also = badOf.get(h.action)
                return (
                  <div key={h.action} className={`kr ${also ? 'bad' : ''}`} data-action={h.action} title={also ? `Also used by: ${also.map(a => LABEL[a]).join(', ')}` : undefined}>
                    <span className="l">{h.label}</span>
                    <button className={`hu-hk-key ${rec === h.action ? 'rec' : ''} ${code ? '' : 'none'}`} onClick={() => setRec(r => (r === h.action ? null : h.action))}>
                      {rec === h.action ? 'Press a key…' : keyLabel(code)}
                    </button>
                    <button className="hu-hk-del" title="Remove key" disabled={!code} onClick={() => setHotkey(h.action, null)}>×</button>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
        <footer>
          <button className="hu-mbtn" onClick={() => { setRec(null); resetHotkeys() }}>Reset to defaults</button>
          <button className="hu-mbtn" onClick={onClose}>Done</button>
        </footer>
      </div>
    </div>
  )
}

/** Vorschau nur unter #hudpreview/<fixture>/hotkeys (sonst verdeckt der Dialog alles); im Menü-Fixture über 'Hotkeys…' erreichbar */
export function preview(_fx: HudFixture): ReactNode {
  return location.hash.endsWith('/hotkeys') ? <HotkeysDialog onClose={log('onClose')} /> : null
}
