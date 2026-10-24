// Spiel-Sounds wie CS2 (sounds- und animsound-Spike): Schüsse je Waffe (schallgedämpft), Würfe, Granaten inkl. Abpraller, Bombe mit
// beschleunigtem Piepen, Treffer/Tod, Zoom. Waffen-Geräusche (Ziehen, Nachladen, Bolzen/Pumpe, Inspect, Pin, C4 legen, Messer) zu den
// Zeiten der CS2-Viewmodel-Clips (WeaponAsset.vm.snd) an den Aktionen aus actions.ts, abgebrochen mit der Aktion. Clip-Sounds mit
// CS2-metadata localplayeronly (Ziehen, Pin, Inspect, leise *_Q …) hört nur der beobachtete Spieler in Ego-Sicht (Listener.ego), alle
// anderen nur die übertragenen (Nachladen, Bolzen, Messer, Wurf).
// Schritte/Landungen: ab CS3D v6 genau die Server-Sounds der Demo (CS2 mit mp_footsteps_serverside, MM + FACEIT). Ohne sie (ältere
// Importe) die an diesen Server-Schritten geeichte Regel stepCues; Absprung/Landung an player_footstep (ab v5), sonst aus jumps()/Fallhöhe.
// Lautstärke über die CS2-Distanzkurven, Richtung per StereoPanner relativ zur Kamera
// (kein PannerNode/THREE.PositionalAudio: 64 Stimmen mit Listener-Ramps 77–85 % eines Kerns, Gain+StereoPanner 3.6 %).
import { EV, FLAG, NADE, TELEPORT, newSample, roundAt, sampleTrack, soundHash, upperBound, type CS3D } from '../../../shared/cs3d'
import { floorLayer, type FloorGrid, type SoundDef, type SoundMap, type WeaponAssets } from '../../../shared/assets3d'
import type { Side } from '../../../shared/model'
import type { ActionKind, Listener } from '../contracts'
import { actionsOf, vmRole } from '../actions'
import type { Clock } from './clock'

/**
 * geplanter Sound: k = Typ für den Sound-Log (shot, zoom, player, bomb, nade, bounce, step, jump, land und die Clip-Typen aus CLIP),
 * t Demo-Sekunde, Position Source-Units, src = Quelle für Instanz-Limits, until = Loop-Ende (Demo-s)
 */
export interface Cue { k: string; t: number; defs: SoundDef[]; x: number; y: number; z: number; src: number; prio: number; until?: number }

/** Tempo ≠ 1: nur prio ≥ 1, über 2x nur prio 2 (Explosionen, Bombe) */
const MINOR = 0, NORMAL = 1, MAJOR = 2
const BOMB = 1000, NADE_SRC = 2000, C4 = 49
/**
 * Schritt-Regel ohne Server-Schritte, geeicht an 13 002 CS2-Schritten der user-demo (scripts/dev3d/steps-calib.ts):
 * hörbar ab AUDIBLE × Maxtempo der Waffe (client.dll: Anteil = Tempo/Bezug, Schwelle footstep_audible_threshold 0.55; Schritt-Anteil p1 0.54,
 * Kante zwischen 0.50 (3 %) und 0.55), Takt nach Zeit wie CS:GO: 0.3 s ab RUN × Maxtempo, sonst 0.4 s (Median 20 bzw. 26 Ticks),
 * erster Schritt FIRST s nach dem Losgehen (Median 0.27 s), unter der Schwelle hält der Takt HOLD s. Ergebnis: −4 % Schritte,
 * Mini-Schübe ≤ 3 Frames mit Ton 8 % (CS2 22 %, alte Regel 60 %). steps-calib.ts setzt Varianten über dieses Objekt.
 */
export const STEP_RULE = { HOLD: 0.35, FIRST: 0.27 }
const AUDIBLE = 0.55, RUN = 0.88
// Landung ohne player_footstep (CS3D < v5): Fallhöhe ab dem höchsten 16-Hz-Luft-Frame >= 340²/(2·800) u, d. h. Aufprall ab 340 u/s wie die
// Demo-Landungen; auch Stürze von Kanten (user-demo: 188/188 Demo-Landungen, 22 zusätzlich)
const LAND_DROP = 72
const BOUNCE = ['smoke', 'flash', 'he', 'molotov', 'inc', 'decoy']
/** Events mit eigenem Sound (Rest, z. B. item_pickup, weapon_reload: kein sampleTrack) */
const SOUND_EV = new Set<number>([EV.weapon_fire, EV.weapon_zoom, EV.player_hurt, EV.player_death, EV.bomb_beginplant, EV.bomb_planted, EV.bomb_begindefuse, EV.bomb_defused])
/** Aktion → Cue-Typ der Clip-Sounds; throw fehlt, den Wurf-Sound spielt weapon_fire */
const CLIP: Partial<Record<ActionKind, string>> = {
  draw: 'draw', reload: 'reload', reload_empty: 'reload', shoot: 'shoot', shoot_last: 'shoot', shoot_right: 'shoot', inspect: 'inspect',
  pullpin: 'pullpin', plant: 'plant', silencer_on: 'silencer', silencer_off: 'silencer',
  light: 'knife', light2: 'knife', heavy: 'knife', hit: 'knife', heavy_hit: 'knife', backstab: 'knife',
}

/** CS2 weapons.vdata m_flMaxSpeed [normal, gezoomt] je item_def_idx (Patch 2000934); fehlt = 250 (Messer, C4, Medi-Shot) */
// shortcut: Zeus steht in weapons.vdata mit 1.0 (Platzhalter) → 220 wie CS:GO; bei neuen Waffen Tabelle aus weapons.vdata nachziehen
const MAX_SPEED: Record<number, number | [number, number]> = {
  1: 230, 2: 240, 3: 240, 4: 240, 7: 215, 8: [220, 150], 9: [200, 100], 10: 220, 11: [215, 120], 13: 215, 14: 195, 16: 225, 17: 240, 19: 230,
  23: [235, 220], 24: 230, 25: 215, 26: 240, 27: 225, 28: 150, 29: 210, 30: 240, 31: 220, 32: 240, 33: 220, 34: 240, 35: 220, 36: 240,
  38: [215, 120], 39: [210, 150], 40: 230, 43: 245, 44: 245, 45: 245, 46: 245, 47: 245, 48: 245, 60: 225, 61: 240, 63: 240, 64: [180, 220],
}
/** Maxtempo (u/s) mit Waffe def, gezoomt = FLAG.scoped */
export const maxSpeed = (def: number, scoped: boolean) => { const s = MAX_SPEED[def] ?? 250; return typeof s === 'number' ? s : s[scoped ? 1 : 0] }

/** alle Sounds eines Matches, nach t sortiert; ohne weapons (keine Aktionen) keine Clip-Sounds und Sprünge, Landungen nur ohne player_footstep */
export function buildCues(d: CS3D, sm: SoundMap, sideOf: (r: number, p: number) => Side, floor?: FloorGrid, weapons?: WeaponAssets): Cue[] {
  const H = d.header, rate = H.tickrate, M = sm.map, out: Cue[] = [], S = newSample()
  const add = (k: string, tick: number, defs: SoundDef[] | undefined, x: number, y: number, z: number, src: number, prio: number, until?: number) => {
    if (defs?.length) out.push({ k, t: tick / rate, defs, x, y, z, src, prio, until })
  }
  let sr = -1 // Runde des letzten at()
  /** Spieler p bei tick nach S; false zwischen den Runden/ohne Spur */
  const at = (p: number, tick: number) => {
    const r = (sr = roundAt(d, tick)), k = r < 0 ? -1 : H.rounds[r].tracks.indexOf(p)
    if (k >= 0) sampleTrack(d, r, k, tick, S)
    return k >= 0
  }
  const surface = (x: number, y: number, z: number) => { const l = floor ? floorLayer(floor, x, y, z) : -1; return l < 0 ? 'concrete' : floor!.surfaces[floor!.sid[l]] }
  const stepDefs = new Map<string, SoundDef[]>() // Schritt + Ausrüstungs-Rascheln (Gear.<Seite>) je Untergrund:Seite
  const step = (k: string, tick: number, p: number, side: Side, x: number, y: number, z: number) => {
    const key = `${surface(x, y, z)}:${side}`
    let defs = stepDefs.get(key)
    if (!defs) stepDefs.set(key, (defs = [...(M.footsteps[sm.surfToStep[key]] ?? M.footsteps[`${side}_Concrete.StepLeft`] ?? []), ...(M.footsteps[`Gear.${side}`] ?? [])]))
    add(k, tick, defs, x, y, z, p, MINOR)
  }
  /** Absprung-Schritt an S (nach at()) */
  const jump = (tick: number, p: number) => step('jump', tick, p, sideOf(sr, p), S.x, S.y, S.z)
  /** Land_<Oberfläche>.StepLeft */
  const land = (tick: number, p: number, x: number, y: number, z: number) => add('land', tick, M.land?.[surface(x, y, z)] ?? M.land?.concrete, x, y, z, p, MINOR)

  // Events
  const E = d.evt, lastFire = new Map<number, string>(), plants: { tick: number; x: number; y: number; z: number }[] = [], bombEnds: number[] = []
  const steps: number[][] = H.players.map(() => []) // player_footstep-Ticks je Spieler (ab CS3D v5)
  /** Waffenklasse von p (nach at()): Waffen-Assets, sonst letzter Schuss */
  const cls = (p: number) => weapons?.[S.weapon]?.className ?? lastFire.get(p) ?? ''
  const vm = (def: number) => weapons?.[def]?.vm
  const c4 = vm(C4), plantClip = !!c4?.snd?.[c4.roles[vmRole('plant', c4.roles)] ?? '']?.length
  for (let i = 0; i < E.tick.length; i++) {
    const tick = E.tick[i], type = E.type[i], p = E.player[i], arg = E.arg[i]
    if (type === EV.bomb_exploded) {
      const b = plants.at(-1)
      if (b) add('bomb', tick, M.bomb.bomb_exploded, b.x, b.y, b.z, BOMB, MAJOR)
      bombEnds.push(tick)
      continue
    }
    if (type === EV.player_footstep) { steps[p]?.push(tick); continue }
    if (!SOUND_EV.has(type) || !at(p, tick)) continue
    const { x, y, z } = S
    switch (type) {
      case EV.weapon_fire: {
        const c = H.strings[arg] ?? '', knife = /^weapon_(knife|bayonet)/.test(c)
        lastFire.set(p, c)
        if (knife && vm(S.weapon)?.snd) break // Messer: Swish/Hit aus den Clips (Aktionen unten)
        const key = knife ? 'weapon_knife*' : c
        add('shot', tick, (S.flags & FLAG.silencer ? M.weapon_fire_silenced[key] : undefined) ?? M.weapon_fire[key], x, y, z, p, NORMAL)
        break
      }
      case EV.weapon_zoom: add('zoom', tick, M.zoom[cls(p)], x, y, z, p, MINOR); break
      case EV.player_hurt: add('player', tick, M.player[arg & 256 ? 'player_hurt_head' : arg & 512 ? 'player_hurt_armor' : 'player_hurt_body'], x, y, z, p, NORMAL); break
      case EV.player_death: add('player', tick, M.player.player_death, x, y, z, p, NORMAL); break
      // Tastendrücke kommen aus dem C4-Clip (Aktion plant); ohne Clip-Sounds nur Start + ein Tastendruck
      case EV.bomb_beginplant: if (!plantClip) add('bomb', tick, M.bomb.bomb_beginplant, x, y, z, BOMB, MAJOR); break
      case EV.bomb_planted: add('bomb', tick, M.bomb.bomb_planted, x, y, z, BOMB, MAJOR); plants.push({ tick, x, y, z }); break
      case EV.bomb_begindefuse: add('bomb', tick, M.bomb.bomb_begindefuse, x, y, z, BOMB, MAJOR); break
      case EV.bomb_defused: add('bomb', tick, M.bomb.bomb_defused, x, y, z, BOMB, MAJOR); bombEnds.push(tick); break
    }
  }
  // Piepen: CS:GO-Formel (CPlantedC4), Abstand max(0.15, 0.1 + 0.9·Rest/40) s, mp_c4timer 40
  for (const b of plants) {
    const t0 = b.tick / rate, stop = Math.min((bombEnds.find(e => e > b.tick) ?? Infinity) / rate, t0 + 40)
    for (let t = t0 + 1; t < stop;) {
      const left = t0 + 40 - t
      add('bomb', t * rate, M.bomb[left < 10 ? 'beep_last10s' : 'beep'], b.x, b.y, b.z, BOMB, MAJOR)
      t += Math.max(0.15, 0.1 + (0.9 * left) / 40)
    }
  }

  // Server-Sounds der Demo (CS3D v6): Schritte <Seite>_<Untergrund>.StepLeft und Landungen Land_<Untergrund>.StepLeft genau wie CS2,
  // Ort = Füße des Spielers im nächsten 16-Hz-Frame
  const known = new Map<number, [string, SoundDef[]]>()
  for (const [k, defs] of Object.entries(M.footsteps)) if (/^(CT|T)_.+\.StepLeft$/.test(k)) known.set(soundHash(k), ['step', [...defs, ...(M.footsteps[`Gear.${k.slice(0, k.indexOf('_'))}`] ?? [])]])
  for (const defs of Object.values(M.land ?? {})) if (defs[0]) known.set(soundHash(defs[0].ev), ['land', defs])
  let server = 0
  for (let i = 0; i < d.snd.tick.length; i++) {
    const e = known.get(H.sounds![d.snd.ev[i]]), p = d.snd.player[i], tick = d.snd.tick[i], r = e ? roundAt(d, tick) : -1, R = H.rounds[r]
    const k = R ? R.tracks.indexOf(p) : -1
    if (k < 0) continue
    const j = d.frameBase[r] + k * R.nFrames + Math.min(R.nFrames - 1, Math.round((tick - R.firstTick) / H.frameStep))
    add(e![0], tick, e![1], d.x[j], d.y[j], d.z[j], p, MINOR)
    if (e![0] === 'step') server++
  }

  const v5 = steps.some(s => s.length > 0)
  if (weapons) {
    const X = actionsOf(d, weapons), C = M.clip ?? {}
    for (let p = 0; p < H.players.length; p++) {
      // Waffen-Geräusche: Clip-Zeiten ab Aktionsstart, nichts ab action.end (Wechsel, Schuss, Tod, Rundenende)
      for (const a of X.list(p)) {
        const k = CLIP[a.kind], v = vm(a.def), role = k && v && vmRole(a.kind, v.roles), clip = role && role !== 'idle' ? v!.roles[role]! : ''
        const snd = clip && v!.snd?.[clip]
        if (!snd) continue
        const r = roundAt(d, a.t0), R = H.rounds[r], tk = R ? R.tracks.indexOf(p) : -1
        if (tk < 0) continue
        const fb = d.frameBase[r] + tk * R.nFrames, prio = k === 'knife' ? NORMAL : MINOR
        // Schrotflinte: Ladeschleife (win.loop) je Patrone, Outro danach (wie viewmodel.ts clipAt)
        const lp = (a.n ?? 0) > 1 ? v!.win?.[clip]?.loop : undefined, L = lp ? lp[1] - lp[0] : 0
        for (const [t, ev] of snd) {
          const loop = lp && t >= lp[0] && t < lp[1], t1 = lp && t >= lp[1] ? t + (a.n! - 1) * L : t
          for (let s = 0; s < (loop ? a.n! : 1); s++) {
            const tick = a.t0 + (t1 + s * L) * rate
            if (tick >= a.end) break
            // Position = nächster 16-Hz-Frame (statt sampleTrack: ~20 000 Clip-Sounds, Fehler <= 2 Ticks Laufweg)
            const j = fb + Math.min(R.nFrames - 1, Math.round((tick - R.firstTick) / H.frameStep))
            add(k!, tick, C[ev], d.x[j], d.y[j], d.z[j], p, prio)
          }
        }
      }
      // Absprung = Schritt der Oberfläche, Landung = Land_<Oberfläche>.StepLeft. Ab CS3D v5 genau an player_footstep (die Demo meldet
      // damit Absprünge und harte Landungen, keine Bodenschritte), Art aus den 16-Hz-Frames um das Event (wie sfxlog): Frame vor dem Event
      // in der Luft = Landung (am Event-Tick zeigt der Frame oft schon Boden), Frame danach in der Luft = Absprung, beides (Bunny-Hop
      // im selben Frame) = Landung + Absprung. Ohne player_footstep: Absprünge aus jumps() mit der Schritt-Regel, Landungen unten (Fallhöhe).
      // Mit Server-Schritten (v6) nichts: Absprung-Schritt und Landung kommen dort schon mit.
      if (server) continue
      if (v5) {
        for (const t of steps[p]) {
          const before = at(p, t - 1) && S.flags & FLAG.airborne, after = at(p, t - 1 + H.frameStep) && S.flags & FLAG.airborne
          if (!at(p, t)) continue
          if (before) land(t, p, S.x, S.y, S.z)
          if (after || !before) jump(t, p)
        }
      } else for (const j of X.jumps(p)) {
        // wie player_footstep (user-demo v5): Absprung hörbar nur aus dem Laufen; mit Shift 0/52, geduckt 0/33, unter 100 u/s 3/148, ab 150 u/s 863/875.
        // Sturz von einer Kante (takeoff = land, Frame davor in der Luft): kein Absprung
        if (!at(p, j.takeoff - H.frameStep) || S.flags & (FLAG.walking | FLAG.airborne) || S.duck >= 0.5 || Math.hypot(S.vx, S.vy) < AUDIBLE * maxSpeed(S.weapon, (S.flags & FLAG.scoped) !== 0)) continue
        if (at(p, j.takeoff)) jump(j.takeoff, p)
      }
    }
  }

  // Granaten
  const N = d.nade, P = d.path, D = M.detonate
  for (let i = 0; i < N.type.length; i++) {
    const ty = N.type[i], det = N.detTick[i], end = N.endTick[i], x = N.x[i], y = N.y[i], z = N.z[i], src = NADE_SRC + i
    if (ty === NADE.smoke) { add('nade', det, D.smokegrenade_detonate, x, y, z, src, MAJOR); add('nade', end, D.smokegrenade_expired, x, y, z, src, NORMAL) }
    else if (ty === NADE.flash) add('nade', det, D.flashbang_detonate, x, y, z, src, MAJOR)
    else if (ty === NADE.he) add('nade', det, D.hegrenade_detonate, x, y, z, src, MAJOR)
    else if (ty === NADE.molotov || ty === NADE.incgrenade) {
      add('nade', det, D[`inferno_startburn:${ty === NADE.molotov ? 'T' : 'CT'}`], x, y, z, src, MAJOR)
      if (end > det + 0.3 * rate) { add('nade', det + 0.3 * rate, D.inferno_loop, x, y, z, src, MAJOR, end / rate); add('nade', end, D.inferno_expire, x, y, z, src, NORMAL) }
    }
    // Abpraller aus der Flugbahn (die Demo hat kein grenade_bounce)
    // shortcut: Heuristik (Fallgeschwindigkeit kehrt sich um / Flugrichtung knickt > 45°), nicht gegen echte Bounce-Ticks geprüft
    const bounce = D[`grenade_bounce:${BOUNCE[ty]}`]
    let last = -Infinity
    for (let j = N.pathStart[i] + 2; bounce && j < N.pathStart[i + 1]; j++) {
      const da = (P.tick[j - 1] - P.tick[j - 2]) / rate, db = (P.tick[j] - P.tick[j - 1]) / rate
      if (!(da > 0 && db > 0)) continue
      const ax = (P.x[j - 1] - P.x[j - 2]) / da, ay = (P.y[j - 1] - P.y[j - 2]) / da, az = (P.z[j - 1] - P.z[j - 2]) / da
      const bx = (P.x[j] - P.x[j - 1]) / db, by = (P.y[j] - P.y[j - 1]) / db, bz = (P.z[j] - P.z[j - 1]) / db
      const ha = Math.sqrt(ax * ax + ay * ay), hb = Math.sqrt(bx * bx + by * by)
      const floorHit = az < -50 && bz - az > 100 // Schwerkraft allein macht vz nur kleiner
      const wallHit = ha > 50 && hb > 10 && ax * bx + ay * by < 0.7 * ha * hb
      const t = P.tick[j - 1]
      if ((floorHit || wallHit) && ha * ha + az * az > 80 * 80 && t - last > 0.1 * rate) { add('bounce', t, bounce, P.x[j - 1], P.y[j - 1], P.z[j - 1], src, MINOR); last = t }
    }
  }

  // Ohne Server-Schritte: Schritte nach stepCues; ohne player_footstep auch die Landungen (Fallhöhe ab dem höchsten Luft-Frame)
  if (!server) for (let r = 0; r < H.rounds.length; r++) {
    const R = H.rounds[r], n = R.nFrames
    R.tracks.forEach((p, k) => {
      const side = sideOf(r, p), fb = d.frameBase[r] + k * n
      let top = -Infinity
      if (!v5) for (let i = 1; i < n; i++) {
        const j = fb + i, f = d.flags[j]
        if (!(f & d.flags[j - 1] & FLAG.alive)) top = -Infinity
        else if (f & FLAG.airborne) top = Math.max(top, d.z[j - 1], d.z[j])
        else { if (top - d.z[j] >= LAND_DROP) land(R.firstTick + i * H.frameStep, p, d.x[j], d.y[j], d.z[j]); top = -Infinity }
      }
      for (const [tick, j] of stepCues(d, r, k)) step('step', tick, p, side, d.x[j], d.y[j], d.z[j])
    })
  }
  return out.sort((a, b) => a.t - b.t)
}

/**
 * Schritte von Track k in Runde r ohne Server-Sounds: [Tick, Frame-Index] (Regel bei STEP_RULE). Tempo aus den 16-Hz-Positionen;
 * Shift-Gehen (0.52 × Max) und Ducken (0.34 × Max) liegen unter der Schwelle; darunter (auch Luft/Tod/Teleport) hält der Takt HOLD s,
 * danach beginnt er neu mit FIRST.
 */
export function stepCues(d: CS3D, r: number, k: number): [number, number][] {
  const H = d.header, R = H.rounds[r], n = R.nFrames, dt = H.frameStep / H.tickrate, fb = d.frameBase[r] + k * n, out: [number, number][] = []
  const { HOLD, FIRST } = STEP_RULE
  let timer = FIRST, quiet = 0
  for (let i = 1; i < n; i++) {
    const j = fb + i, f = d.flags[j]
    const h = Math.hypot(d.x[j] - d.x[j - 1], d.y[j] - d.y[j - 1]), frac = h / dt / maxSpeed(d.weapon[j], (f & FLAG.scoped) !== 0)
    if (!(f & FLAG.alive) || f & FLAG.airborne || h > TELEPORT || Math.abs(d.z[j] - d.z[j - 1]) >= 120 * dt || frac < AUDIBLE) {
      if ((quiet += dt) >= HOLD) timer = FIRST // kurzes Abbremsen hält den Takt, Stehen setzt ihn zurück
      continue
    }
    quiet = 0
    timer -= dt
    if (timer > 0) continue
    out.push([R.firstTick + i * H.frameStep + Math.ceil(timer * H.tickrate), j]) // Tick innerhalb des Frames, an dem der Takt abläuft
    timer += frac >= RUN ? 0.3 : 0.4
  }
  return out
}

/** CS2-Kurve: [Distanz u, Gain] linear, außerhalb Randwerte */
export function curveGain(c: [number, number][], dist: number): number {
  if (!c.length) return 1
  if (dist <= c[0][0]) return c[0][1]
  for (let i = 1; i < c.length; i++) if (dist <= c[i][0]) { const [x0, y0] = c[i - 1], [x1, y1] = c[i]; return y0 + ((y1 - y0) * (dist - x0)) / (x1 - x0) }
  return c[c.length - 1][1]
}

const LOOKAHEAD = 0.12 // Kontext-s im Voraus planen (zusätzlich zur Ausgabelatenz, die der Anker schon enthält)
const BACK = 15 // nach Sprung so weit zurück nach noch klingenden langen Sounds suchen (smoke_emit 14.2 s)
const PREFETCH = 20 // Demo-s im Voraus laden
const MAX_VOICES = 48 // R14 ohne Cap max. 60 gleichzeitig
const CULL = 0.003
const NEAR = 1000 // Laden nur bis Kurven-Reichweite + so viele u vom Hörer (≈ 4 s Laufen; Prefetch alle 0.5 s)
/** Distanz (u), ab der die Kurve 0 ist; Infinity = überall hörbar (z. B. ferne Schüsse) */
const reach = (def: SoundDef) => { const e = def.curve.at(-1); return !e || e[1] > 0 ? Infinity : e[0] }

interface Voice {
  cue: Cue; def: SoundDef; key: string; base: number; gain: number; pan: number
  /** Loop-Ende (Kontext-Zeit) */
  end?: number
  cut: boolean
  src: AudioBufferSourceNode; g: GainNode; p: StereoPannerNode
}

export class Sfx {
  /** kinds = geplante Cues je Typ (Cue.k) für den Sound-Log */
  /** maxActive = höchste Zahl nicht ausblendender Stimmen (Cap MAX_VOICES); maxLive zählt ausblendende mit */
  /** local = übersprungene nur-lokale Clip-Sounds anderer Spieler (bzw. aller in der Free-Cam) */
  readonly stats = { started: 0, culled: 0, cut: 0, capped: 0, missing: 0, local: 0, maxLive: 0, maxActive: 0, files: 0, errors: 0, kinds: {} as Record<string, number> }
  private T: Float64Array
  private cursor = 0
  private live = new Set<Voice>()
  private buf = new Map<string, AudioBuffer | null>()
  private loading = new Set<string>()
  private lastPrefetch = -Infinity
  /** Hörer des letzten update() (Prefetch nach Reichweite) */
  private l?: Listener

  constructor(private ctx: AudioContext, private out: AudioNode, private clock: Clock, readonly cues: Cue[], private base: string, private mix: Record<string, number>) {
    this.T = Float64Array.from(cues, c => c.t)
    for (const c of cues) this.stats.kinds[c.k] = (this.stats.kinds[c.k] ?? 0) + 1
  }

  /** nach Start/Sprung/Tempo: zurückspulen, damit noch klingende lange Sounds (Smoke, Feuer) mit Versatz weiterlaufen */
  seek(demo: number, speed: number) {
    this.cursor = upperBound(this.T, demo - BACK * speed)
    this.prefetch(demo - BACK * speed, demo + PREFETCH * Math.max(1, speed))
  }

  /** jedes Bild, auch in der Pause: Dateien für die nächsten 20 s laden (alle 0.5 s) */
  warm(demo: number, speed: number) {
    if (performance.now() - this.lastPrefetch > 500) this.prefetch(demo, demo + PREFETCH * Math.max(1, speed))
  }

  /** jedes Bild bei laufender Uhr */
  update(demo: number, speed: number, l: Listener) {
    this.l = l
    const now = this.ctx.currentTime
    const horizon = this.clock.demoAt(now + LOOKAHEAD), minPrio = speed === 1 ? MINOR : speed <= 2 ? NORMAL : MAJOR
    while (this.cursor < this.cues.length && this.T[this.cursor] <= horizon) {
      const c = this.cues[this.cursor++]
      if (c.prio >= minPrio) for (const def of c.defs) this.start(c, def, l, now)
    }
    for (const v of this.live) if (!v.cut) {
      this.place(v, l, now)
      v.g.gain.setTargetAtTime(v.gain, now, 0.02); v.p.pan.setTargetAtTime(v.pan, now, 0.02)
    }
  }

  private start(c: Cue, def: SoundDef, l: Listener, now: number) {
    if (def.local && c.src !== l.ego) { this.stats.local++; return } // CS2 localplayeronly: nur der beobachtete Spieler in Ego-Sicht
    const end = c.until !== undefined ? this.clock.when(c.until) : undefined
    const v = { cue: c, def, key: `${def.ev}:${c.src}`, base: (this.mix[def.mix] ?? 1) * def.vol, gain: 0, pan: 0, end, cut: false } as Voice
    this.place(v, l, now)
    // außerhalb des Hörradius (leise Foley, ferne Schritte): nicht spielen, Datei muss nicht geladen sein
    if (v.gain < CULL && end === undefined) { this.stats.culled++; return }
    const b = this.pick(def)
    if (!b) { if (this.clock.when(c.t) > now) this.stats.missing++; return } // noch nicht geladen (Rückblick nach Sprung zählt nicht)
    const rate = (def.pitch ?? 1) + (def.pr ? def.pr[0] + Math.random() * (def.pr[1] - def.pr[0]) : 0), long = end !== undefined || b.duration > 5
    let when = this.clock.when(c.t + (def.delay ?? 0)), off = 0
    if (when < now + 0.005) {
      const late = now + 0.005 - when
      if (!long && late > 0.1) return // kurze Sounds nach Sprung nicht nachholen
      if (long) off = late
      when = now + 0.005
    }
    if (end !== undefined ? end <= when : off * rate >= b.duration) return
    // Instanz-Limit je Quelle (z. B. ein Nah-Schuss pro Schütze): ältesten ausblenden
    if (def.limit) {
      let n = 0, oldest: Voice | undefined
      for (const o of this.live) if (!o.cut && o.key === v.key) { n++; oldest ??= o }
      if (n >= def.limit) this.cut(oldest!, when)
    }
    // Stimmen-Cap: leiseste Stimme weicht
    let active = 0, quiet: Voice | undefined
    for (const o of this.live) if (!o.cut) { active++; if (!quiet || o.gain < quiet.gain) quiet = o }
    if (active >= MAX_VOICES) {
      this.stats.capped++
      if (quiet!.gain >= v.gain) return
      this.cut(quiet!, now); active--
    }
    const src = (v.src = this.ctx.createBufferSource()), g = (v.g = this.ctx.createGain()), p = (v.p = this.ctx.createStereoPanner())
    src.buffer = b; src.playbackRate.value = rate; src.loop = end !== undefined
    g.gain.value = v.gain; p.pan.value = v.pan
    src.connect(g).connect(p).connect(this.out)
    src.start(when, end !== undefined ? off % b.duration : off * rate)
    if (end !== undefined) src.stop(end)
    src.onended = () => { this.live.delete(v); p.disconnect() }
    this.live.add(v); this.stats.started++
    this.stats.maxLive = Math.max(this.stats.maxLive, this.live.size)
    this.stats.maxActive = Math.max(this.stats.maxActive, active + 1)
  }

  /** gain/pan aus der Hörer-Position: Distanz zum Ohr inkl. z-Versatz des Sounds, hinten leicht leiser, Loop-Ende 0.3 s ausblenden */
  private place(v: Voice, l: Listener, now: number) {
    const c = v.cue, dx = c.x - l.x, dy = c.y - l.y, dz = c.z + (v.def.z ?? 0) - l.z
    const h = Math.hypot(dx, dy), rel = Math.atan2(dy, dx) - (l.yaw * Math.PI) / 180
    v.gain = v.base * curveGain(v.def.curve, Math.hypot(h, dz)) * (0.85 + 0.15 * Math.cos(rel))
    if (v.end !== undefined) v.gain *= Math.min(1, Math.max(0, (v.end - now) / 0.3))
    v.pan = -Math.sin(rel) * Math.min(1, h / 50) // Source: +y links; direkt am Ohr keine Richtung
  }

  private cut(v: Voice, at: number) {
    v.cut = true; this.stats.cut++
    v.g.gain.cancelScheduledValues(at); v.g.gain.setTargetAtTime(0, at, 0.015)
    try { v.src.stop(at + 0.08) } catch { /* schon gestoppt */ }
  }

  private pick(def: SoundDef): AudioBuffer | undefined {
    const f = def.files, i = Math.floor(Math.random() * f.length)
    for (let k = 0; k < f.length; k++) { const b = this.buf.get(f[(i + k) % f.length]); if (b) return b }
  }

  private prefetch(from: number, to: number) {
    this.lastPrefetch = performance.now()
    const l = this.l
    for (let i = upperBound(this.T, from); i < this.cues.length && this.T[i] <= to; i++) {
      const c = this.cues[i]
      // nur-lokale Sounds nur für den Ego-Spieler laden (Wechsel der Sicht: 20 s Vorlauf reicht)
      for (const def of c.defs) if (!l || ((!def.local || c.src === l.ego) && Math.hypot(c.x - l.x, c.y - l.y, c.z - l.z) <= reach(def) + NEAR)) for (const f of def.files) this.load(f)
    }
  }

  private load(f: string) {
    if (this.buf.has(f) || this.loading.has(f)) return
    this.loading.add(f)
    fetch(this.base + f) // f mit Endung (.wav/.mp3)
      .then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
      .then(a => this.ctx.decodeAudioData(a))
      .then(b => { this.buf.set(f, b); this.stats.files++ }, () => { this.buf.set(f, null); this.stats.errors++ })
      .finally(() => this.loading.delete(f))
  }

  get liveCount() { return this.live.size }

  stopAll() {
    if (!this.live.size) return
    const t = this.ctx.currentTime
    for (const v of this.live) {
      v.src.onended = null
      v.g.gain.cancelScheduledValues(t); v.g.gain.setTargetAtTime(0, t, 0.004)
      try { v.src.stop(t + 0.03) } catch { /* schon gestoppt */ }
      const p = v.p; setTimeout(() => p.disconnect(), 100)
    }
    this.live.clear()
  }

  dispose() { this.stopAll(); this.buf.clear() }
}
