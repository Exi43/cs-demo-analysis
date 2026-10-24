// Bausteine der Anti-Strat-Ansicht: Token-Ersetzer, Warn-Icon, Tags, Runden-Chips, Zeilen und Blöcke
import { createContext, Fragment, useContext, type ReactNode } from 'react'
import type { Ref } from '../../../shared/analysis/rounds'
import type { Block, BuyClass, IconToken, Line, Tag } from '../../../shared/analysis/types'
import { Icon } from '../../icons'
import { Weapon } from '../../weapons'
import { splitTokens } from './tokens'

/** Sprung ins Replay, Chip-Beschriftung (D2 R14 bei mehreren Demos) und Rundenergebnis des analysierten Teams */
export interface Ctx { onRef: (r: Ref) => void; label: (r: Ref) => string; won: (r: Ref) => boolean | undefined }
export const ReportCtx = createContext<Ctx>({ onRef: () => {}, label: r => `R${r.round}`, won: () => undefined })

const svg = (d: ReactNode, size: number, className: string) => (
  <svg className={`ico ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">{d}</svg>
)
export const WarnIcon = ({ size = 14 }: { size?: number }) => svg(<path d="M12 3L2 20h20zM12 10v4M12 17v.5" />, size, 'rp-warn')
const EXPORT = { copy: 'M9 9h11v11H9zM5 15H4V4h11v1', download: 'M12 4v11M7 10l5 5 5-5M4 20h16', print: 'M7 9V3h10v6M7 17H4v-7h16v7h-3M7 14h10v7H7z' }
export const ExportIcon = ({ name }: { name: keyof typeof EXPORT }) => svg(<path d={EXPORT[name]} />, 15, '')

// CS2-Icons für Granaten/Waffen, Strich-Icons für den Rest
const WEAPON: Partial<Record<IconToken, [string, number]>> = {
  smoke: ['Smoke Grenade', 15], flash: ['Flashbang', 15], molly: ['Molotov', 15], he: ['High Explosive Grenade', 15], awp: ['AWP', 11],
  deagle: ['Desert Eagle', 12], c4: ['C4 Explosive', 14], kit: ['defuser', 13], knife: ['Shadow Daggers', 11],
}
export function TokenIcon({ t, size = 14 }: { t: IconToken; size?: number }) {
  if (t === 'warn') return <WarnIcon size={size} />
  const w = WEAPON[t]
  return w ? <Weapon name={w[0]} h={Math.round((w[1] * size) / 14)} /> : <Icon name={t} size={size} className={`rp-i-${t}`} />
}

/** Text mit **fett**, `code` und :icon:-Tokens */
export function Rich({ text }: { text: string }) {
  return <>{splitTokens(text).map((p, i) =>
    p.k === 'icon' ? <TokenIcon key={i} t={p.s} /> : p.k === 'b' ? <b key={i}><Rich text={p.s} /></b> : p.k === 'code' ? <code key={i}>{p.s}</code> : <Fragment key={i}>{p.s}</Fragment>)}</>
}

export const TagBadge = ({ tag }: { tag: Tag }) => <span className={`rp-tag ${tag.kind.toLowerCase()}`} title={`seen in ${tag.n} of ${tag.N} rounds`}>{tag.kind} <i>{tag.n}/{tag.N}</i></span>

/** Runden-Chips: Klick springt ins Replay (grün/rot = Runde gewonnen/verloren vom analysierten Team) */
export function Chips({ refs }: { refs: Ref[] }) {
  const c = useContext(ReportCtx)
  if (!refs.length) return null
  return <span className="rp-chips">{refs.map(r => {
    const w = c.won(r)
    return (
      <button key={`${r.matchId}:${r.round}`} className={`rchip ${w === undefined ? 'n' : w ? 'w' : 'l'}`} title={`${c.label(r)}${w === undefined ? '' : w ? ' · won' : ' · lost'} · watch in replay`}
        onClick={e => { e.preventDefault(); c.onRef(r) }}>{c.label(r)}</button>
    )
  })}</span>
}

const LABEL: Record<string, [ReactNode, string]> = {
  read: [<Icon name="target" size={14} />, 'Read'], care: [<WarnIcon />, 'Care'], counter: [<Icon name="arrow" size={14} />, 'Counter'],
}
/** Eine Aussage: Icon, Text, Tag, Runden-Chips, darunter der Konter */
export function LineItem({ l, kind }: { l: Line; kind?: 'read' | 'care' | 'counter' }) {
  return (
    <div className={`rp-line ${kind ?? ''}`}>
      {kind ? <span className="rp-kind">{LABEL[kind][0]} {LABEL[kind][1]}</span> : l.icon ? <span className="rp-ico"><TokenIcon t={l.icon} /></span> : null}
      <div className="rp-txt">
        <Rich text={l.text} /> {l.tag && <TagBadge tag={l.tag} />} <Chips refs={l.refs} />
        {l.counter && <div className="rp-counter"><Icon name="arrow" size={13} /> <Rich text={l.counter} /></div>}
      </div>
    </div>
  )
}

export const Lines = ({ lines }: { lines: Line[] }) => <div className="rp-lines">{lines.map((l, i) => <LineItem key={i} l={l} />)}</div>

/** Unterabschnitt, nur wenn er Inhalt hat */
export function Sub({ title, icon, show = true, children }: { title: string; icon?: ReactNode; show?: boolean; children: ReactNode }) {
  if (!show) return null
  return <section className="rp-sub"><h3>{icon}{icon && ' '}{title}</h3>{children}</section>
}

/** Pistol-, 2.-Runden- und Force-Blöcke als Karten nebeneinander */
export function Blocks({ blocks }: { blocks: Block[] }) {
  if (!blocks.length) return null
  return (
    <div className="rp-blocks">{blocks.map((b, i) => (
      <div key={i} className="rp-card rp-block">
        <div className="rp-block-h"><b><Rich text={b.title} /></b> <Chips refs={b.refs} /></div>
        <Lines lines={b.lines} />
      </div>
    ))}</div>
  )
}

const BUY: Record<BuyClass, [string | undefined, string]> = {
  pistol: ['Glock-18', 'Pistol'], second: [undefined, '2nd'], eco: ['P250', 'Eco'], deagle: ['Desert Eagle', 'Deagle'],
  smg: ['MAC-10', 'SMG'], light: ['FAMAS', 'Light'], full: ['AK-47', 'Full'],
}
export const BuyTag = ({ b }: { b: BuyClass }) => <span className="rp-buy" title={BUY[b][1]}>{BUY[b][0] && <Weapon name={BUY[b][0]!} h={12} />} {BUY[b][1]}</span>
