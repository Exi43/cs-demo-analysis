// Gute Selbsttest-Stellen für liegende Waffen: je Runde/Zeit der lebende Spieler, der die meisten liegenden Waffen (mit Liegeplatz)
// nah vor sich hat (≤ 600 u, ±35° Blick). Ausgabe: shot.ps1-View auto/replay3d/<runde>/<sek>/ego/<spielerindex>
//   node scripts/dev3d/drops-spots.ts [<id>.v6.3d.bin.gz] [<id>.json.gz]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { decode3d, FLAG, newSample, sampleTrack } from '../../src/shared/cs3d.ts'
import type { MatchData } from '../../src/shared/model.ts'

const id = '4699fdaf49070d28'
const d = decode3d(gunzipSync(readFileSync(process.argv[2] ?? `../Daten/downloads/spike/build/data3d/${id}.v6.3d.bin.gz`)))
const m: MatchData = JSON.parse(gunzipSync(readFileSync(process.argv[3] ?? join(process.env.APPDATA!, 'CS Demo Analysis', 'matches', `${id}.json.gz`))).toString())
const D = d.drop, H = d.header, rate = H.tickrate, S = newSample(), out: [number, string, string][] = []
const MAXD = Number(process.env.MAXD ?? 600) // höchstens so weit vom Spieler (u)
for (let r = 0; r < H.rounds.length; r++) {
  const R = H.rounds[r], mr = m.rounds.findIndex(x => x.num === R.num)
  if (mr < 0) continue
  for (let t = R.firstTick; t < R.firstTick + R.nFrames * H.frameStep; t += rate / 2) {
    const lying: number[] = []
    const only = process.env.DEFS?.split(',').map(Number) // z. B. DEFS=7,9,16,60 = nur Gewehre
    for (let i = 0; i < D.tick.length; i++) if (D.land[i] && D.tick[i] + rate < t && (D.end[i] === 0 ? true : D.end[i] > t) && D.tick[i] >= R.firstTick && (!only || only.includes(D.def[i]))) lying.push(i)
    if (lying.length < Number(process.env.MIN ?? 2)) continue
    R.tracks.forEach((p, k) => {
      sampleTrack(d, r, k, t, S)
      if (!(S.flags & FLAG.alive)) return
      const pi = m.players.findIndex(x => x.steamid === H.players[p].steamid)
      let c = 0
      for (const i of lying) {
        const dx = D.rx[i] - S.x, dy = D.ry[i] - S.y, dist = Math.hypot(dx, dy)
        const a = Math.abs(((Math.atan2(dy, dx) * 180 / Math.PI - S.yaw) % 360 + 540) % 360 - 180)
        if (dist > 60 && dist < MAXD && a < 30 && Math.abs(D.rz[i] - S.z) < 100) c++
      }
      if (c >= Number(process.env.MIN ?? 2)) out.push([c, `auto/replay3d/${mr + 1}/${((t - m.rounds[mr].freezeEndTick) / rate).toFixed(1)}/ego/${pi}`, `Runde ${R.num} defs ${lying.map(i => D.def[i]).join(',')}`])
    })
  }
}
out.sort((a, b) => b[0] - a[0])
const seen = new Set<string>()
for (const [c, v, info] of out) { const key = v.split('/').slice(0, 3).join('/'); if (seen.has(key)) continue; seen.add(key); console.log(c, v, info); if (seen.size >= 8) break }
