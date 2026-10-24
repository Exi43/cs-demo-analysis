// Scoreboard oben Mitte (Entwurf v2, Bild 1): Steam-Avatare der Captains, Punkte, ROUND n + Uhr. Bombe gelegt: C4 pulsiert + roter
// Restzeit-Balken; Entschärfen: Kreis füllt sich + Restsekunden. Darunter X VS Y, Freeze-Hinweis oder Rundenende-Banner. Nur Darstellung.
// Puls und Kreis folgen dem HUD-Takt (bomb.left, defuse.progress) statt einer CSS-Animation: in der Pause steht alles still, keine Last.
import type { ReactNode } from 'react'
import type { Side } from '../../../shared/model'
import { Avatar, HudIcon } from './assets'
import type { HudFixture } from './fixtures'
import type { HudView } from './types'
import './top.css'

const clockTxt = (s: number) => { const c = Math.ceil(s); return `${Math.floor(c / 60)}:${String(c % 60).padStart(2, '0')}` }
const R = 21, C = 2 * Math.PI * R // Defuse-Kreis (viewBox 50)

function Cap({ view, side }: { view: HudView; side: Side }) {
  const t = view.teams[side], c = t.captain
  return (
    <div className="ht-cap" data-hud="score-cap" title={c ? `Captain ${c.name}` : t.name}>
      <Avatar steamid={c?.steamid ?? ''} url={c?.avatar ?? null} name={c?.name ?? t.name} side={side} />
    </div>
  )
}

/** winner: Gewinner der Runde (v1 Round.winner) für das Banner bei phase 'over'; fehlt er, steht dort 'ROUND OVER' */
export function Scoreboard({ view, winner }: { view: HudView; winner?: Side | null }) {
  const { bomb, defuse, vs, phase } = view, planted = phase === 'planted'
  let mid: ReactNode
  if (planted && defuse) {
    const who = view.players.find(p => p.steamid === defuse.steamid)?.name ?? ''
    mid = <>
      <div className="ht-ring" data-hud="defuse" title={`${who} defusing ${defuse.kit ? 'with' : 'without'} kit`}>
        <svg viewBox="0 0 50 50"><circle cx="25" cy="25" r={R} /><circle className="on" cx="25" cy="25" r={R} strokeDasharray={`${(C * defuse.progress).toFixed(1)} ${C.toFixed(1)}`} /></svg>
        <HudIcon name="ui/defuser_white" />
      </div>
      <div className="ht-defleft">{defuse.left.toFixed(1)}s</div>
    </>
  } else if (planted) {
    const k = 0.5 + 0.5 * Math.cos(2 * Math.PI * bomb.left) // 1 Puls je Sekunde der Bomben-Uhr
    mid = <HudIcon name="ui/bomb_icon" className="ht-c4" title={`Bomb planted${bomb.site ? ` at ${bomb.site}` : ''}: ${bomb.left.toFixed(1)} s left`} style={{ opacity: 0.75 + 0.25 * k, transform: `scale(${0.9 + 0.1 * k})` }} />
  } else mid = <><div className="ht-rnd">ROUND {view.round}</div><div className="ht-clk">{clockTxt(view.clock)}</div></>

  let below: ReactNode = null
  if (phase === 'over') below = <div className={`ht-banner ${winner ?? ''}`} data-hud="banner">{winner ? `${winner === 'CT' ? 'COUNTER-TERRORISTS' : 'TERRORISTS'} WIN` : 'ROUND OVER'}</div>
  else if (phase === 'freeze') below = <div className="ht-banner" data-hud="banner">FREEZE TIME</div>
  else if (vs && vs.ct > 0 && vs.t > 0) below = <div className="ht-vs" data-hud="clutch"><span className="CT">{vs.ct}</span><span className="vs">VS</span><span className="T">{vs.t}</span></div>

  return (
    <div className="ht-score">
      <div className="ht-sb" data-hud="score">
        <Cap view={view} side="CT" />
        <div className="ht-sc CT" data-hud="score-num">{view.score.CT}</div>
        <div className="ht-mid" data-hud="score-mid">{mid}</div>
        <div className="ht-sc T" data-hud="score-num">{view.score.T}</div>
        <Cap view={view} side="T" />
      </div>
      {planted && <div className="ht-bombbar" data-hud="bombbar"><div style={{ width: `${(bomb.total ? bomb.left / bomb.total : 0) * 100}%` }} /></div>}
      {below}
    </div>
  )
}

export function preview(fx: HudFixture): ReactNode {
  return <Scoreboard view={fx.view} winner={fx.rounds.find(r => r.num === fx.view.round)?.winner} />
}
