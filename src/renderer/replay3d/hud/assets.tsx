// HUD-Bausteine: CS2-Icons + Stratum2 aus der lokalen CS2-Installation (api.hudAssets, nie im Repo), Steam-Avatare, Skalierung --s.
// Ohne Manifest (kein CS2, Fehler, alter Main-Prozess): gebündelte Waffen-Icons aus assets/weapons (wie weapons.tsx) und Systemschrift.
// Icon-Namen = Manifest-Schlüssel ('eq/ak47', 'ui/kill', 'hud/deathnotice/icon_headshot') oder v1-Waffenname ('AK-47', 'Flashbang').
import { useLayoutEffect, useState, useSyncExternalStore, type CSSProperties, type RefObject } from 'react'
import type { HudAssetManifest } from '../../../shared/hud'
import type { Side } from '../../../shared/model'
import { api } from '../../api'
import { weaponIcon } from '../../weapons'
import './base.css'

// Gleiche Dateien wie weapons.tsx → gleiche URLs; daraus wird der Datei-Schlüssel eines v1-Waffennamens zurückgerechnet
const URLS = import.meta.glob('../../assets/weapons/*.svg', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
const RAW = import.meta.glob('../../assets/weapons/*.svg', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>
const fileOf = (path: string) => path.slice(path.lastIndexOf('/') + 1, -4)
const KEY_OF_URL = new Map(Object.entries(URLS).map(([p, u]) => [u, fileOf(p)]))
/** UI-Icons ohne Manifest → ähnliches gebündeltes Equipment-Icon */
const FALLBACK: Record<string, string> = {
  'ui/defuser': 'defuser', 'ui/defuser_white': 'defuser', 'ui/bomb_icon': 'c4', 'ui/bomb_c4': 'c4', 'ui/armor': 'kevlar', 'ui/helmet': 'helmet',
  'hud/teamcounter/armor': 'kevlar', 'hud/teamcounter/armor_helmet': 'assaultsuit', 'hud/teamcounter/teamcounter_bomb-planted': 'planted_c4',
}

/** Manifest-Schlüssel zu einem Namen: 'ui/…' bleibt, v1-Waffenname → 'eq/<datei>' */
export function iconKey(name: string): string {
  if (name.includes('/')) return name
  const url = weaponIcon(name)
  return `eq/${(url && KEY_OF_URL.get(url)) ?? name.replace(/^weapon_/, '').toLowerCase()}`
}
const bundledFile = (key: string) => (key.startsWith('eq/') ? key.slice(3) : FALLBACK[key])
/** Bild-URL eines Icons (Manifest, sonst gebündelt), undefined = keins */
export function iconUrl(m: HudAssetManifest | null, name: string): string | undefined {
  const key = iconKey(name), file = bundledFile(key)
  return m?.icons[key] ?? (file ? URLS[`../../assets/weapons/${file}.svg`] : undefined)
}

// Manifest einmal je App-Lauf laden (Schriften registrieren), als kleiner Store für useSyncExternalStore
let current: HudAssetManifest | null = null
let loading: Promise<HudAssetManifest | null> | undefined
const subs = new Set<() => void>()
function loadAssets(): Promise<HudAssetManifest | null> {
  return (loading ??= (async () => {
    try {
      const m = await api.hudAssets()
      if ('error' in m) { console.warn('HUD assets:', m.error); return null }
      await Promise.all(m.fonts.map(async f => {
        try { document.fonts.add(await new FontFace(f.family, `url("${f.url}")`, { weight: String(f.weight), style: f.style }).load()) }
        catch (e) { console.warn(`HUD font ${f.family} ${f.weight}:`, e) }
      }))
      current = m
      subs.forEach(cb => cb())
      return m
    } catch (e) {
      console.warn('HUD assets unavailable:', e)
      return null
    }
  })())
}
const subscribe = (cb: () => void) => { subs.add(cb); void loadAssets(); return () => void subs.delete(cb) }
/** Manifest der CS2-HUD-Assets; null = (noch) keins → gebündelte Icons, Systemschrift */
export const useHudAssets = (): HudAssetManifest | null => useSyncExternalStore(subscribe, () => current)

/**
 * CS2-Icon. Standard: CSS-Maske, Farbe = currentColor, Größe per CSS (1em). img: weißes Original als <img> mit natürlicher Breite
 * (Waffen im Killfeed/Teamleisten, Höhe per CSS). Ohne Bild: leeres Element gleicher Größe.
 */
export function HudIcon({ name, img, className = '', title, style }: { name: string; img?: boolean; className?: string; title?: string; style?: CSSProperties }) {
  const url = iconUrl(useHudAssets(), name)
  if (img) return url ? <img className={`hud-img ${className}`} src={url} alt={title ?? name} title={title} style={style} draggable={false} /> : null
  return <i className={`hud-ico ${url ? '' : 'none'} ${className}`} title={title} style={url ? ({ ...style, '--m': `url("${url}")` } as CSSProperties) : style} />
}

const initials = (name: string) => (name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || '?').toUpperCase()
/** Steam-Profilbild (url aus api.avatars); ohne Bild oder bei Ladefehler Initialen auf Teamfarbe. Größe per CSS. */
export function Avatar({ steamid, url, name, side, className = '' }: { steamid: string; url: string | null; name: string; side: Side; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null)
  return (
    <div className={`hud-av ${side} ${className}`} title={name} data-steamid={steamid}>
      {initials(name)}
      {url && broken !== url && <img src={url} alt="" draggable={false} onError={() => setBroken(url)} />}
    </div>
  )
}

/** Setzt --s = Höhe / 1080 auf die Bühne (HUD-Maße in 1080p-px, .hud skaliert per zoom: var(--s)) */
export function useHudScale(stage: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const set = () => el.style.setProperty('--s', String(el.clientHeight / 1080 || 1))
    const ro = new ResizeObserver(set)
    set(); ro.observe(el)
    return () => ro.disconnect()
  }, [stage])
}

/**
 * Icons als ImageBitmap (Höhe h px, Seitenverhältnis bleibt) für die Überkopf-Schilder der Engine; Schlüssel = übergebener Name.
 * fetch → Blob → createImageBitmap; SVG über ein Blob-URL-Bild (createImageBitmap kann SVG-Blobs nicht), also kein cs3d-Bild im Canvas.
 * Fehlende/kaputte Icons fehlen in der Map.
 */
export async function iconBitmaps(names: readonly string[], h = 64): Promise<Map<string, ImageBitmap>> {
  const m = await loadAssets(), out = new Map<string, ImageBitmap>()
  await Promise.all([...new Set(names)].map(async name => {
    try {
      const key = iconKey(name), url = m?.icons[key], file = bundledFile(key), raw = file && RAW[`../../assets/weapons/${file}.svg`]
      const blob = url ? await (await fetch(url)).blob() : raw ? new Blob([await raw()], { type: 'image/svg+xml' }) : null
      if (!blob) return
      const svg = !url || /\.svg(\?|$)/i.test(url) || blob.type.includes('svg')
      out.set(name, svg ? await svgBitmap(blob, h) : await createImageBitmap(blob, { resizeHeight: h, resizeQuality: 'high' }))
    } catch (e) {
      console.warn(`HUD icon ${name}:`, e)
    }
  }))
  return out
}
async function svgBitmap(blob: Blob, h: number): Promise<ImageBitmap> {
  const src = URL.createObjectURL(new Blob([blob], { type: 'image/svg+xml' })), img = new Image()
  try {
    img.src = src
    await img.decode()
    const w = Math.max(1, Math.round((h * img.naturalWidth) / (img.naturalHeight || img.naturalWidth || 1)))
    return await createImageBitmap(img, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high' })
  } finally {
    URL.revokeObjectURL(src)
  }
}
