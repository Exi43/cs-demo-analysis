// Entwicklungs-Vorschau des Übertragungs-HUDs (nicht in der Navigation): #hudpreview/<fixture>[/blocks], fixture = start | schaden |
// normal | defuse | menu (fixtures.ts). Zeigt jede Komponente hud/*.tsx mit  export function preview(fx: HudFixture): ReactNode
// auf einer 16:9-Bühne (1080p-px, skaliert über --s); /blocks oder ohne Komponenten: Bausteine (Icons, Avatare, Schriften).
// Callbacks loggen in die Konsole (fixtures.ts log), Messpunkte data-hud für _tools/rects.cjs. Selbsttest: CSDA_VIEW=hudpreview/normal.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Avatars } from '../../../shared/hud'
import { api } from '../../api'
import { Avatar, HudIcon, iconBitmaps, useHudAssets, useHudScale } from './assets'
import { FIXTURES, type FixtureName, type HudFixture } from './fixtures'

const MODULES = import.meta.glob('./*.tsx', { eager: true }) as Record<string, { preview?: (fx: HudFixture) => ReactNode }>
// Staubige Dust2-Stimmung statt Spielbild, damit halbtransparente Teile wie im Spiel wirken
const BG = 'linear-gradient(180deg, #6d7a84 0%, #9a8f7c 48%, #7d6b55 52%, #3f362d 100%)'

function withAvatars(fx: HudFixture, av: Avatars): HudFixture {
  const cap = (c: HudFixture['view']['teams']['CT']['captain']) => c && { ...c, avatar: av[c.steamid] ?? null }
  const { teams } = fx.view
  return {
    ...fx,
    view: {
      ...fx.view, players: fx.view.players.map(p => ({ ...p, avatar: av[p.steamid] ?? null })),
      teams: { CT: { ...teams.CT, captain: cap(teams.CT.captain) }, T: { ...teams.T, captain: cap(teams.T.captain) } },
    },
  }
}

export function HudPreview() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const [, name, sub] = hash.slice(1).split('/')
  const base = FIXTURES[name as FixtureName] ?? FIXTURES.normal
  const [avatars, setAvatars] = useState<Avatars>({})
  useEffect(() => {
    Promise.resolve().then(() => api.avatars(base.view.players.map(p => p.steamid))).then(setAvatars, e => console.warn('HUD preview avatars:', e))
  }, [base])
  const fx = useMemo(() => withAvatars(base, avatars), [base, avatars])
  const stage = useRef<HTMLDivElement>(null)
  useHudScale(stage)
  const parts = Object.entries(MODULES).filter(([, m]) => typeof m.preview === 'function')
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: '#000' }}>
      <div ref={stage} className="hud-stage" data-hud-stage data-fixture={fx.name} style={{ width: 'min(100vw, calc(100vh * 16 / 9))', aspectRatio: '16 / 9', background: BG }}>
        <div className="hud">
          {sub === 'blocks' || !parts.length ? <Blocks fx={fx} /> : parts.map(([path, m]) => <Fragment key={path}>{m.preview!(fx)}</Fragment>)}
        </div>
      </div>
    </div>
  )
}

/** iconBitmaps wie für die Überkopf-Schilder der Engine, auf ein Canvas gezeichnet */
function Bitmaps({ names }: { names: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    iconBitmaps(names, 48).then(bm => {
      const g = ref.current?.getContext('2d')
      let x = 0
      for (const n of names) { const b = bm.get(n); if (b && g) { g.drawImage(b, x, 0); x += b.width + 16 } }
      ref.current?.setAttribute('data-bitmaps', String(bm.size))
    })
  }, [names.join()])
  return <canvas ref={ref} width={900} height={48} style={{ alignSelf: 'flex-start' }} title="iconBitmaps (engine labels)" />
}

/** Bausteine: Avatare (Bild oder Initialen), alle Icons (Maske getönt + Original), Bitmaps für die Engine, Stratum2 */
function Blocks({ fx }: { fx: HudFixture }) {
  const m = useHudAssets()
  const names = m ? Object.keys(m.icons).filter(k => !k.startsWith('eq/') || /^eq\/(ak47|m4a1_silencer|awp|usp_silencer|glock|deagle|knife|flashbang|smokegrenade|hegrenade|molotov|incgrenade|decoy|c4|defuser)$/.test(k))
    : ['AK-47', 'M4A1-S', 'AWP', 'USP-S', 'Flashbang', 'Smoke Grenade', 'High Explosive Grenade', 'Molotov', 'C4 Explosive', 'ui/defuser', 'hud/teamcounter/armor_helmet', 'ui/kill']
  return (
    <div data-hud="blocks" style={{ position: 'absolute', left: 40, top: 40, width: 1840, display: 'flex', flexDirection: 'column', gap: 18, padding: 20, background: 'rgba(0,0,0,.55)' }}>
      <style>{'.hud-blocks .hud-av { width: 58px; height: 64px } .hud-blocks .hud-img { height: 26px }'}</style>
      <div style={{ font: '700 20px var(--f)' }}>
        {m ? `CS2 HUD assets · patch ${m.patch} · ${Object.keys(m.icons).length} icons · ${m.fonts.length} fonts` : 'No CS2 HUD assets: bundled icons, system font'}
      </div>
      <div className="hud-blocks" style={{ display: 'flex', gap: 10 }}>
        {fx.view.players.map(p => <Avatar key={p.steamid} steamid={p.steamid} url={p.avatar} name={p.name} side={p.side} />)}
      </div>
      <div className="hud-blocks" style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center', fontSize: 30 }}>
        {names.map(n => (
          <span key={n} title={n} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', color: n.startsWith('ui/') ? 'var(--ct)' : 'var(--t)' }}>
            <HudIcon name={n} />{n.startsWith('eq/') || !n.includes('/') ? <HudIcon name={n} img /> : null}
          </span>
        ))}
      </div>
      <Bitmaps names={['eq/ak47', 'AK-47', 'eq/flashbang', 'ui/defuser_white', 'ui/bomb_icon', 'hud/deathnotice/icon_headshot']} />
      <div style={{ font: '700 50px var(--fm)', display: 'flex', gap: 40 }}>
        <span>9 : 5</span><span style={{ font: '700 30px var(--fm)' }}>1:08 · $16,000 · 30 | 90</span>
        <span style={{ font: '700 21px var(--f)', letterSpacing: '.6px', alignSelf: 'center' }}>ROUND 15 · TYRANNUS00 · Derdummbadss</span>
      </div>
    </div>
  )
}
