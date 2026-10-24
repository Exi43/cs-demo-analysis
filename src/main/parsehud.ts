// HUD-Zusatzdaten (shared/hud.ts) aus der Demo. Läuft im Parser-Prozess nach parse3d:
//   writeFileSync(join(outDir, `${m.id}.hud.json.gz`), gzipSync(JSON.stringify(parseHud(buf, m))))
// 1× parseTicks alle 16 Ticks in den v1-Rundenfenstern (Inventar, Helm, Kit, Kaufzone, Reserve der aktiven Waffe, user_id),
// 1× parseEvents (player_hurt, buytime_ended). Gespeichert werden nur Änderungen. Test: node scripts/hud-selftest.ts
import * as dp from '@laihoe/demoparser2'
import type { MatchData } from '../shared/model.ts'
import { HUD_VERSION, type HudHurt, type HudRound, type HudRoundPlayer, type HudTrack } from '../shared/hud.ts'
import { readDemoBuffer } from './parse.ts'

type Row = Record<string, any>

/**
 * m_nPrimaryReserveAmmoMax je item_def_idx (Magazine, Schrotflinten in Patronen), einmalig erzeugt aus der lokalen CS2-Installation
 * (scripts/weapons.vdata + items_game.txt, Patch 14191). Waffen ohne Reserve (Messer, Granaten, C4, Zeus) fehlen.
 */
export const RESERVE_MAX: Record<number, number> = {
  1: 3, 2: 2, 3: 2, 4: 3, 7: 3, 8: 3, 9: 2, 10: 4, 11: 2, 13: 4, 14: 2, 16: 4, 17: 3, 19: 2, 23: 3, 24: 3, 25: 32, 26: 2, 27: 3,
  28: 2, 29: 32, 30: 3, 32: 4, 33: 3, 34: 2, 35: 32, 36: 3, 38: 2, 39: 3, 40: 2, 60: 3, 61: 2, 63: 2, 64: 2,
}

const STEP = 4 // jeder 4. v1-Frame (FRAME_STEP 4) = alle 16 Ticks
const PROPS = ['inventory_as_ids', 'has_helmet', 'has_defuser', 'in_buy_zone', 'active_weapon', 'item_def_idx', 'total_ammo_left', 'user_id']

const sid = (v: any): string | null => (v == null || v === '' || v === '0' || v === 0 ? null : String(v))
const flag = (list: [number, 0 | 1][], tick: number, v: any) => { const b = v ? 1 : 0; if (list.at(-1)?.[1] !== b) list.push([tick, b]) }

export function parseHud(raw: Buffer, m: MatchData): HudTrack {
  const buf = readDemoBuffer(raw)
  const V1 = m.rounds.filter(R => R.frameTicks.length)
  const rounds: HudRound[] = V1.map(R => ({
    num: R.num, buyEndTick: -1,
    players: Object.fromEntries(R.tracks.map(t => [t.steamid, { inv: [], helmet: [], kit: [], buyzone: [], reserve: [] } as HudRoundPlayer])),
  }))
  const roundAt = new Map<number, number>()
  V1.forEach((R, r) => R.frameTicks.forEach((t, i) => { if (i % STEP === 0) roundAt.set(t, r) }))

  const c = dp.parseTicks(buf, PROPS, [...roundAt.keys()], null, true) as Row
  if (!c.inventory_as_ids) throw new Error("HUD: demo has no 'inventory_as_ids' column")
  const col = (k: string) => c[k] ?? []
  const [tick, steam, inv, helmet, kit, buyzone, handle, def, ammo, uid] = ['tick', 'steamid', ...PROPS].map(col)
  const slots: Record<string, number> = {}
  // demoparser2 kennt die Reserve erst nach der ersten Änderung (Startwert 0 bei allen Waffen) → bis dahin das Maximum
  const real = new Set<number>()
  const lastRes = new Map<string, number>()
  for (let i = 0; i < tick.length; i++) {
    const s = sid(steam[i]), r = roundAt.get(tick[i]); if (!s || r === undefined) continue
    if (uid[i] != null) slots[s] ??= uid[i]
    const P = rounds[r].players[s], t = tick[i]; if (!P) continue
    const ids = [...(inv[i] ?? [])].sort((a: number, b: number) => a - b) // Duplikate bleiben (43, 43 = 2 Flashbangs)
    if (P.inv.at(-1)?.[1].join() !== ids.join()) P.inv.push([t, ids])
    flag(P.helmet, t, helmet[i]); flag(P.kit, t, kit[i]); flag(P.buyzone, t, buyzone[i])
    const d = def[i], h = handle[i], n = ammo[i]
    if (!RESERVE_MAX[d] || h == null || n == null) continue
    if (n !== 0) real.add(h)
    const v = real.has(h) ? n : RESERVE_MAX[d], key = `${r}|${s}|${d}`
    if (lastRes.get(key) !== v) { lastRes.set(key, v); P.reserve.push([t, d, v]) }
  }

  const ev = dp.parseEvents(buf, ['player_hurt', 'buytime_ended'], [], [])
  const rows = (Array.isArray(ev) ? ev : Object.values(ev ?? {}).flat() as Row[]).sort((a, b) => a.tick - b.tick)
  const hurt: HudHurt[] = []
  for (const e of rows) {
    const r = V1.findIndex(R => e.tick >= R.frameTicks[0] && e.tick <= R.frameTicks[R.frameTicks.length - 1]); if (r < 0) continue
    if (e.event_name === 'buytime_ended') { if (rounds[r].buyEndTick < 0) rounds[r].buyEndTick = e.tick; continue }
    const victim = sid(e.user_steamid); if (!victim) continue
    hurt.push({ tick: e.tick, victim, attacker: sid(e.attacker_steamid), dmg: e.dmg_health ?? 0, health: e.health ?? 0 })
  }
  return { version: HUD_VERSION, slots, rounds, hurt }
}
