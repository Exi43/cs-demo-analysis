// Blend-Anzeige der Ego-Sicht (Berat 28.10.): das Bild wird nur noch leicht weiß (effects/index.ts FLASH_MAX), dafür steht über dem
// Spieler-Panel die Restdauer in s (zählt herunter), die Stärke als Balken + % und "FULL FLASH", solange CS2 ganz weiß zeigt (flashAt = 1,
// Rest > 3 s). Daten aus HudFocus (hud/state.ts), aktualisiert im HUD-Takt.
import { HudIcon } from './assets'
import type { HudFocus } from './types'
import './flash.css'

export function FlashIndicator({ f }: { f: HudFocus }) {
  if (f.flashLeft < 0.05) return null
  const pct = Math.round(f.flash * 100)
  return (
    <div className="hf-flash" data-hud="flash">
      {pct >= 100 && <b className="hf-tag">FULL FLASH</b>}
      <HudIcon name="eq/flashbang" />
      <span className="hf-s">{f.flashLeft.toFixed(1)}<small>s</small></span>
      <span className="hf-bar"><i style={{ width: `${pct}%` }} /></span>
      <span className="hf-p">{pct}%</span>
    </div>
  )
}
