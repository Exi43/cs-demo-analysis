// Fadenkreuz-Einstellungen der Lineup-Vorschau (Popover über der Steuerleiste): Quelle eigenes / des Werfers / CS2-Code, Form, Farbe,
// Größe, Dicke, Lücke, Umriss. Speichern übernimmt der Aufrufer (settings.ts, pro PC).
import { decodeCrosshair } from '../../../shared/crosshair'
import { Icon } from '../../icons'
import { XHAIR_RANGE, type XhairSettings, type XhairStyle } from './settings'

const COLORS = ['#44ff44', '#ffee00', '#00e5ff', '#ff3df2', '#ffffff', '#ff3030']
const SHAPES: [XhairStyle, string][] = [['cross', 'Cross'], ['crossdot', 'Cross with dot'], ['dot', 'Dot'], ['circle', 'Circle']]
const SLIDERS: [keyof typeof XHAIR_RANGE, string][] = [['size', 'Size'], ['thickness', 'Thickness'], ['gap', 'Gap']]

function Shape({ s }: { s: XhairStyle }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden>
      {(s === 'cross' || s === 'crossdot') && <path d="M12 3v5M12 16v5M3 12h5M16 12h5" />}
      {s === 'circle' && <circle cx="12" cy="12" r="7" />}
      {(s === 'dot' || s === 'crossdot') && <circle cx="12" cy="12" r={s === 'dot' ? 3.2 : 1.6} fill="currentColor" stroke="none" />}
    </svg>
  )
}

/** thrower = Name, wenn die Demo ein Fadenkreuz des Werfers hat (sonst ist die Quelle gesperrt) */
export function XhairPanel({ x, thrower, onChange, onClose }: { x: XhairSettings; thrower: string | null; onChange(p: Partial<XhairSettings>): void; onClose(): void }) {
  const codeOk = !x.code || !!decodeCrosshair(x.code)
  return (
    <div className="lp-panel" role="dialog" aria-label="Crosshair settings">
      <div className="lp-panel-head"><b>Crosshair</b><button className="ghost" onClick={onClose} aria-label="Close crosshair settings"><Icon name="x" size={16} /></button></div>
      <div className="lp-seg" role="group" aria-label="Crosshair source">
        <button className={x.source === 'custom' ? 'on' : ''} onClick={() => onChange({ source: 'custom' })}>Own</button>
        <button className={x.source === 'thrower' ? 'on' : ''} disabled={!thrower} onClick={() => onChange({ source: 'thrower' })}
          title={thrower ? `Crosshair of ${thrower} from the demo` : 'Only for lineups from a demo'}>Thrower</button>
        <button className={x.source === 'code' ? 'on' : ''} onClick={() => onChange({ source: 'code' })}>CS2 code</button>
      </div>
      {x.source === 'code' && <>
        <input className={`lp-code ${codeOk ? '' : 'bad'}`} placeholder="Paste crosshair code (CS… or CSGO-…)" value={x.code} spellCheck={false}
          onChange={e => onChange({ code: e.target.value })} aria-label="CS2 crosshair code" />
        {!codeOk && <div className="small bad-txt">Invalid code: your own crosshair is shown.</div>}
      </>}
      {x.source === 'custom' && <>
        <div className="lp-shapes" role="group" aria-label="Shape">
          {SHAPES.map(([s, label]) => <button key={s} className={x.style === s ? 'on' : ''} onClick={() => onChange({ style: s })} title={label} aria-label={label}><Shape s={s} /></button>)}
        </div>
        <div className="lp-colors" role="group" aria-label="Color">
          {COLORS.map(c => <button key={c} className={`lp-color ${x.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onChange({ color: c })} aria-label={`Color ${c}`} />)}
          <input type="color" value={x.color} onChange={e => onChange({ color: e.target.value })} aria-label="Own color" title="Own color" />
        </div>
        {SLIDERS.map(([k, label]) => (
          <label key={k} className="lp-slider"><span>{label}</span>
            <input type="range" min={XHAIR_RANGE[k][0]} max={XHAIR_RANGE[k][1]} value={x[k]} onChange={e => onChange({ [k]: Number(e.target.value) })} />
            <b>{x[k]}</b>
          </label>
        ))}
        <label className="lp-check"><input type="checkbox" checked={x.outline} onChange={e => onChange({ outline: e.target.checked })} /> Outline</label>
      </>}
    </div>
  )
}
