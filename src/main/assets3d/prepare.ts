// prepare3d: baut fehlende 3D-Assets eines Matches aus der lokalen CS2-Installation, sonst Cache. Läuft im utilityProcess (worker.ts).
// Ablage <userData>/assets3d/<patch>/ (patch = steam.inf ClientVersion), URL cs3d://assets3d/<patch>/<pfad> (Handler: index.ts):
//   stamp.json                          {pipeline, vrf, agents, skins, weapons, viewmodel, econ}; pipeline/vrf anders → ganzer Ordner neu, Teil-Stand anders → nur dieser Teil.
//                                       Neuer CS2-Patch: Ordner wird umbenannt, nicht neu gebaut
//   maps/<map>/<profile>/map.json       zuletzt geschrieben; key = Größe:mtime der Map-VPK + MAP_VERSION; + <map>.gltf/.bin, tex/, _lm.webp, _sky.webp|.hdr,
//                                       lut.bin, skybox/, floor.bin, probes.bin
//   items.json                          {pak, items}: Def-Tabellen aus items_game.txt, neu bei anderer pak01_dir.vpk
//   agents/clips_min2.glb, clips_meta2.json (zuletzt; CLIP_LIST + CLIP_LIST2), agents/<ordner>/<modell>.glb
//   weapons/<vmdl-name>.glb, weapons/roots2.json (Root-Versatz + Mündung + Tracer-Frequenz je Modell)
//   viewmodel/table3.json, vm_<variation>.glb + .json {dur, snd, win} (zuletzt), <vmdl-name>.glb; arms/<ordner>/<modell>.glb (Ego-Sicht)
//   world/table.json, world/<klasse>.glb + .json {roles, dur} (zuletzt): Oberkörper-Aktionsclips der Spielermodelle
//   weapons|viewmodel/<vmdl-name>.legacy.glb (Mesh body_legacy für Legacy-Skins), gloves/<modell>.glb
//   skins/models.json (Modell → composite_inputs), skins/kits/<paint>.json, skins/inputs/<vmat>.json, skins/tex/… (JSON zuletzt)
//   sounds/<datei>.wav|mp3, sounds/sound_map.json (zuletzt), sounds/sounds2.json (Clip-Sounds + Landungen, zuletzt)
//   econ/items.json, econ/stickers/<id>.webp + .json, econ/charms/<id>.glb, econ/weapons/<name>.json + _<hd|legacy>.png, econ/scratches.png:
//                                       Aufkleber/Anhänger (econ.ts), nur was im Match vorkommt
// Ältere Dateien (clips_min.glb, table2.json) bleiben liegen. Zwischenexporte liegen in <patch>/tmp und werden am Ende gelöscht.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PIPELINE_VERSION, assetUrl, type AgentAssets, type AssetProfile, type Assets3D, type EconAssets, type MapAssetManifest, type PrepareProgress, type PreviewAssets, type SkinAssets,
  type SoundMap, type WeaponAssets,
} from '../../shared/assets3d.ts'
import { AGENT_DEFAULT } from '../../shared/cs3d.ts'
import { VRF_VERSION, ensureVrf, fileKey, findCS2, lanes, vrf, vrfIdle, writeAtomic } from './cs2.ts'
import { MAP_VERSION, buildMap, type Ctx, type MapBuild } from './map.ts'
import {
  buildAgents, buildArms, buildClips, buildGloves, buildVmClips, buildVmWeapons, buildWeapons, buildWorldClips, parseItems, vmTable, vmVariation,
  weaponAsset, weaponFile, weaponRoots, worldTable, type Items, type VmVariation, type WeaponModel, type WorldVariation,
} from './models.ts'
import { buildEcon } from './econ.ts'
import { buildSkins, inputsFile, modelInputs, type KitNeed, type ModelInputs } from './skins.ts'
import { buildClipSounds, buildSounds, CLIP_SOUNDS_V, type ClipSounds } from './sounds.ts'

export interface PrepareOpts {
  /** app.getPath('userData') */
  root: string
  map: string
  /** m_nPawnCharacterDefIndex aller Spieler/Seiten (0/unbekannt erlaubt) */
  agents: number[]
  /** item_def_idx (CS3D header.weapons + Messer aus Player3D.knife) */
  weapons: number[]
  /** Lackierungen von Waffen (header.skins) und Handschuhen (Player3D.glove); fehlt → keine Skins */
  skins?: { def: number; paint: number }[]
  /** Aufkleber-/Anhänger-IDs und Waffen-defs mit Aufklebern (header.skins); fehlt → ohne */
  econ?: { stickers: number[]; charms: number[]; defs: number[] }
  profile: AssetProfile
  /**
   * Utility-Vorschau eines Lineups ohne Demo: Map + Vorschau-Kit = Standard-Agenten T/CT (Modell, Clips, Ego-Arme) und weapons (die
   * Granaten) mit Ego- und Welt-Clips; ohne C4, Skins, Aufkleber und Sounds. Das Kit ist optional: Fehler darin → nur die Map
   */
  preview?: boolean
}

/** Granaten (Projektil = gleiches Modell) und C4 sind immer dabei (nicht in der Vorschau) */
const ALWAYS_WEAPONS = [43, 44, 45, 46, 47, 48, 49]
const STAGES: Record<PrepareProgress['stage'], [number, number]> = {
  locate: [0, 2], vrf: [2, 8], map: [8, 70], agents: [70, 84], weapons: [84, 91], skins: [91, 96], sounds: [96, 99], done: [100, 100],
}

export function prepare3d(o: PrepareOpts & { preview: true }, onProgress: (p: PrepareProgress) => void): Promise<PreviewAssets>
export function prepare3d(o: PrepareOpts, onProgress: (p: PrepareProgress) => void): Promise<Assets3D>
export async function prepare3d(o: PrepareOpts, onProgress: (p: PrepareProgress) => void): Promise<PreviewAssets | Assets3D> {
  if (!/^[a-z0-9_]+$/.test(o.map)) throw new Error(`Invalid map name: ${o.map}`)
  // nach der Map laufen die Stufen im Vordergrund gleichzeitig (lane): Balken = Ende der Map + Summe der Stufenstände (nacheinander wie früher)
  const after = new Map<PrepareProgress['stage'], number>()
  const report = (stage: PrepareProgress['stage'], f: number, msg: string) => {
    const [a, b] = STAGES[stage]
    f = Math.min(1, Math.max(0, f))
    let pct = a + (b - a) * f
    if (a >= STAGES.agents[0] && stage !== 'done') {
      after.set(stage, Math.max(after.get(stage) ?? 0, f))
      pct = STAGES.agents[0]
      for (const [k, x] of after) pct += (STAGES[k][1] - STAGES[k][0]) * x
    }
    onProgress({ stage, pct: Math.round(pct), msg })
  }
  report('locate', 0, 'Locating Counter-Strike 2')
  const cs2 = findCS2()
  const exe = await ensureVrf(join(o.root, 'tools', 'vrf'), f => report('vrf', f, 'Downloading Source 2 Viewer'))
  const base = join(o.root, 'assets3d'), P = join(base, cs2.patch)
  // fehlt/kaputt (Abbruch beim Schreiben) → null = neu bauen
  const readJson = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
  // CS2-Update: Ordner des alten Patches übernehmen statt alles neu zu bauen (7 min). Die Map hängt an ihrer VPK, items.json an pak01.
  // shortcut: Agenten/Waffen/Sounds bleiben bis zur nächsten PIPELINE_VERSION, auch wenn Valve ein vorhandenes Modell ändert
  // (neue Modelle werden gebaut); bei Bedarf Schlüssel je Asset aus den CRCs im pak01_dir.vpk-Verzeichnis
  mkdirSync(base, { recursive: true })
  const old = readdirSync(base).filter(d => d !== cs2.patch && /^m?\d+$/.test(d))
  if (!existsSync(P) && old.length) try { renameSync(join(base, old[0]), P) } catch {}
  const st = readJson(join(P, 'stamp.json'))
  if (st?.pipeline !== PIPELINE_VERSION || st?.vrf !== VRF_VERSION) rmSync(P, { recursive: true, force: true })
  mkdirSync(P, { recursive: true })
  // Teil-Stände statt PIPELINE_VERSION (der baut alles neu): anderer Wert → nur diese Teile löschen, sie entstehen beim Bedarf neu.
  // agents 2 = ORM.G aus g_tAnisoGloss (nur Modell-Ordner, Clips bleiben), skins 2 = Kits mit vars/tex/rolls, Handschuhe alt + neu, Legacy-Grundfarbe
  // weapons 2 = Normal-Maps ohne Alpha (vorher von WebP genullt), Dual Berettas mit Knoten 'left' (nur Waffen-GLBs, roots bleiben)
  // viewmodel 2 = Ego-Waffen mit denselben Normal-Maps ohne Alpha (nur Waffen-GLBs; Clips vm_*, table3.json und arms/ bleiben)
  // econ 1 = Aufkleber/Anhänger (econ.ts)
  const parts: Record<string, number> = { agents: 2, skins: 2, weapons: 2, viewmodel: 2, econ: 1 }
  if (st?.weapons !== parts.weapons && existsSync(join(P, 'weapons'))) for (const f of readdirSync(join(P, 'weapons'))) if (f.endsWith('.glb')) rmSync(join(P, 'weapons', f), { force: true })
  if (st?.viewmodel !== parts.viewmodel && existsSync(join(P, 'viewmodel'))) for (const f of readdirSync(join(P, 'viewmodel'))) if (f.endsWith('.glb') && !f.startsWith('vm_')) rmSync(join(P, 'viewmodel', f), { force: true })
  if (st?.agents !== parts.agents && existsSync(join(P, 'agents'))) for (const d of readdirSync(join(P, 'agents'), { withFileTypes: true })) if (d.isDirectory()) rmSync(join(P, 'agents', d.name), { recursive: true, force: true })
  if (st?.skins !== parts.skins) rmSync(join(P, 'skins'), { recursive: true, force: true })
  if (st?.econ !== parts.econ) rmSync(join(P, 'econ'), { recursive: true, force: true })
  writeFileSync(join(P, 'stamp.json'), JSON.stringify({ pipeline: PIPELINE_VERSION, vrf: VRF_VERSION, ...parts }))
  // Reste älterer Patches (Platz auf C:)
  for (const d of readdirSync(base)) if (d !== cs2.patch && /^m?\d+$/.test(d)) rmSync(join(base, d), { recursive: true, force: true })
  const tmp = join(P, 'tmp'), log = join(P, 'build.log')
  rmSync(tmp, { recursive: true, force: true })
  if (existsSync(log) && statSync(log).size > 5e6) rmSync(log)
  const url = (rel: string) => assetUrl(`assets3d/${cs2.patch}/${rel}`)
  const ctx = (stage: PrepareProgress['stage'], a = 0, b = 1): Ctx => ({ cs2, exe, log, step: (f, msg) => report(stage, a + (b - a) * f, msg) })
  const work = (name: string) => { const d = join(tmp, name); mkdirSync(d, { recursive: true }); return d }
  // Bauzeit der Teile aus Paket A (Clip-Sounds, Welt-Clips, Zusatz-Clips) → build.log; Ziel ≤ 60 s beim ersten, 0 s beim zweiten Start
  const built: [string, number][] = [], t0 = Date.now()
  const timed = async <T>(name: string, f: () => T | Promise<T>, into = built) => { const t = Date.now(); try { return await f() } finally { into.push([name, (Date.now() - t) / 1000]) } }
  // unabhängiger Teil nach der Map (lane, cs2.ts); alle laufen zu Ende, bevor tmp gelöscht wird. Dauer (ab Start der Teile) → build.log
  const lane = lanes(), started: Promise<unknown>[] = [], spans: [string, number][] = []
  const part = <T>(name: string, f: () => Promise<T>) => { const p = lane(() => timed(name, f, spans)); started.push(p); return p }
  const logTimes = () => {
    const lines = [
      built.length && `[prepare3d] new parts: ${built.map(([n, s]) => `${n} ${s.toFixed(1)} s`).join(', ')}; total ${built.reduce((a, [, s]) => a + s, 0).toFixed(1)} s`,
      spans.some(([, s]) => s >= 1) && `[prepare3d] parts: ${spans.map(([n, s]) => `${n} ${s.toFixed(1)} s`).join(', ')}; build ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    ].filter(Boolean)
    for (const line of lines) { appendFileSync(log, line + '\n'); console.log(line) }
  }
  let map: MapAssetManifest | undefined

  try {
    // ---- Map
    const mapRel = `maps/${o.map}/${o.profile}`, mapDir = join(P, mapRel), mapJson = join(mapDir, 'map.json')
    const mapVpk = join(cs2.csgo, 'maps', `${o.map}.vpk`)
    if (!existsSync(mapVpk)) throw new Error(`Map ${o.map} is not installed in CS2.`)
    const mapKey = `${fileKey(mapVpk)}:v${MAP_VERSION}`
    let mb: MapBuild & { key: string } = readJson(mapJson)
    if (mb?.key !== mapKey) {
      // Export braucht bis 1.5 GB Zwischenplatz
      const free = statfsSync(P), freeGB = free.bavail * free.bsize / 1e9
      if (freeGB < 3) throw new Error(`Not enough disk space for the 3D map (${freeGB.toFixed(1)} GB free, 3 GB needed).`)
      rmSync(mapDir, { recursive: true, force: true })
      mb = { ...await timed('map', () => buildMap(ctx('map'), o.map, o.profile, mapDir, work('map')), spans), key: mapKey }
      rmSync(join(tmp, 'map'), { recursive: true, force: true })
      writeAtomic(mapJson, JSON.stringify(mb))
    }
    report('map', 1, 'Map ready')
    map = {
      map: o.map, profile: o.profile, glb: url(`${mapRel}/${mb.glb}`), lightmap: url(`${mapRel}/${mb.lightmap}`),
      sky: mb.sky && url(`${mapRel}/${mb.sky}`), skyHdr: mb.skyHdr && url(`${mapRel}/${mb.skyHdr}`), lut: mb.lut && url(`${mapRel}/${mb.lut}`),
      skybox: mb.skybox && { ...mb.skybox, glb: url(`${mapRel}/${mb.skybox.glb}`), ...mb.skybox.lightmap && { lightmap: url(`${mapRel}/${mb.skybox.lightmap}`) } },
      floor: url(`${mapRel}/${mb.floor}`), probes: url(`${mapRel}/${mb.probes}`), settings: mb.settings,
    }

    // ---- Def-Tabellen
    // ':3' = mit gloves/kits/kit.guns (ältere items.json neu parsen)
    const itemsFile = join(P, 'items.json'), pakKey = `${fileKey(cs2.pak)}:3`, it = readJson(itemsFile)
    let items: Items = it?.pak === pakKey ? it.items : null
    if (!items) { // neue Agenten/Waffen nach jedem CS2-Update
      const d = work('items')
      vrf(exe, ['-i', cs2.pak, '-f', 'scripts/items/items_game.txt', '-o', d], log)
      items = parseItems(readFileSync(join(d, 'scripts', 'items', 'items_game.txt'), 'utf8'))
      writeAtomic(itemsFile, JSON.stringify({ pak: pakKey, items }))
    }

    // Ab hier unabhängige Teile (part → lane, cs2.ts): im Hintergrund nacheinander wie bisher, wartet die 3D-Ansicht gleichzeitig.
    // Modell-Exporte laufen auch dann einzeln (vrfAsync, RAM). Ergebnisse setzen die Teile in der alten Reihenfolge zusammen.
    const agDir = join(P, 'agents')
    const models: AgentAssets['models'] = {}
    for (const def of new Set([...o.agents, AGENT_DEFAULT.T, AGENT_DEFAULT.CT])) if (items.agents[def]) models[def] = items.agents[def]
    // roots2 = mit tracer (weapons.vdata); roots.json davor bleibt liegen
    const wDir = join(P, 'weapons'), rootsFile = join(wDir, 'roots2.json')
    mkdirSync(wDir, { recursive: true })
    const defs = [...new Set([...o.weapons, ...o.preview ? [] : ALWAYS_WEAPONS])].filter(d => items.weapons[d])
    const wModels = [...new Set(defs.map(d => items.weapons[d].model))]
    const roots: Record<string, WeaponModel> = readJson(rootsFile) ?? {}
    const noRoot = wModels.filter(m => !roots[m])
    if (noRoot.length) { Object.assign(roots, weaponRoots(ctx('weapons'), noRoot, work('wdata'))); writeAtomic(rootsFile, JSON.stringify(roots)) }
    // Skins: composite_inputs je Modell (2 Header-Dumps < 2 s); Legacy-Kits brauchen bei Modellen mit hd + legacy das Mesh body_legacy
    const skDir = join(P, 'skins'), modelsFile = join(skDir, 'models.json')
    // Def unbekannt (CS2 älter als Demo, neues Messer) → weglassen, sonst TypeError bei items.weapons[def].model.
    // Kit passt nicht zur Waffe (Demo-Props beim Waffenwechsel versetzt, z. B. M4A4 mit M4A1-S-Kit) → weglassen = Vanilla
    const fits = (s: { def: number; paint: number }) => { const w = items.weapons[s.def], g = items.kits[s.paint].guns; return !w || !g || /^weapon_(knife|bayonet)/.test(w.cls) || g.includes(w.cls) }
    const paints = [...new Map((o.skins ?? []).filter(s => s.paint > 0 && items.kits[s.paint] && (items.weapons[s.def] || items.gloves[s.def]) && fits(s)).map(s => [`${s.def}_${s.paint}`, s])).values()]
    const wPaints = paints.filter(s => items.weapons[s.def]), gPaints = paints.filter(s => items.gloves[s.def])
    let mInputs: Record<string, ModelInputs> = readJson(modelsFile) ?? {}
    try {
      const noInputs = [...new Set(wPaints.map(s => items.weapons[s.def].model))].filter(m => !mInputs[m])
      if (noInputs.length) { mkdirSync(skDir, { recursive: true }); mInputs = { ...mInputs, ...modelInputs(ctx('weapons'), noInputs, work('skinmodels')) }; writeAtomic(modelsFile, JSON.stringify(mInputs)) }
    } catch (e) { console.warn('skin inputs skipped:', e) }
    const legacy = new Set(wPaints.filter(s => items.kits[s.paint].legacy).map(s => items.weapons[s.def].model).filter(m => mInputs[m]?.legacy && mInputs[m]?.hd))

    // ---- Agenten
    const agentsP = part('agents', async (): Promise<AgentAssets> => {
      report('agents', 0, 'Exporting agent animations')
      const clipMeta: AgentAssets['clipMeta'] = readJson(join(agDir, 'clips_meta2.json')) ?? await timed('agent clips', () => buildClips(ctx('agents'), agDir, work('clips')))
      report('agents', 0.3, 'Agent animations ready')
      const missing = [...new Set(Object.values(models))].filter(m => !existsSync(join(agDir, `${m}.glb`)))
      await buildAgents({ ...ctx('agents'), step: (f, m) => report('agents', 0.3 + 0.7 * f, m) }, agDir, work('agents'), missing)
      return {
        clips: url('agents/clips_min2.glb'), clipMeta,
        models: Object.fromEntries(Object.entries(models).map(([d, m]) => [d, url(`agents/${m}.glb`)])), arms: {},
      }
    })

    // ---- Waffen (+ Granaten/C4)
    const weaponsP = part('weapons', async () => {
      await buildWeapons(ctx('weapons', 0, 0.5), wDir, work('weapons'), wModels, legacy)
      const weapons: WeaponAssets = {}
      for (const d of defs) {
        const w = items.weapons[d], g = weaponFile(w.model), lg = weaponFile(w.model, true)
        weapons[d] = weaponAsset(w, roots[w.model], existsSync(join(wDir, g)) ? url(`weapons/${g}`) : undefined)
        if (legacy.has(w.model) && existsSync(join(wDir, lg))) weapons[d].legacyGlb = url(`weapons/${lg}`)
      }
      return weapons
    })

    // ---- Ego-Sicht: Clip-Tabelle, Clips je Variation, Waffen mit Skelett, Arme je Agent. Optional: Fehler → ohne Viewmodel weiter.
    // Clips, Waffen und Arme als eigene Teile, damit sich ihre Stapel mit denen der anderen Teile abwechseln
    // table3 = mit C4/Medi-Shot (Clips am Wurzelgraphen) und Inspect/Pin/Unterhand/Messer-Treffer/Schalldämpfer/Elites rechts
    const vmDir = join(P, 'viewmodel'), armsDir = join(P, 'arms'), tableFile = join(vmDir, 'table3.json')
    let table: Record<string, VmVariation> | null = readJson(tableFile)
    try { if (!table) { mkdirSync(vmDir, { recursive: true }); table = await timed('viewmodel table', () => vmTable(ctx('weapons'), work('vm'))); writeAtomic(tableFile, JSON.stringify(table)) } }
    catch (e) { console.warn('first-person view skipped:', e) }
    const vt = table ?? {}, vars = new Map(defs.map(d => [d, vmVariation(items.weapons[d].cls)] as const).filter(([, v]) => vt[v]))
    const vmPart = (name: string, f: () => Promise<unknown>) => part(name, async () => { try { await f(); return true } catch (e) { console.warn('first-person view skipped:', e); return false } })
    const vmDone = table && [
      vmPart('viewmodel clips', async () => {
        report('weapons', 0.5, 'Preparing first-person view')
        // vm_<v>.json ohne dur = Bau vor den Clip-Ereignissen → neu
        const noClips = [...new Set(vars.values())].filter(v => !readJson(join(vmDir, `vm_${v}.json`))?.dur)
        if (noClips.length) await timed('viewmodel clips', () => buildVmClips(ctx('weapons', 0.5, 0.7), vmDir, work('vmclips'), noClips.map(v => [v, vt[v]])))
      }),
      vmPart('viewmodel weapons', () => buildVmWeapons(ctx('weapons', 0.7, 0.85), vmDir, work('vmweapons'), [...new Set([...vars.keys()].map(d => items.weapons[d].model))], legacy)),
      vmPart('arms', () => {
        const ak = vt.ak47 ?? Object.values(vt)[0]
        return buildArms(ctx('weapons', 0.85, 1), armsDir, work('arms'), [...new Set(Object.values(models))].filter(m => !existsSync(join(armsDir, `${m}.glb`))), ak.paths[ak.roles.idle!])
      }),
    ]
    if (vmDone) part('viewmodel', async () => {
      if (!(await Promise.all(vmDone)).every(Boolean)) return
      const [weapons, agents] = await Promise.all([weaponsP, agentsP])
      for (const [d, v] of vars) {
        const m = items.weapons[d].model, g = weaponFile(m), lg = weaponFile(m, true), j = readJson(join(vmDir, `vm_${v}.json`))
        if (j?.dur && existsSync(join(vmDir, g))) weapons[d].vm = { glb: url(`viewmodel/${g}`), clips: url(`viewmodel/vm_${v}.glb`), roles: vt[v].roles, dur: j.dur, snd: j.snd, win: j.win }
        if (weapons[d].vm && legacy.has(m) && existsSync(join(vmDir, lg))) weapons[d].vm!.legacyGlb = url(`viewmodel/${lg}`)
      }
      for (const [d, m] of Object.entries(models)) if (existsSync(join(armsDir, `${m}.glb`))) agents.arms[+d] = url(`arms/${m}.glb`)
    })

    // ---- Welt-Aktionsclips der Spielermodelle (Oberkörper) nur für Waffen des Matches. Optional: Fehler → Spieler nur mit Fortbewegung
    part('world', async () => { try {
      const wlDir = join(P, 'world'), wtFile = join(wlDir, 'table.json')
      let wt: Record<string, WorldVariation> = readJson(wtFile)
      if (!wt) { mkdirSync(wlDir, { recursive: true }); wt = await timed('world table', () => worldTable(ctx('weapons'), work('wt'))); writeAtomic(wtFile, JSON.stringify(wt)) }
      const wdefs = [...new Set(o.weapons)].filter(d => items.weapons[d] && wt[vmVariation(items.weapons[d].cls)])
      const classes = [...new Set(wdefs.map(d => items.weapons[d].cls))]
      const noWorld = classes.filter(cls => !existsSync(join(wlDir, `${cls}.json`)))
      if (noWorld.length) await timed('world clips', () => buildWorldClips(ctx('weapons', 1, 1), wlDir, work('world'), noWorld.map(cls => [cls, wt[vmVariation(cls)]])))
      const weapons = await weaponsP
      for (const d of wdefs) {
        const cls = items.weapons[d].cls, j = readJson(join(wlDir, `${cls}.json`))
        if (j && weapons[d]) weapons[d].world = { clips: url(`world/${cls}.glb`), roles: j.roles, dur: j.dur }
      }
    } catch (e) { console.warn('player weapon animations skipped:', e) } })

    // ---- Handschuhe + Skins (Kit-Rezepte, composite_inputs, Texturen). Optional: Bau-Fehler → nur Neues fehlt, Gecachtes wird trotzdem geladen
    const gloves: Record<number, string> = {}, skins: SkinAssets = {}
    const gDir = join(P, 'gloves'), gModels = [...new Set(gPaints.map(s => items.gloves[s.def]))]
    // Legacy-Kit → Legacy-Material; Messer (ein Material) und Modelle ohne Legacy-Material → hd
    const inputsOf = (s: { def: number; paint: number }) => { const mi = mInputs[items.weapons[s.def].model] ?? {}; return (items.kits[s.paint].legacy ? mi.legacy : mi.hd) ?? mi.hd ?? mi.legacy }
    part('gloves', async () => { try {
      report('skins', 0, 'Exporting gloves')
      await buildGloves(ctx('skins', 0, 0.2), gDir, work('gloves'), gModels.filter(m => !existsSync(join(gDir, weaponFile(m)))))
    } catch (e) { console.warn('gloves skipped:', e) } })
    part('skins', async () => { try {
      const needKits: KitNeed[] = [...new Map(paints.map(s => [s.paint, { paint: s.paint, kit: items.kits[s.paint], glove: !!items.gloves[s.def] }])).values()]
        .filter(k => !existsSync(join(skDir, 'kits', `${k.paint}.json`)))
      const needInputs = [...new Set(wPaints.map(inputsOf))].filter((v): v is string => !!v && !existsSync(join(skDir, 'inputs', inputsFile(v))))
      if (needKits.length || needInputs.length) {
        // VRF-Export bis ~1 GB Zwischenplatz (PNG); C: ist oft knapp
        const free = statfsSync(P), freeGB = free.bavail * free.bsize / 1e9
        if (freeGB < 2) throw new Error(`Not enough disk space for weapon skins (${freeGB.toFixed(1)} GB free, 2 GB needed).`)
        await buildSkins(ctx('skins', 0.2, 1), P, work('skins'), needKits, needInputs)
      }
    } catch (e) { console.warn('skins skipped:', e) } })

    // ---- Aufkleber/Anhänger: nur was im Match vorkommt. Optional: Fehler → ohne. Kurz (~7 s), läuft neben den Skins: nur Meldung, kein Balken-Anteil
    const econP = part('econ', async (): Promise<EconAssets | undefined> => { try {
      const e = o.econ
      if (e && (e.stickers.length || e.charms.length)) {
        const defs = Object.fromEntries(e.defs.filter(d => items.weapons[d]).map(d => [d, items.weapons[d].model]))
        return await buildEcon(ctx('skins', 0, 0), P, work('econ'), { stickers: e.stickers, charms: e.charms, models: [...new Set(Object.values(defs))], defs }, url)
      }
    } catch (e) { console.warn('stickers/charms skipped:', e) } })

    // ---- Sounds (die Vorschau spielt keinen Ton)
    const sDir = join(P, 'sounds'), smFile = join(sDir, 'sound_map.json')
    const soundsP = o.preview ? null : part('sounds', async (): Promise<SoundMap> => readJson(smFile) ?? buildSounds(ctx('sounds'), sDir, work('sounds')))

    const [agents, weapons, soundMap, econ] = await Promise.all([agentsP, weaponsP, soundsP, econP])
    await Promise.all(started) // Ego-Sicht/Welt-Clips ergänzen weapons/agents, Skins liegen danach auf der Platte
    if (!soundMap) { logTimes(); report('done', 1, 'Ready'); return { map, agents, weapons } } // Vorschau-Kit
    for (const s of gPaints) if (existsSync(join(gDir, weaponFile(items.gloves[s.def])))) gloves[s.def] = url(`gloves/${weaponFile(items.gloves[s.def])}`)
    // Pfade 'skins/tex/…' → URL; fehlende/kaputte JSONs → null
    const load = (f: string) => { try { return JSON.parse(readFileSync(f, 'utf8'), (_k, v) => typeof v === 'string' && v.startsWith('skins/') ? url(v) : v) } catch { return null } }
    for (const s of paints) {
      const kit = load(join(skDir, 'kits', `${s.paint}.json`)), key = `${s.def}_${s.paint}`
      if (!kit || kit.unsupported) continue
      if (kit.kind === 'glove' || kit.kind === 'glove2') { skins[key] = kit; continue }
      if (!items.weapons[s.def]) continue // Handschuh-Def ohne Handschuh-Kit; Schleife liegt außerhalb try, darf nicht werfen
      const iv = inputsOf(s), inputs = iv && load(join(skDir, 'inputs', inputsFile(iv))), m = items.weapons[s.def].model
      if (inputs) skins[key] = { kind: 'weapon', legacy: !!items.kits[s.paint].legacy && legacy.has(m), inputs, paint: kit.paint, roll: kit.roll, rolls: kit.rolls }
    }

    // Clip-Sounds (alle Soundevents der Viewmodel-Clips im Match) + Landungen; neu nur, wenn ein Event noch nie abgefragt wurde
    try {
      const s2File = join(sDir, 'sounds2.json'), need = [...new Set(Object.values(weapons).flatMap(w => Object.values(w.vm?.snd ?? {}).flatMap(s => s.map(x => x[1]))))]
      let s2: ClipSounds | null = readJson(s2File)
      if (!s2 || s2.v !== CLIP_SOUNDS_V || need.some(e => !s2!.seen.includes(e))) {
        const all = [...new Set([...s2?.seen ?? [], ...need])]
        s2 = await timed('clip sounds', () => buildClipSounds(ctx('sounds'), sDir, work('sounds2'), all))
      }
      soundMap.mixgroupVol = { ...s2.mixgroupVol, ...soundMap.mixgroupVol }
      Object.assign(soundMap.map, s2.map)
    } catch (e) { console.warn('clip sounds skipped:', e) }

    logTimes()
    report('done', 1, 'Ready')
    return {
      map, agents, weapons, gloves, skins, econ,
      sounds: { base: url('sounds/'), map: soundMap },
    }
  } catch (e) {
    if (!o.preview || !map) throw e
    console.warn('preview kit skipped:', e) // Vorschau dann nur mit der Map (ohne Hände, Granate als Ersatzkörper)
    report('done', 1, 'Ready')
    return { map }
  } finally {
    // nach einem Fehler laufende Teile und Exporte (auch die 3D-Skybox) zu Ende, sonst schreibt VRF in das gelöschte tmp
    await Promise.allSettled(started); await vrfIdle()
    rmSync(tmp, { recursive: true, force: true })
  }
}
