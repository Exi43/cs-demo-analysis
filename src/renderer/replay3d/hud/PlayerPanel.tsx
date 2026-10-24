// Panel des Fokus-Spielers unten Mitte (Bild 4 + 8 zusammengelegt, Entwurf v2 #dock): Utility oben links, Waffe + Magazin | Reserve
// oben rechts, Leiste in Teamfarbe mit Steam-Avatar, Name und HP (Balken = HP, roter Anteil = Verlust der letzten 1,5 s, blendet aus),
// links daneben Voice-Status und Geld mit Kauf-Symbol. Keine Kamera. Nur Darstellung aus HudView (hud/state.ts) + Option voice.
import { useRef, useSyncExternalStore, type ReactNode } from 'react'
import { getOptions, onOptions } from '../options'
import { Avatar, HudIcon } from './assets'
import type { HudFixture } from './fixtures'
import type { HudView } from './types'
import './bottom.css'

const NADES = ['Flashbang', 'Smoke Grenade', 'High Explosive Grenade', 'Molotov', 'Incendiary Grenade', 'Decoy Grenade']
const W = 460 // Panel-Breite in 1080p-px (HP-Balken)

/** null, wenn HudView kein Panel hat (kein Fokus-Spieler) */
export function PlayerPanel({ view }: { view: HudView }) {
  const voiceOn = useSyncExternalStore(onOptions, () => getOptions().voice)
  const lost = useRef(0)
  const pn = view.panel, pl = pn && view.players.find(p => p.steamid === pn.steamid)
  if (!pn || !pl) return null
  const hp = pl.alive ? Math.max(0, Math.min(100, pn.hp)) : 0
  // letzte Verlust-Breite behalten, damit der rote Anteil nach 1,5 s ausblendet statt zu springen
  if (pn.hpLost > 0) lost.current = Math.min(pn.hpLost, 100 - hp)
  const util = [...pl.utility].sort((a, b) => NADES.indexOf(a) - NADES.indexOf(b))
  return (
    <div className="hu-dock">
      <div className="hu-purse" data-hud="purse">
        <div className={`hu-voice ${pn.voice && voiceOn ? 'talk' : ''}`}>
          <HudIcon name={voiceOn ? 'ui/unmuted' : 'ui/muted'} />Voice {voiceOn ? 'on' : 'off'}
        </div>
        <div className={`hu-cash ${pl.side} shadow`}>
          ${pn.money.toLocaleString('en-US')}
          <HudIcon name="ui/shoppingcart" className={pn.buy ? '' : 'off'} title={pn.buy ? 'Can buy (buy zone, buy time)' : 'Cannot buy'} />
        </div>
      </div>
      <div className="hu-panel" data-hud="panel">
        <div className="hu-prow" data-hud="panel-top">
          <div className="hu-utl">{util.map((u, i) => <HudIcon key={i} name={u} img title={u} />)}</div>
          {pl.alive && pn.weapon && (
            <div className="hu-act">
              <HudIcon name={pn.weapon} img title={pn.weapon} />
              {pn.mag !== null && (
                <div className="hu-ammo shadow">
                  <span>{pn.mag}</span><span className="sep" />
                  <span className="res" title={pn.reserve === null ? 'Reserve unknown: re-import the demo' : 'Reserve'}>{pn.reserve ?? '–'}</span>
                  <HudIcon name="hud/bullets" />
                </div>
              )}
            </div>
          )}
        </div>
        <div className={`hu-pbar ${pl.side}`} data-hud="panel-bar">
          <Avatar className="hu-pav" steamid={pl.steamid} url={pl.avatar} name={pl.name} side={pl.side} />
          <div className="hu-hpf" style={{ width: (hp / 100) * W }} />
          <div className="hu-dmg" style={{ left: (hp / 100) * W, width: (lost.current / 100) * W, opacity: pn.hpLost > 0 ? 1 : 0 }} />
          <div className="hu-pn">{pl.name}</div>
          <div className="hu-php">{pl.alive ? hp : <HudIcon name="ui/kill" title="Dead" />}</div>
        </div>
      </div>
    </div>
  )
}

export function preview(fx: HudFixture): ReactNode {
  return <PlayerPanel view={fx.view} />
}
