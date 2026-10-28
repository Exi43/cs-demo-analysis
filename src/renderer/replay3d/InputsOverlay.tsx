// Tasten-Overlay (W A S D, Space, Ctrl, Shift, M1, M2, R, E) aus usercmd_buttonstate_1, für 3D- und 2D-Replay.
// Ohne three-Import, damit das 2D-Replay es statisch einbinden kann.
import { BTN, EV, FLAG, isDown, roundAt, upperBound, type ButtonName, type CS3D } from '../../shared/cs3d'
import './hud.css'

/** Events halten die Taste so lange (s): kurze Klicks fallen sonst zwischen zwei 16-Hz-Frames (data-Spike) */
const HOLD = 0.15
const FROM_EVENT: Record<number, ButtonName> = { [EV.weapon_fire]: 'ATTACK', [EV.weapon_reload]: 'RELOAD', [EV.weapon_zoom]: 'ATTACK2' }
const NADE_FIRE = /^weapon_(smokegrenade|flashbang|hegrenade|molotov|incgrenade|decoy)$/

/**
 * Gedrückte Tasten von steamid bei tick: Bits des Frames ODER Events der letzten 150 ms; [] zwischen Runden/ohne Spur.
 * Granatenwurf: weapon_fire kommt beim Loslassen, die Taste gilt deshalb in den 150 ms davor (Jumpthrow: M1 los mit dem Sprung, nicht danach).
 * Absprung (airborne-Flanke, z steigt) in den letzten 150 ms = Space, auch wenn der Druck zwischen zwei Frames lag (Jumpthrow-Bind: 1 Tick).
 */
export function keysAt(d: CS3D, steamid: string, tick: number): ButtonName[] {
  const p = d.header.players.findIndex(x => x.steamid === steamid), r = roundAt(d, tick)
  if (p < 0 || r < 0) return []
  const R = d.header.rounds[r], k = R.tracks.indexOf(p)
  if (k < 0) return []
  const fb = d.frameBase[r] + k * R.nFrames, fi = Math.floor((tick - R.firstTick) / d.header.frameStep), i = fb + fi
  const keys = new Set((Object.keys(BTN) as ButtonName[]).filter(b => isDown(d.btnLo[i], d.btnHi[i], BTN[b])))
  const T = d.evt.tick, h = HOLD * d.header.tickrate
  for (let j = fi; j > 0 && R.firstTick + j * d.header.frameStep > tick - h; j--) {
    if (d.flags[fb + j] & FLAG.airborne && !(d.flags[fb + j - 1] & FLAG.airborne) && d.z[fb + j] > d.z[fb + j - 1]) keys.add('JUMP')
  }
  for (let e = upperBound(T, tick + h) - 1; e >= 0 && T[e] > tick - h; e--) {
    const b = FROM_EVENT[d.evt.type[e]]
    if (!b || d.evt.player[e] !== p) continue
    if (d.evt.type[e] === EV.weapon_fire && NADE_FIRE.test(d.header.strings[d.evt.arg[e]] ?? '')) { if (T[e] > tick && !keys.has('ATTACK2')) keys.add(b) }
    else if (T[e] <= tick) keys.add(b)
  }
  return [...keys]
}

// Taste, Beschriftung, Grid-Feld (Anordnung wie auf Tastatur + Maus rechts)
const CAPS: [ButtonName, string, string][] = [
  ['FORWARD', 'W', 'w'], ['USE', 'E', 'e'], ['RELOAD', 'R', 'r'], ['MOVELEFT', 'A', 'a'], ['BACK', 'S', 's'], ['MOVERIGHT', 'D', 'd'],
  ['WALK', 'Shift', 'sh'], ['DUCK', 'Ctrl', 'ct'], ['JUMP', 'Space', 'sp'], ['ATTACK', 'M1', 'm1'], ['ATTACK2', 'M2', 'm2'],
]

export function InputsOverlay({ keys, label }: { keys: ButtonName[]; label?: string }) {
  return (
    <div className="keys">
      {label && <div className="keys-label">{label}</div>}
      <div className="keys-grid">
        {CAPS.map(([b, txt, area]) => <span key={b} className={`key ${keys.includes(b) ? 'down' : ''}`} style={{ gridArea: area }}>{txt}</span>)}
      </div>
    </div>
  )
}
