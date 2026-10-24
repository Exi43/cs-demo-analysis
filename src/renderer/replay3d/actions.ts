// Aktions-Zeitleiste je Spieler: was die Waffe in der Hand gerade tut (ziehen, schießen, nachladen, inspizieren, Pin, Messer …).
// Einmal je CS3D gebaut (WeakMap), danach nur Binärsuche: Viewmodel, Spielermodelle und Sounds lesen dieselbe Liste.
// Quellen nur aus CS3D: Flanken der 16-Hz-Kanäle (Waffe, FLAG, Tasten) und tick-genaue Events; Clip-Fenster aus WeaponAsset.vm.win.
// Kein three-Import (läuft auch in Node: scripts/dev3d/actions-check.ts).
import { BTN, EV, FLAG, isDown, upperBound, type CS3D } from '../../shared/cs3d'
import type { VmRole, WeaponAssets } from '../../shared/assets3d'
import type { Action, ActionIndex, ActionKind, ActionsOf, Jump } from './contracts'

/** fehlende Viewmodel-Rolle → nächstbeste (throw/plant sind keine Rollen: Wurf bzw. C4 legen = shoot) */
const NEXT: Partial<Record<ActionKind, ActionKind>> = {
  hit: 'light', heavy_hit: 'heavy', backstab: 'heavy_hit', heavy: 'light', light2: 'light',
  shoot_right: 'shoot', shoot_last: 'shoot', reload_empty: 'reload', throw: 'shoot', throw_under: 'shoot', plant: 'shoot',
}
/** Viewmodel-Rolle für eine Aktion; 'idle', wenn die Waffe keinen passenden Clip hat */
export function vmRole(kind: ActionKind, roles: Partial<Record<VmRole, string>>): VmRole {
  for (let k: ActionKind | undefined = kind; k; k = NEXT[k]) if (k !== 'throw' && k !== 'plant' && roles[k]) return k
  return 'idle'
}

const ELITES = 2
/** BTN.INSPECT (Bit 35) in btnHi */
const INSPECT = 1 << (BTN.INSPECT - 32)
const isNade = (def: number) => def >= 43 && def <= 48
/** Messer-Treffer: Opfer höchstens so weit vom Angreifer (u, Füße; Messer-Reichweite 48–64 u + Bewegung in einem 16-Hz-Frame) */
const HIT_R = 128
/** Rückenstich: Schaden ab 76 (leicht von hinten 90, mit Weste 76; vorn höchstens 65) */
// shortcut: Schaden ist auf die Rest-HP gekappt (dmg_health), Rückenstich auf ein Opfer mit < 76 HP zählt als hit; Blickwinkel des Opfers wäre genauer
const BACKSTAB_DMG = 76
/** Pin ohne gesehene Taste: so lange vor dem Wurf (s, Median der gemessenen Pin-Dauer) */
// shortcut: Tasten nur an den Frame-Ticks (parse3d); ODER über alle 4 Ticks eines Frames wäre genau (auch Messer-heavy), braucht Parser-Zeit + Neu-Import
const PIN = 0.28
/** Sturz ohne Absprung zählt als Sprung (nur Landung) ab dieser Fallhöhe (u) = sfx.ts LAND_DROP */
const LAND_DROP = 72

export const actionsOf: ActionsOf = (d, weapons) => {
  let x = cache.get(d)
  if (!x) cache.set(d, (x = build(d, weapons)))
  return x
}
const cache = new WeakMap<CS3D, ActionIndex>()

function build(d: CS3D, W: WeaponAssets): ActionIndex {
  const H = d.header, rate = H.tickrate, step = H.frameStep, E = d.evt, P = H.players.length
  const lists: Action[][] = Array.from({ length: P }, () => []), jumps: Jump[][] = Array.from({ length: P }, () => [])
  // Events je Spieler (Index in evt, nach Tick sortiert)
  const fires: number[][] = Array.from({ length: P }, () => []), steps: number[][] = Array.from({ length: P }, () => [])
  for (let e = 0; e < E.tick.length; e++) {
    if (E.player[e] >= P) continue
    if (E.type[e] === EV.weapon_fire) fires[E.player[e]].push(e)
    else if (E.type[e] === EV.player_footstep) steps[E.player[e]].push(E.tick[e])
  }
  const hasSteps = steps.some(s => s.length > 0), fptr = new Array<number>(P).fill(0)
  const knife = (def: number) => /^weapon_(knife|bayonet)/.test(W[def]?.className ?? '')
  const clipOf = (kind: ActionKind, def: number) => { const vm = W[def]?.vm; return vm && vm.roles[vmRole(kind, vm.roles)] }
  const durOf = (kind: ActionKind, def: number) => { const c = clipOf(kind, def); return c ? W[def].vm!.dur[c] ?? 0 : 0 }

  for (let r = 0; r < H.rounds.length; r++) {
    const R = H.rounds[r], n = R.nFrames, first = R.firstTick, roundEnd = first + n * step
    const T = (i: number) => first + i * step
    R.tracks.forEach((p, k) => {
      const fb = d.frameBase[r] + k * n, F = d.flags, Wp = d.weapon, lo = d.btnLo, hi = d.btnHi
      const alive = (i: number) => (F[fb + i] & FLAG.alive) !== 0
      // [Sortierschlüssel t0·8 + Rang, Aktion]; Rang ordnet gleiche Ticks: ziehen vor Flanken vor Schüssen vor Inspect
      const acts: [number, Action][] = [], deaths: number[] = [], presses: number[] = []
      const add = (kind: ActionKind, def: number, t0: number, rank: number, shells?: number) => {
        const a: Action = { kind, def, t0, end: roundEnd }
        if (shells !== undefined) a.n = shells
        acts.push([t0 * 8 + rank, a])
      }
      for (let i = 1; i < n; i++) {
        const j = fb + i, f = F[j], f0 = F[j - 1], def = Wp[j]
        if (!(f & FLAG.alive)) { if (f0 & FLAG.alive) deaths.push(T(i)); continue }
        if (!(f0 & FLAG.alive)) continue // Respawn: wie Rundenstart, kein Ziehen
        // F im Frame des Waffenwechsels: bei 16 Hz offen, ob vor oder nach dem Wechsel gedrückt → kein Inspect (wie Spike vmstate.ts)
        if (def !== Wp[j - 1]) { if (def) add('draw', def, T(i), 0); continue }
        if (hi[j] & INSPECT && !(hi[j - 1] & INSPECT) && !(f & (FLAG.reloading | FLAG.planting))) presses.push(i)
        if (f & FLAG.reloading && !(f0 & FLAG.reloading)) {
          const kind = d.ammo[j - 1] === 0 ? 'reload_empty' : 'reload', clip = clipOf(kind, def)
          let shells: number | undefined
          if (clip && W[def].vm!.win?.[clip]?.loop) { // Schrotflinte: Patronen = ammo-Zuwachs, solange reloading (+ ein Frame danach)
            shells = 0
            for (let q = i + 1; q < n && Wp[fb + q] === def && F[fb + q - 1] & FLAG.reloading; q++) shells += Math.max(0, d.ammo[fb + q] - d.ammo[fb + q - 1])
          }
          add(kind, def, T(i), 1, shells)
        }
        if (f & FLAG.planting && !(f0 & FLAG.planting)) add('plant', def, T(i), 1)
        if ((f ^ f0) & FLAG.silencer) add(f & FLAG.silencer ? 'silencer_on' : 'silencer_off', def, T(i), 1)
      }

      // weapon_fire: Schuss / letzter Schuss / Elites rechts, Messer leicht/leicht2/schwer/Treffer, Granate Pin + Wurf
      const fl = fires[p]
      while (fptr[p] < fl.length && E.tick[fl[fptr[p]]] < first) fptr[p]++
      let knifeT = -1e9, chain = 0
      for (let q = fptr[p]; q < fl.length && E.tick[fl[q]] < roundEnd; q++) {
        const ft = E.tick[fl[q]], f = Math.min(n - 1, Math.floor((ft - first) / step)), def = Wp[fb + f]
        if (!alive(f) || !def) continue
        if (isNade(def)) {
          const held = (i: number) => isDown(lo[fb + i], hi[fb + i], BTN.ATTACK) || isDown(lo[fb + i], hi[fb + i], BTN.ATTACK2)
          let e = f
          while (e > f - 2 && e > 0 && !held(e)) e-- // Taste meist 1 Tick vor dem Wurf losgelassen
          // nicht über den vorigen Wurf hinaus (zweite Granate gleicher Art: Waffen-Kanal wechselt nicht)
          let a1 = false, a2 = false, s = e, lim = q > 0 ? Math.floor((E.tick[fl[q - 1]] - first) / step) + 1 : 0
          if (held(e) && Wp[fb + e] === def) {
            while (s > lim && s > 0 && Wp[fb + s - 1] === def && alive(s - 1) && held(s - 1)) s--
            for (let i = s; i <= e; i++) { a1 ||= isDown(lo[fb + i], hi[fb + i], BTN.ATTACK); a2 ||= isDown(lo[fb + i], hi[fb + i], BTN.ATTACK2) }
            add('pullpin', def, Math.min(T(s), ft), 2)
          } else {
            // Tasten sind 16-Hz-Punktproben: ein kurzer Klick zwischen zwei Proben fehlt ganz (user-demo 65/308 Würfe). Pin trotzdem,
            // PIN s vor dem Wurf, nicht vor dem Ende des Ziehens bzw. dem Start der laufenden Aktion (spätestens 1 Tick vor dem Wurf)
            let cur: Action | undefined
            for (const [, a] of acts) if (a.t0 < ft && (!cur || a.t0 >= cur.t0)) cur = a
            const from = !cur ? first : cur.kind === 'draw' ? cur.t0 + durOf('draw', cur.def) * rate : cur.t0
            add('pullpin', def, Math.ceil(Math.max(ft - PIN * rate, Math.min(from, ft - 1))), 2) // ganzer Tick: Sortierschlüssel t0·8 + Rang
          }
          add(a2 && !a1 ? 'throw_under' : 'throw', def, ft, 2)
        } else if (knife(def)) {
          chain = ft - knifeT < rate ? chain + 1 : 1
          knifeT = ft
          const heavy = isDown(lo[fb + f], hi[fb + f], BTN.ATTACK2), dmg = knifeHit(d, r, k, f, ft)
          add(dmg < 0 ? (heavy ? 'heavy' : chain % 2 ? 'light' : 'light2') : dmg >= BACKSTAB_DMG ? 'backstab' : heavy ? 'heavy_hit' : 'hit', def, ft, 2)
        } else {
          const nf = f + 1 < n && Wp[fb + f + 1] === def ? f + 1 : -1, next = q + 1 < fl.length ? E.tick[fl[q + 1]] : Infinity
          if (nf > 0 && d.ammo[fb + nf] === 0 && next >= T(nf)) add('shoot_last', def, ft, 2)
          else add(def === ELITES && d.ammo[fb + f] % 2 ? 'shoot_right' : 'shoot', def, ft, 2) // Elites: ungerade Rest-Munition = rechte Pistole
        }
      }
      acts.sort((a, b) => a[0] - b[0])

      // Inspect: nicht während eines Block-Fensters (vm.win.block) der laufenden Aktion und nicht mit gezogenem Pin
      if (presses.length) {
        let c = -1
        for (const i of presses) {
          const t = T(i), def = Wp[fb + i]
          while (c + 1 < acts.length && acts[c + 1][1].t0 <= t) c++
          const cur = c >= 0 ? acts[c][1] : null
          if (cur?.kind === 'pullpin') continue
          const clip = cur && cur.def === def && clipOf(cur.kind, def), block = clip && W[def].vm!.win?.[clip]?.block, pt = cur ? (t - cur.t0) / rate : 0
          if (block && block.some(([a, b]) => pt >= a && pt < b)) continue
          add('inspect', def, t, 3)
        }
        acts.sort((a, b) => a[0] - b[0])
      }

      // Ende = nächste Aktion, Tod oder Rundenende
      const out = lists[p]
      for (let i = 0; i < acts.length; i++) {
        const a = acts[i][1], nx = i + 1 < acts.length ? acts[i + 1][1].t0 : roundEnd
        let end = nx
        for (const dt of deaths) if (dt > a.t0) { end = Math.min(end, dt); break }
        a.end = end
        out.push(a)
      }

      // Sprünge: airborne-Phasen mit Absprung nach oben (bzw. player_footstep am Absprung), Landung im selben Leben.
      // Sturz von einer Kante (kein Absprung, Fallhöhe ab LAND_DROP): nur Landung, takeoff = land (CS2 spielt beim Abgehen keinen Absprung)
      const S = steps[p], near = (t: number) => { const u = upperBound(S, t + step) - 1; return u >= 0 && S[u] >= t - step ? S[u] : -1 }
      const z = d.z, dtf = step / rate
      for (let i = 1; i < n - 1; i++) {
        if (!(F[fb + i] & FLAG.airborne) || F[fb + i - 1] & FLAG.airborne || !alive(i) || !alive(i - 1)) continue
        let l = i, top = z[fb + i - 1] // höchster Punkt ab dem letzten Boden-Frame
        while (l < n && F[fb + l] & FLAG.airborne && alive(l)) top = Math.max(top, z[fb + l++])
        if (l >= n || !alive(l)) { i = l; continue }
        const up = (z[fb + i + 1] - z[fb + i - 1]) / (2 * dtf), st = hasSteps ? near(T(i)) : -1, jumped = up > 100 || st >= 0
        if (jumped || top - z[fb + l] >= LAND_DROP) {
          const ls = hasSteps ? near(T(l)) : -1, land = ls >= 0 ? ls : T(l)
          jumps[p].push({ takeoff: jumped ? (st >= 0 ? st : T(i)) : land, land, vz: (z[fb + l - 1] - z[fb + l - 2]) / dtf })
        }
        i = l
      }
    })
  }
  const starts = lists.map(L => Float64Array.from(L, a => a.t0))
  return {
    at(p, tick) {
      const s = starts[p]
      if (!s) return null
      const i = upperBound(s, tick) - 1
      return i >= 0 && tick < lists[p][i].end ? lists[p][i] : null
    },
    list: p => lists[p] ?? [],
    jumps: p => jumps[p] ?? [],
  }
}

/** Schaden (arg & 255) eines player_hurt bis 1 Tick um ft an einem anderen Spieler in Messer-Reichweite von Track k, sonst −1 */
function knifeHit(d: CS3D, r: number, k: number, f: number, ft: number): number {
  const E = d.evt, R = d.header.rounds[r], n = R.nFrames, a = d.frameBase[r] + k * n + f, p = R.tracks[k]
  for (let e = upperBound(E.tick, ft + 1) - 1; e >= 0 && E.tick[e] >= ft - 1; e--) {
    if (E.type[e] !== EV.player_hurt || E.player[e] === p) continue
    const vk = R.tracks.indexOf(E.player[e])
    if (vk < 0) continue
    const v = d.frameBase[r] + vk * n + f
    if (Math.hypot(d.x[v] - d.x[a], d.y[v] - d.y[a], d.z[v] - d.z[a]) <= HIT_R) return E.arg[e] & 255
  }
  return -1
}
