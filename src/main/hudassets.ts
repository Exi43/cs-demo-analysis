// HUD-Icons (Panorama-SVGs) und Stratum2-Schriften aus der lokalen CS2-Installation → <root>/assets3d/hud/<patch>/ (nie ins Repo).
// Einmal je CS2-Patch über die serial-Queue gebaut (VRF < 1 s), danach nur manifest.json; ausgeliefert über cs3d:// (handleCs3d).
// Liste wie spike/ui/assets-mockup/tools/mkicons.mjs; Equipment komplett (101 Waffen-/Ausrüstungs-Icons).
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assetUrl } from '../shared/assets3d.ts'
import type { HudAssetManifest } from '../shared/hud.ts'
import { ensureVrf, findCS2, vrf, writeAtomic } from './assets3d/cs2.ts'
import { serial } from './assets3d/index.ts'

const IMG = 'panorama/images/'
const UI = ['kill', 'crosshair_circle', 'bomb_c4', 'bomb_icon', 'defuser', 'defuser_white', 'clock', 'settings', 'camera', 'play', 'pause', 'skip',
  'message_arrow', 'shoppingcart', 'buyzone', 'health', 'armor', 'helmet', 'unmuted', 'muted', 'first_person', 'film', 'bullet', 'dollar_sign',
  'sound_1', 'sound_3', 'sound_off', 'timer', 'ct_silhouette', 'check', 'map_death', 'map_bombzone_a', 'map_bombzone_b', 'kill_headshot', 'elimination', 'exit']
const HUD = ['deathnotice/icon_headshot', 'deathnotice/penetrate', 'deathnotice/smoke_kill', 'deathnotice/blind_kill', 'deathnotice/noscope',
  'deathnotice/domination', 'double_arrows', 'teamcounter/armor', 'teamcounter/armor_helmet', 'teamcounter/teamcounter_bomb-planted', 'health_cross',
  'ammo_reserve', 'bullets', 'chevron_money']
const FACES: [family: string, file: string, weight: number][] = [['Stratum2', 'stratum2-regular.otf', 400], ['Stratum2', 'stratum2-medium.otf', 500],
  ['Stratum2', 'stratum2-bold.otf', 700], ['Stratum2', 'stratum2-black.otf', 900], ['Stratum2 Mono', 'stratum2regular_monodigit.ttf', 400],
  ['Stratum2 Mono', 'stratum2bold_monodigit.ttf', 700], ['Stratum2 Cond', 'stratum2condensed-bold.otf', 700]]

async function build(root: string): Promise<HudAssetManifest> {
  const cs2 = findCS2(), base = join(root, 'assets3d', 'hud'), out = join(base, cs2.patch), mf = join(out, 'manifest.json')
  if (!existsSync(mf)) await serial(async () => {
    if (existsSync(mf)) return // anderer Aufruf war in der Queue schneller
    const exe = await ensureVrf(join(root, 'tools', 'vrf'), () => {})
    rmSync(out, { recursive: true, force: true }) // Rest eines abgebrochenen Baus (manifest.json kommt zuletzt)
    const fonts = join(out, 'fonts'), log = join(out, 'vrf.log')
    mkdirSync(fonts, { recursive: true })
    vrf(exe, ['-i', cs2.pak, '-d', '-o', out, '-e', 'vsvg_c', '-f',
      [`${IMG}icons/equipment/`, ...UI.map(n => `${IMG}icons/ui/${n}.vsvg_c`), ...HUD.map(n => `${IMG}hud/${n}.vsvg_c`)].join(',')], log)
    // .uifont liegt lose im CS2-Ordner, VRF schreibt die Schriften neben die Eingabe (-o nur nötig, damit es überhaupt schreibt) → erst kopieren
    copyFileSync(join(cs2.csgo, 'panorama', 'fonts', 'stratum2.uifont'), join(fonts, 'stratum2.uifont'))
    vrf(exe, ['-i', join(fonts, 'stratum2.uifont'), '-d', '-o', fonts], log)
    rmSync(join(fonts, 'stratum2.uifont'))
    const url = (rel: string) => assetUrl(`assets3d/hud/${cs2.patch}/${rel}`), icons: Record<string, string> = {}
    const add = (key: string, rel: string) => { if (existsSync(join(out, rel))) icons[key] = url(rel) }
    for (const f of readdirSync(join(out, IMG, 'icons', 'equipment'))) if (f.endsWith('.svg')) add(`eq/${f.slice(0, -4)}`, `${IMG}icons/equipment/${f}`)
    for (const n of UI) add(`ui/${n}`, `${IMG}icons/ui/${n}.svg`)
    for (const n of HUD) add(`hud/${n}`, `${IMG}hud/${n}.svg`)
    const faces = FACES.filter(([, f]) => existsSync(join(fonts, f))).map(([family, f, weight]) => ({ family, weight, style: 'normal', url: url(`fonts/${f}`) }))
    if (Object.keys(icons).length < 40 || faces.length < FACES.length) throw new Error(`CS2 HUD files not found (${Object.keys(icons).length} icons, ${faces.length} fonts). Log: ${log}`)
    writeAtomic(mf, JSON.stringify({ patch: cs2.patch, icons, fonts: faces } satisfies HudAssetManifest))
    for (const d of readdirSync(base)) if (d !== cs2.patch) rmSync(join(base, d), { recursive: true, force: true }) // alte Patches
  })
  return JSON.parse(readFileSync(mf, 'utf8'))
}

let memo: Promise<HudAssetManifest> | null = null
/** IPC 'hud:assets': Manifest (ab dem zweiten Aufruf aus dem Speicher) oder { error } mit englischem Text */
export function hudAssets(root: string): Promise<HudAssetManifest | { error: string }> {
  const p = (memo ??= build(root))
  return p.catch(e => { if (memo === p) memo = null; return { error: String(e?.message ?? e) } }) // Fehler nicht merken: Retry baut neu
}
