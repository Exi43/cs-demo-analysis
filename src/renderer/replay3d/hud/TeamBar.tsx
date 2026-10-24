// Teamleiste (Entwurf v2, Bild 6/7): CT links, T rechts, gespiegelt (Slot-Streifen außen, HP-Zahl zur Mitte, Füllung vom äußeren Rand = HP %).
// Je Spieler 308x70: Steam-Avatar, Name, K/D, Geld, Hauptwaffe, Sterne (Kills dieser Runde), Utility je Granate, Weste/Helm, Kit, Bombe;
// tot = grau, Avatar in Graustufen, Totenkopf. Klick = onPick(steamid), Rechtsklick = onMute(steamid). Nur Darstellung.
import { useState, type ReactNode } from 'react'
import type { Side } from '../../../shared/model'
import { Avatar, HudIcon } from './assets'
import { log, type HudFixture } from './fixtures'
import type { HudPlayerView, HudView } from './types'
import './teambar.css'

const FILL_W = 294 // Zeile 308 minus Slot-Streifen 14
const NADES = ['Flashbang', 'Smoke Grenade', 'High Explosive Grenade', 'Molotov', 'Incendiary Grenade', 'Decoy Grenade'] // Reihenfolge wie im Spiel

export interface TeamBarProps {
  view: HudView
  side: Side
  /** Fokus-Spieler (Rahmen) */
  focus: string | null
  /** stummgeschaltete Spieler (Sprecher-Symbol durchgestrichen) */
  muted?: ReadonlySet<string>
  onPick(steamid: string): void
  onMute(steamid: string): void
}

export function TeamBar({ view, side, focus, muted, onPick, onMute }: TeamBarProps) {
  const lr = side === 'CT' ? 'L' : 'R', t = view.teams[side]
  return (
    <div className={`tb tb-${lr}`} data-hud={`team${lr}`}>
      {/* FACEIT-Team heißt team_<Captain> (Parser schneidet team_ ab) */}
      <div className={`tb-tag ${side}`} data-hud={`tag${lr}`}>{t.captain ? `team_${t.name}` : t.name}<span>{side}</span></div>
      {view.players.filter(p => p.side === side).map(p => (
        <Row key={p.steamid} p={p} lr={lr} focus={p.steamid === focus} muted={!!muted?.has(p.steamid)} onPick={onPick} onMute={onMute} />
      ))}
    </div>
  )
}

function Row({ p, lr, focus, muted, onPick, onMute }: { p: HudPlayerView; lr: 'L' | 'R'; focus: boolean; muted: boolean } & Pick<TeamBarProps, 'onPick' | 'onMute'>) {
  const flip = lr === 'R' ? 'flip' : ''
  return (
    <div className={`tb-row ${p.side}${p.alive ? '' : ' dead'}${focus ? ' focus' : ''}`} data-hud={`row${lr}`} data-steamid={p.steamid}
      title={`${p.name}\nClick: watch this player\nRight-click: ${muted ? 'unmute' : 'mute'} voice`}
      onClick={() => onPick(p.steamid)} onContextMenu={e => { e.preventDefault(); onMute(p.steamid) }}>
      {p.alive && <div className="tb-fill" data-hud={`fill${lr}`} style={{ width: (p.hp / 100) * FILL_W }} />}
      <div className="tb-strip">{p.slot % 10}</div>
      <div className="tb-nm">
        <div className="tb-name shadow">{p.name}</div>
        <div className="tb-kd"><HudIcon name="ui/crosshair_circle" title="Kills" /><b>{p.kills}</b><HudIcon name="ui/kill" title="Deaths" /><b>{p.deaths}</b></div>
        <div className="tb-money"><i>$</i>{p.money.toLocaleString('en-US')}</div>
      </div>
      <Avatar steamid={p.steamid} url={p.avatar} name={p.name} side={p.side} />
      {(p.speaking || muted) && <HudIcon name={muted ? 'ui/muted' : 'ui/unmuted'} className={`tb-voice${muted ? ' off' : ''}`} title={muted ? 'Muted' : 'Speaking'} />}
      {p.roundKills > 0 && <div className="tb-stars" title={`${p.roundKills} kills this round`}>{'★'.repeat(p.roundKills)}</div>}
      {p.alive ? <>
        <div className="tb-wp"><HudIcon name={p.primary || p.weapon} img className={flip} title={p.primary || p.weapon} /></div>
        <div className="tb-util">{[...p.utility].sort((a, b) => NADES.indexOf(a) - NADES.indexOf(b)).map((u, i) => <HudIcon key={i} name={u} img className={flip} title={u} />)}</div>
        <div className="tb-hp shadow">{p.hp}</div>
        <div className="tb-gear">
          {p.armor > 0 && <HudIcon name={p.helmet ? 'hud/teamcounter/armor_helmet' : 'hud/teamcounter/armor'} className="tb-arm" title={p.helmet ? 'Kevlar + helmet' : 'Kevlar'} />}
          {p.kit && <HudIcon name="eq/defuser" img title="Defuse kit" />}
          {p.bomb && <HudIcon name="eq/c4" img title="Bomb" />}
        </div>
      </> : <HudIcon name="ui/kill" className="tb-skull" />}
    </div>
  )
}

/** Vorschau: beide Seiten; Klick/Rechtsklick ins Log, Rechtsklick schaltet das Stumm-Symbol um */
function Both({ fx }: { fx: HudFixture }) {
  const [muted, setMuted] = useState<ReadonlySet<string>>(new Set())
  const onMute = (sid: string) => {
    log('onMute')(sid)
    setMuted(m => { const n = new Set(m); if (!n.delete(sid)) n.add(sid); return n })
  }
  return <>
    <TeamBar view={fx.view} side="CT" focus={fx.focus} muted={muted} onPick={log('onPick')} onMute={onMute} />
    <TeamBar view={fx.view} side="T" focus={fx.focus} muted={muted} onPick={log('onPick')} onMute={onMute} />
  </>
}

export function preview(fx: HudFixture): ReactNode {
  return <Both fx={fx} />
}
