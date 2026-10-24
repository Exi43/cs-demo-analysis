// Killfeed oben rechts (Entwurf v2, huddeathnotice.vcss): CS2-Teamfarben, eigener Kill (Fokus-Spieler) mit rotem Rand #e10000,
// Icons Blind / Flash-Assist / Noscope / Smoke / Wallbang / Headshot wie im Spiel, jeder Kill 5 s sichtbar. Nur Darstellung.
import type { ReactNode } from 'react'
import { weaponLabel } from '../../format'
import { HudIcon } from './assets'
import type { HudFixture } from './fixtures'
import type { KillView } from './types'
import './top.css'

const FEED_S = 5

export function Killfeed({ kills }: { kills: readonly KillView[] }) {
  return (
    <div className="ht-feed" data-hud="killfeed">
      {kills.filter(k => k.ago <= FEED_S).map(k => (
        <div key={`${k.tick}-${k.victim}`} className={`ht-kf${k.own ? ' own' : ''}`} data-hud="kill">
          {k.blind && <HudIcon name="hud/deathnotice/blind_kill" title="Attacker blind" />}
          {k.attacker && <span className={k.attackerSide}>{k.attacker}</span>}
          {k.assister && <>
            <span className="plus">+</span>
            {k.flashAssist && <HudIcon name="eq/flashbang_assist" img className="fa" title="Flash assist" />}
            <span className={k.assisterSide}>{k.assister}</span>
          </>}
          <HudIcon name={k.weapon} img title={weaponLabel(k.weapon)} />
          {k.noscope && <HudIcon name="hud/deathnotice/noscope" title="No scope" />}
          {k.smoke && <HudIcon name="hud/deathnotice/smoke_kill" title="Through smoke" />}
          {k.wallbang && <HudIcon name="hud/deathnotice/penetrate" title="Wallbang" />}
          {k.hs && <HudIcon name="hud/deathnotice/icon_headshot" title="Headshot" />}
          <span className={k.victimSide}>{k.victim}</span>
        </div>
      ))}
    </div>
  )
}

export function preview(fx: HudFixture): ReactNode {
  return <Killfeed kills={fx.view.killfeed} />
}
