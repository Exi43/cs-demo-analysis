// Sounds (Port von spike/sounds select.mjs/compact.mjs): Zuordnung Spiel-Event → Soundevent → Dateien/Lautstärke/Kurven
// aus den echten Spieldaten (weapons.vdata, game_sounds_*.vsndevts, surfaceproperties, soundmixers), dann Export.
// Format: WAV (PCM16, mono, Ausklang gekürzt) bzw. MP3 wie im Spiel. Kein Opus: dafür bräuchte main ein neues Paket oder einen
// Renderer (WebCodecs); decodeAudioData liest WAV/MP3 direkt, der RAM im Renderer ist nach dem Dekodieren gleich (PCM).
// Kosten: ≈ 30 MB Platte je CS2-Patch statt 3.3 MB.
// Zusatz sounds2.json (eigener Bau, sound_map.json bleibt im Cache): clip = Soundevents der Viewmodel-Clips, land = Land_<Oberfläche>.StepLeft.
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SoundDef, SoundGroup, SoundMap } from '../../shared/assets3d.ts'
import { kv3, vrfAsync, writeAtomic } from './cs2.ts'
import type { Ctx } from './map.ts'

const META = [
  'soundevents/game_sounds_weapons.vsndevts_c', 'soundevents/game_sounds_footsteps.vsndevts_c', 'soundevents/game_sounds_player.vsndevts_c',
  'soundevents/game_sounds_world.vsndevts_c', 'soundevents/game_sounds_physics.vsndevts_c', 'scripts/weapons.vdata_c',
  'surfaceproperties/surfaceproperties.vsurf_c', 'scripts/surfaceproperties_footsteps.txt', 'scripts/soundmixers.txt',
]
const CAP_NEAR = 3, CAP_STEP = 4
// Untergründe ohne eigenes Schritt-Event (sounds-Spike)
const OVERRIDE: Record<string, string> = { wood_tree: 'wood', wood_dense: 'wood_solid', metal_dumpster: 'solidmetal', metal_sand_barrel: 'metalbarrel', pottery: 'concrete' }
type Groups = Record<string, Record<string, SoundDef[]>>

/** Spieldaten dekompilieren; Soundevents mit base-Vererbung, Suche ohne Groß/Klein, Def-Bau */
async function loadMeta(c: Ctx, work: string) {
  const meta = join(work, 'meta'); mkdirSync(meta, { recursive: true })
  await vrfAsync(c.exe, ['-i', c.cs2.pak, '-d', '-o', meta, '-f', META.join(',')], c.log)
  const read = (f: string) => kv3(readFileSync(join(meta, f.replace(/_c$/, '')), 'utf8'))

  // Soundevents (mit base-Vererbung), Suche ohne Groß/Klein
  const EV: Record<string, any> = {}
  for (const f of META.filter(f => f.startsWith('soundevents/'))) {
    try { for (const [k, v] of Object.entries(read(f))) if (v && typeof v === 'object') EV[k] = v } catch {}
  }
  const resolve = (k: string, seen = new Set<string>()): any => {
    const v = EV[k]
    if (!v?.base || seen.has(k)) return v
    seen.add(k)
    const b = resolve(v.base, seen)
    if (b) for (const [bk, bv] of Object.entries(b)) if (!(bk in v)) v[bk] = bv
    delete v.base
    return v
  }
  Object.keys(EV).forEach(k => resolve(k))
  const lower = new Map(Object.keys(EV).map(k => [k.toLowerCase(), k]))
  const ev = (name: string) => lower.get(name.toLowerCase())
  const filesOf = (v: any): string[] => Object.keys(v).filter(k => /^vsnd_files/.test(k)).flatMap(k => ([] as string[]).concat(v[k]))
  const def = (name: string, cap: number): SoundDef => {
    const v = EV[name]
    const d: SoundDef = {
      ev: name, vol: +(+(v.volume ?? 1)).toFixed(3), mix: v.mixgroup ?? 'All',
      files: filesOf(v).slice(0, cap).map(f => f.replace(/^sounds\//, '').replace(/\.vsnd$/, '')),
      curve: (v.distance_volume_mapping_curve ?? []).map((p: number[]) => [Math.round(p[0]), +p[1].toFixed(3)]),
    }
    if (v.pitch != null && v.pitch !== 1) d.pitch = v.pitch
    if (v.pitch_random_min != null || v.pitch_random_max != null) d.pr = [+(v.pitch_random_min ?? 0).toFixed(3), +(v.pitch_random_max ?? 0).toFixed(3)]
    if (v.delay) d.delay = v.delay
    if (v.position_offset?.[2]) d.z = v.position_offset[2]
    if (v.instance_limit) d.limit = v.instance_limit
    if (/localplayeronly/i.test(JSON.stringify(v.metadata ?? ''))) d.local = true // z. B. Ziehen, Pin, Inspect, *_Q (255 von 469 Clip-Sounds)
    return d
  }
  // Event + ausgewählte Kinder (Distant-/Smash-/Pop-/Mech-Schichten)
  const chain = (name: string, cap: number): SoundDef[] => {
    const n = ev(name)
    if (!n) return []
    const out = [def(n, cap)]
    for (const k of Object.keys(EV[n]).filter(k => /^soundevent_/.test(k))) for (const ch of ([] as string[]).concat(EV[n][k])) {
      const cn = ev(String(ch))
      if (cn && /(Distant|Smash|Pop|Mech)$/i.test(cn) && filesOf(EV[cn]).length) out.push(def(cn, /Distant/i.test(cn) ? 1 : cap))
    }
    if (out[0].local) for (const d of out) d.local = true // Kinder spielen nur mit dem Eltern-Event
    return out
  }
  /**
   * Untergrund (Physik-SurfaceProperty, klein geschrieben) → <prefix>_<Surface>.StepLeft (prefix 'CT'/'T' = Schritte, 'Land' = Landung),
   * notfalls über die base-Kette; Schlüssel `${surface}:${prefix}`
   */
  const stepTable = (prefixes: string[]) => {
    const walkleft: Record<string, string> = {}, base: Record<string, string> = {}
    for (const s of read('scripts/surfaceproperties_footsteps.txt')?.player?.SurfacePropertiesList ?? []) if (s.walkleft) walkleft[String(s.surfacePropertyName).toLowerCase()] = s.walkleft
    const surfaces = (read('surfaceproperties/surfaceproperties.vsurf_c')?.SurfacePropertiesList ?? []).map((s: any) => {
      const n = String(s.surfacePropertyName).toLowerCase()
      if (s.base) base[n] = String(s.base).toLowerCase()
      return n
    }) as string[]
    const norm = (s: string) => s.toLowerCase().replace(/_/g, '')
    const stepIdx: Record<string, string> = {}
    for (const k of Object.keys(EV)) { const m = /^(CT|T|Land)_(.+)\.StepLeft$/i.exec(k); if (m) stepIdx[m[1].toUpperCase() + ':' + norm(m[2])] = k }
    const out: Record<string, string> = {}
    for (const s0 of new Set([...surfaces, ...Object.keys(OVERRIDE)])) for (const team of prefixes) {
      const t = team.toUpperCase()
      let s: string | undefined = OVERRIDE[s0] ?? s0, hit: string | undefined
      for (let guard = 0; s && !hit && guard < 8; guard++) {
        hit = stepIdx[t + ':' + norm(s)]
        if (!hit && walkleft[s]) hit = stepIdx[t + ':' + norm(walkleft[s].replace(/\.StepLeft$/i, '').replace(/^ladder\.wood/i, 'wood_ladder'))]
        if (!hit) s = base[s]
      }
      out[`${s0}:${team}`] = hit ?? ev(`${team}_Default.StepLeft`) ?? `${team}_Default.StepLeft`
    }
    return out
  }
  return { read, EV, ev, def, chain, stepTable }
}

/** Dateien aller Defs exportieren und umwandeln (schon vorhandene bleiben), Defs ohne Datei weg; Rückgabe: Mix-Lautstärken (Default_Mix) */
async function exportSounds(c: Ctx, dir: string, work: string, M: Groups, read: (f: string) => any) {
  const have = (f: string) => ['.wav', '.mp3'].find(e => existsSync(join(dir, f + e)))
  const all = new Set<string>()
  for (const g of Object.values(M)) for (const defs of Object.values(g)) for (const d of defs) d.files.forEach(f => all.add(f))
  // Blöcke, damit die Kommandozeile kurz bleibt
  const list = [...all].filter(f => !have(f)), raw = join(work, 'snd'); mkdirSync(raw, { recursive: true })
  for (let i = 0; i < list.length; i += 100) {
    c.step(0.1 + 0.6 * i / list.length, 'Exporting sounds')
    await vrfAsync(c.exe, ['-i', c.cs2.pak, '-d', '-o', raw, '-f', list.slice(i, i + 100).map(f => `sounds/${f}.vsnd_c`).join(',')], c.log)
  }
  c.step(0.75, 'Converting sounds')
  for (const f of list) {
    const src = ['.wav', '.mp3'].map(e => join(raw, 'sounds', f + e)).find(existsSync)
    if (!src) continue
    const ext = src.slice(-4), dst = join(dir, f + ext)
    mkdirSync(dirname(dst), { recursive: true })
    const mono = ext === '.wav' ? monoWav(readFileSync(src)) : null
    if (mono) writeAtomic(dst, mono); else copyFileSync(src, dst)
  }
  for (const g of Object.values(M)) for (const [k, defs] of Object.entries(g)) {
    g[k] = defs.map(d => ({ ...d, files: d.files.flatMap(f => { const e = have(f); return e ? [f + e] : [] }) })).filter(d => d.files.length)
    if (!g[k].length) delete g[k]
  }
  // Mix-Lautstärken aus soundmixers.txt (Default_Mix)
  const mixgroupVol: Record<string, number> = {}
  const findMix = (o: any): any[] | undefined => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o.Default_Mix)) return o.Default_Mix
    for (const v of Object.values(o)) { const r = findMix(v); if (r) return r }
  }
  for (const e of findMix(read('scripts/soundmixers.txt')) ?? []) if (e?.mixgroup) mixgroupVol[e.mixgroup] = +e.vol
  for (const g of Object.values(M)) for (const defs of Object.values(g)) for (const d of defs) mixgroupVol[d.mix] ??= 1
  return mixgroupVol
}

/** baut dir/<datei>.wav|mp3 und dir/sound_map.json (zuletzt = fertig) */
export async function buildSounds(c: Ctx, dir: string, work: string): Promise<SoundMap> {
  const { read, EV, ev, def, chain, stepTable } = await loadMeta(c, work)

  // Waffe → Soundevent aus weapons.vdata (m_aShootSounds, _base-Vererbung)
  const WV = read('scripts/weapons.vdata_c')
  const wget = (k: string, f: string, depth = 0): any => { const v = WV[k]; if (!v || depth > 10) return undefined; return f in v ? v[f] : v._base ? wget(v._base, f, depth + 1) : undefined }
  const M: SoundMap['map'] = { weapon_fire: {}, weapon_fire_silenced: {}, detonate: {}, bomb: {}, footsteps: {}, player: {}, reload: {}, zoom: {} }
  for (const w of Object.keys(WV)) {
    if (!w.startsWith('weapon_') || w.endsWith('_prefab') || w === 'weapon_base' || /^weapon_(knife|c4|healthshot)/.test(w)) continue
    const s = wget(w, 'm_aShootSounds')
    if (!s?.WEAPON_SOUND_SINGLE) continue
    M.weapon_fire[w] = chain(s.WEAPON_SOUND_SINGLE, CAP_NEAR)
    if (wget(w, 'm_eSilencerType') !== 'WEAPONSILENCER_NONE' && s.WEAPON_SOUND_SPECIAL1) M.weapon_fire_silenced[w] = chain(s.WEAPON_SOUND_SPECIAL1, CAP_NEAR)
    if (s.WEAPON_SOUND_ZOOM_IN) M.zoom[w] = chain(s.WEAPON_SOUND_ZOOM_IN, 1)
    const pre = (ev(s.WEAPON_SOUND_SINGLE) ?? '').split('.')[0].toLowerCase()
    const parts = pre ? Object.keys(EV).filter(k => k.toLowerCase().startsWith(pre + '.') && /\.(clipout|clipin|boltpull|boltback|boltforward|slideback|sliderelease|pump|insertshell|boxout|boxin)$/i.test(k)) : []
    if (parts.length) M.reload[w] = parts.map(p => def(p, 1))
  }
  // Messer und Würfe kommen auch als weapon_fire
  M.weapon_fire['weapon_knife*'] = chain('Weapon_Knife.Slash', 2)
  const fixed: [SoundGroup, string, string, number][] = [
    ['weapon_fire', 'weapon_hegrenade', 'HEGrenade.Throw', 1], ['weapon_fire', 'weapon_flashbang', 'Flashbang.Throw', 1],
    ['weapon_fire', 'weapon_smokegrenade', 'SmokeGrenade.Throw', 1], ['weapon_fire', 'weapon_molotov', 'Molotov.Throw', 2],
    ['weapon_fire', 'weapon_incgrenade', 'IncGrenade.Throw', 2], ['weapon_fire', 'weapon_decoy', 'Decoy.Throw', 1],
    ['detonate', 'hegrenade_detonate', 'BaseGrenade.Explode', 2], ['detonate', 'flashbang_detonate', 'Flashbang.Explode', 2],
    ['detonate', 'smokegrenade_detonate', 'BaseSmokeEffect.Sound', 1], ['detonate', 'smokegrenade_expired', 'SmokeGrenade.Clear', 1],
    ['detonate', 'inferno_startburn:T', 'Molotov.Start', 2], ['detonate', 'inferno_startburn:CT', 'IncGrenade.Start', 2],
    ['detonate', 'inferno_loop', 'Inferno.Loop', 1], ['detonate', 'inferno_expire', 'Inferno.FadeOut', 1],
    ['detonate', 'grenade_bounce:he', 'HEGrenade.Bounce', 1], ['detonate', 'grenade_bounce:flash', 'Flashbang.Bounce', 1],
    ['detonate', 'grenade_bounce:smoke', 'SmokeGrenade.Bounce', 1], ['detonate', 'grenade_bounce:molotov', 'Molotov.Bounce', 2],
    ['detonate', 'grenade_bounce:inc', 'IncGrenade.Bounce', 2],
    ['bomb', 'bomb_planted', 'c4.plant', 1], ['bomb', 'beep', 'C4.PlantSound', 1], ['bomb', 'beep_last10s', 'C4.PlantSound_10sec', 1],
    ['bomb', 'explode_warning', 'C4.ExplodeTriggerTrip', 1], ['bomb', 'bomb_begindefuse', 'c4.disarmstart', 1], ['bomb', 'bomb_defused', 'c4.disarmfinish', 1],
    ['player', 'player_hurt_body', 'Player.DamageBody.Onlooker', 2], ['player', 'player_hurt_armor', 'Player.DamageBodyArmor.Onlooker', 2],
    ['player', 'player_hurt_head', 'Player.DamageHeadShot.Onlooker', 2], ['player', 'player_death', 'Player.DeathBody.Onlooker', 2],
    ['player', 'land', 'Default.Land', 2],
  ]
  for (const [g, k, e, cap] of fixed) M[g][k] = chain(e, cap)
  M.bomb.bomb_beginplant = [...chain('c4.initiate', 1), ...chain('c4.keypressquiet', 3)]
  M.bomb.bomb_exploded = [...chain('c4.explode', 1), ...chain('c4.explode.close', 1), ...chain('c4.shockwave.boom', 1)]

  // Schritte: Untergrund → <CT|T>_<Surface>.StepLeft
  const surfToStep = stepTable(['CT', 'T'])
  for (const se of new Set(Object.values(surfToStep))) if (EV[se]) M.footsteps[se] = [def(se, CAP_STEP)]
  for (const g of ['Gear.CT', 'Gear.T']) { const n = ev(g); if (n) M.footsteps[g] = [def(n, 2)] }

  const mixgroupVol = await exportSounds(c, dir, work, M as Groups, read)
  const sm: SoundMap = { mixgroupVol, surfToStep, map: M }
  writeAtomic(join(dir, 'sound_map.json'), JSON.stringify(sm))
  return sm
}

/** sounds2.json: seen = schon abgefragte Clip-Soundevents (auch ohne Def), damit der zweite Start nichts neu baut; v = CLIP_SOUNDS_V (2: SoundDef.local) */
export interface ClipSounds { v?: number; seen: string[]; mixgroupVol: Record<string, number>; map: { clip: Record<string, SoundDef[]>; land: Record<string, SoundDef[]> } }
export const CLIP_SOUNDS_V = 2

/**
 * Clip-Soundevents (WeaponAsset.vm.snd, Schlüssel = Event-Name) und Landungen (Oberfläche klein wie floor.bin → Land_<Oberfläche>.StepLeft,
 * aufgelöst wie die Schritte) → dir/<datei> + dir/sounds2.json (zuletzt = fertig). Vorhandene Dateien werden nicht neu exportiert.
 */
export async function buildClipSounds(c: Ctx, dir: string, work: string, events: string[]): Promise<ClipSounds> {
  const { read, EV, chain, def, stepTable } = await loadMeta(c, work)
  const clip: Record<string, SoundDef[]> = {}, land: Record<string, SoundDef[]> = {}
  for (const e of events) { const d = chain(e, CAP_NEAR); if (d.length) clip[e] = d }
  for (const [k, se] of Object.entries(stepTable(['Land']))) if (EV[se]) land[k.slice(0, k.lastIndexOf(':'))] = [def(se, CAP_STEP)]
  // Land_*-Varianten, die keine Oberfläche erreicht (z. B. Land_Weapon), unter ihrem eigenen Namen, damit jede abrufbar ist
  const used = new Set(Object.values(land).map(d => d[0].ev))
  for (const k of Object.keys(EV)) { const m = /^Land_(.+)\.StepLeft$/i.exec(k); if (m && !used.has(k)) land[m[1].toLowerCase()] ??= [def(k, CAP_STEP)] }
  const map = { clip, land }
  const mixgroupVol = await exportSounds(c, dir, work, map, read)
  const out: ClipSounds = { v: CLIP_SOUNDS_V, seen: events, mixgroupVol, map }
  writeAtomic(join(dir, 'sounds2.json'), JSON.stringify(out))
  return out
}

/** PCM16-WAV → mono (Mittel der Kanäle), Ausklang unter −60 dBFS abschneiden (+10 ms Blende), wenn das ≥ 0.1 s spart; sonst null */
export function monoWav(buf: Buffer): Buffer | null {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let o = 12, ch = 0, rate = 0, bits = 0, tag = 0, data: Buffer | null = null
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), sz = buf.readUInt32LE(o + 4)
    if (id === 'fmt ') { tag = buf.readUInt16LE(o + 8); ch = buf.readUInt16LE(o + 10); rate = buf.readUInt32LE(o + 12); bits = buf.readUInt16LE(o + 22) }
    else if (id === 'data') data = buf.subarray(o + 8, Math.min(buf.length, o + 8 + sz))
    o += 8 + sz + (sz & 1)
  }
  if (!data || tag !== 1 || bits !== 16 || !ch) return null
  const n = Math.floor(data.length / 2 / ch), s = new Int16Array(n)
  for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < ch; k++) v += data.readInt16LE((i * ch + k) * 2); s[i] = Math.round(v / ch) }
  let last = n - 1
  while (last > 0 && Math.abs(s[last]) < 33) last--
  const fade = Math.round(rate * 0.01)
  let len = n
  if (n - (last + 1 + fade) >= rate * 0.1) {
    len = last + 1 + fade
    for (let i = 0; i < fade; i++) s[last + 1 + i] = Math.round(s[last + 1 + i] * (1 - i / fade))
  }
  const out = Buffer.alloc(44 + len * 2)
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + len * 2, 4); out.write('WAVEfmt ', 8, 'ascii')
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(rate, 24)
  out.writeUInt32LE(rate * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii'); out.writeUInt32LE(len * 2, 40)
  for (let i = 0; i < len; i++) out.writeInt16LE(s[i], 44 + i * 2)
  return out
}
