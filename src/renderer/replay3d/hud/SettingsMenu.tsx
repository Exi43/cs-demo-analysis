// Zahnrad-Menü der Demo-Leiste (Entwurf v2 #settings, v2-wasd-menu.png): alle Optionen aus options.ts (useSyncExternalStore, schreibt
// mit setOptions, gespeichert pro PC), UI-Elemente einzeln + 'Hide all', Bildlimit (auch ohne Fokus), Leistungszeile aus Prop stats (~2×/s), Knopf
// 'Hotkeys…' (öffnet HotkeysDialog), Re-import nur, wenn onReimport übergeben ist (HudTrack fehlt oder CS3D älter als CS3D_VERSION). Offen/zu besitzt der
// Aufrufer (DemoBar settingsOpen). Kein TrueView (Berat 21.10.). Höhe wie Entwurf (652 px), der Rest scrollt, Fußzeile bleibt stehen.
import { useState, useSyncExternalStore, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import type { EngineStats } from '../contracts'
import { getOptions, onOptions, setOptions, type FpsCap, type OptionsPatch, type Replay3DOptions } from '../options'
import { HudIcon } from './assets'
import { log, type HudFixture } from './fixtures'
import { HotkeysDialog } from './HotkeysDialog'
import './bottom.css'

type Flag = { [K in keyof Replay3DOptions]: Replay3DOptions[K] extends boolean ? K : never }[keyof Replay3DOptions]
type UiFlag = keyof Replay3DOptions['ui']
const UI: [UiFlag, string][] = [['scoreboard', 'Scoreboard'], ['teams', 'Team bars'], ['minimap', 'Minimap'], ['killfeed', 'Killfeed'],
  ['panel', 'Player panel'], ['labels', 'Overhead labels'], ['crosshair', 'Crosshair'], ['demobarAutoHide', 'Auto-hide demo bar']]
const FPS: [FpsCap, string][] = [[30, '30'], [60, '60'], [120, '120'], [0, 'Off']]
const BG_FPS: FpsCap[] = [15, 30, 60]
// mousedown ohne Fokus (außer Regler): sonst bleibt der Fokus in der Checkbox und Leertaste schaltet sie statt Play/Pause
const noFocus = (e: MouseEvent) => { if (!(e.target as HTMLElement).matches('input[type=range]')) e.preventDefault() }

function Check({ on, set, t, e, dis, tag }: { on: boolean; set: (v: boolean) => void; t: string; e?: string; dis?: boolean; tag?: string }) {
  return (
    <label className={`hu-chk ${dis ? 'dis' : ''}`}>
      <input type="checkbox" checked={on} disabled={dis} onChange={ev => set(ev.target.checked)} />
      <span className="box" />
      <span><span className="t">{t}{tag && <small>{tag}</small>}</span>{e && <span className="e">{e}</span>}</span>
    </label>
  )
}

export function SettingsMenu({ stats, onReimport }: {
  /** engine.stats() + gemessene fps; null = noch keine */
  stats?: Pick<EngineStats, 'fps' | 'calls' | 'frameMs' | 'cpuMs'> | null
  onReimport?: () => void
}) {
  const o = useSyncExternalStore(onOptions, getOptions)
  const [hotkeys, setHotkeys] = useState(false)
  const flag = (k: Flag, t: string, e: string, x?: { dis?: boolean; tag?: string }) =>
    <Check on={o[k]} set={v => setOptions({ [k]: v } as OptionsPatch)} t={t} e={e} {...x} />
  return (
    <>
      <div className="hu-menu hu-settings" data-hud="settings" onMouseDown={noFocus}>
        <h4>View</h4>
        {flag('lowQuality', 'Low quality', 'Lower resolution, no anti-aliasing, bloom, sun shadows, grenade camera or effect lights. Switches instantly.')}
        {flag('xray', 'X-Ray', 'Player outlines through walls and smoke (CT blue, T orange). Hit players blink red up to their missing health.')}
        {flag('showKeys', 'Show keys (WASD)', 'Keys of the watched player: W A S D, Shift, Ctrl, Space, mouse.', { tag: 'default off' })}
        <div className="sep" /><h4>Effects</h4>
        {flag('impacts', 'Bullet impacts', 'Small box where each bullet lands: red = player hit, blue = miss.')}
        {flag('nadeTrails', 'Grenade trails', 'Flight path and landing point of every grenade.', { dis: !o.xray, tag: 'with X-Ray' })}
        {flag('nadeCam', 'Grenade camera', o.lowQuality ? 'Not available in low quality.' : 'Small picture-in-picture view that follows a flying grenade.', { dis: o.lowQuality, tag: o.lowQuality ? 'high quality only' : undefined })}
        <div className="sep" /><h4>Sound</h4>
        <div className="hu-sld">
          <HudIcon name="ui/unmuted" /><span className="l">Volume</span>
          <input type="range" min={0} max={1} step={0.05} value={o.volume} aria-label="Volume" style={{ '--v': `${o.volume * 100}%` } as CSSProperties}
            onChange={e => setOptions({ volume: Number(e.target.value) })} onPointerUp={e => e.currentTarget.blur()} />
          <span className="v">{Math.round(o.volume * 100)}%</span>
        </div>
        {flag('voice', 'Voice', 'Voice chat recorded in the demo.')}
        <div className="sep" />
        <h4 className="row">
          UI elements
          <label className="hu-mini" title="Clean picture: hides every HUD element">
            <input type="checkbox" checked={o.hideAll} onChange={e => setOptions({ hideAll: e.target.checked })} /><span className="box" />Hide all
          </label>
        </h4>
        <div className={`hu-ui ${o.hideAll ? 'off' : ''}`}>
          {UI.map(([k, t]) => <Check key={k} on={o.ui[k]} set={v => setOptions({ ui: { [k]: v } })} t={t} />)}
        </div>
        <div className="sep" /><h4>Performance</h4>
        <div className="hu-row">
          <span className="l">FPS limit</span>
          <div className="hu-seg">
            {FPS.map(([v, t]) => <button key={v} className={o.fpsCap === v ? 'on' : ''} aria-pressed={o.fpsCap === v} onClick={() => setOptions({ fpsCap: v })}>{t}</button>)}
          </div>
        </div>
        <div className="hu-row" title="While another window has focus, e.g. a game on the other monitor">
          <span className="l">In background</span>
          <div className="hu-seg">
            {BG_FPS.map(v => <button key={v} className={o.fpsCapBackground === v ? 'on' : ''} aria-pressed={o.fpsCapBackground === v} onClick={() => setOptions({ fpsCapBackground: v })}>{v}</button>)}
          </div>
        </div>
        {stats && (
          <div className="hu-stats" data-hud="stats" title={`CPU per frame (setTime): ${stats.cpuMs.toFixed(2)} ms`}>
            {Math.round(stats.fps)} fps · {stats.calls} draw calls · {stats.frameMs.toFixed(1)} ms
          </div>
        )}
        {onReimport && <div className="hu-note">Imported with an older version: newer details (live utility, reserve ammo, buy zone, stickers) need a re-import.</div>}
        <div className="hu-foot">
          <button className="hu-mbtn" onClick={() => setHotkeys(true)}><HudIcon name="ui/settings" />Hotkeys…</button>
          {onReimport && <button className="hu-mbtn warn" onClick={onReimport}>Re-import demo</button>}
        </div>
      </div>
      {hotkeys && <HotkeysDialog onClose={() => setHotkeys(false)} />}
    </>
  )
}

export function preview(fx: HudFixture): ReactNode {
  return fx.menu ? <SettingsMenu stats={{ fps: 60, calls: 412, frameMs: 6.2, cpuMs: 1.4 }} onReimport={log('onReimport')} /> : null
}
