// Prüft liegende Waffen + Server-Sounds aus parse3d (CS3D v6) an einer echten Demo:
//   node --max-old-space-size=4096 scripts/dev3d/drops-check.ts [demo]   (v1 aus dem Cache von parse3d-test.ts)
// Schreibt <CACHE>/<id>.v6.3d.bin.gz (für sfxlog.ts) und zählt: Abwürfe je Art, Liegeplatz aus Aufprall-Sound, Aufheben, Liegedauer,
// Wurfweite (Abwurf → erster Aufprall) gegen die Schätzung THROW, Schritt-Sounds je Spieler. Exit 1 bei verfehlter Abnahme.
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { parse3d } from '../../src/main/parse3d.ts'
import { decode3d, encode3d, soundHash } from '../../src/shared/cs3d.ts'
import type { MatchData } from '../../src/shared/model.ts'

const demo = process.argv[2] ?? 'F:/csdemoanalysis/demos/user-demo.dem'
const CACHE = '../Daten/downloads/spike/build/data3d'
const m: MatchData = JSON.parse(gunzipSync(readFileSync(`${CACHE}/${basename(demo)}.v1.json.gz`)).toString())
let t0 = performance.now()
const input = parse3d(readFileSync(demo), m)
const ms = Math.round(performance.now() - t0)
const enc = encode3d(input), gz = gzipSync(enc), out = `${CACHE}/${m.id}.v6.3d.bin.gz`
writeFileSync(out, gz)
const d = decode3d(gunzipSync(gz)), D = d.drop, rate = d.header.tickrate
console.log(`parse3d ${ms} ms, gz ${(gz.length / 1024).toFixed(0)} KB → ${out}`)

let fails = 0
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${msg}`); if (!ok) fails++ }
const med = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN }
const cls = (def: number) => def === 49 ? 'c4' : def === 55 ? 'kit' : def >= 43 && def <= 48 ? 'nade' : [1, 2, 3, 4, 30, 32, 36, 61, 63, 64].includes(def) ? 'pistol' : def === 31 ? 'zeus' : 'primary'
const by: Record<string, { n: number; land: number; picked: number }> = {}
const lie: number[] = [], st = { G: { dist: [] as number[], T: [] as number[], v: [] as number[], est: [] as number[] }, Tod: { dist: [] as number[], T: [] as number[], v: [] as number[], est: [] as number[] } }
for (let i = 0; i < D.tick.length; i++) {
  const c = (by[cls(D.def[i])] ??= { n: 0, land: 0, picked: 0 })
  c.n++; if (D.land[i]) c.land++; if (D.end[i]) { c.picked++; lie.push((D.end[i] - D.tick[i]) / rate) }
  if (D.land[i]) {
    // Tod-Abwürfe haben vz = 60 (parse3d add), G-Abwürfe die Blickrichtung
    const s = st[D.vz[i] === 60 ? 'Tod' : 'G'], h = Math.hypot(D.ix[i] - D.x[i], D.iy[i] - D.y[i]), T = (D.land[i] - D.tick[i]) / rate
    s.dist.push(h); s.T.push(T); if (T > 0) s.v.push(h / T)
    s.est.push(Math.hypot(D.rx[i] - D.x[i] - D.vx[i] * T, D.ry[i] - D.y[i] - D.vy[i] * T)) // Fehler der reinen Schätzung (ohne Wände)
  }
}
console.log('Abwürfe je Art', JSON.stringify(by), `Liegedauer bis Aufheben Median ${med(lie).toFixed(1)} s`)
for (const [k, s] of Object.entries(st)) console.log(`${k}: n ${s.dist.length}, Weite bis Aufprall Median ${med(s.dist).toFixed(0)} u, Flugzeit ${med(s.T).toFixed(2)} s, waagerecht ${med(s.v).toFixed(0)} u/s, Schätzfehler Median ${med(s.est).toFixed(0)} u`)
const n = D.tick.length, landed = [...D.land].filter(Boolean).length
check(n > 50, `liegende Waffen ${n} (Soll > 50)`)
check(landed / n >= 0.6, `Liegeplatz aus Aufprall-Sound ${landed}/${n} (Soll >= 60 %)`)
check(by.c4?.n > 0 && by.kit?.n >= 0, `C4-Abwürfe ${by.c4?.n ?? 0}, Sets ${by.kit?.n ?? 0}`)

// Server-Sounds: Schritte je Spieler, Namen über die Oberflächen der Sound-Map (falls vorhanden)
const S = d.snd, names = new Map<number, string>()
for (const side of ['CT', 'T', 'Land']) for (const s of ['Concrete', 'Sand', 'Gravel', 'Tile', 'Wood_Panel', 'Dirt', 'Default', 'MetalBarrel', 'SolidMetal', 'Wood', 'WoodBox', 'Wood_Basket', 'MetalVehicle', 'Glass', 'Flesh', 'Rubber', 'Plastic_Box', 'MetalGrate', 'Mud', 'Grass'])
  names.set(soundHash(`${side}_${s}.StepLeft`), `${side}_${s}.StepLeft`)
for (const x of ['Default.WalkJump', 'Gear.JumpLand.CT', 'Gear.JumpLand.T', 'Player.PickupWeaponAudible', 'Player.PickupGrenadeAudible', 'Player.PickupWeapon']) names.set(soundHash(x), x)
const cnt: Record<string, number> = {}
for (let i = 0; i < S.tick.length; i++) { const k = names.get(d.header.sounds![S.ev[i]]) ?? 'other'; const g = /^(CT|T)_/.test(k) ? 'step' : /^Land_/.test(k) ? 'land' : k; cnt[g] = (cnt[g] ?? 0) + 1 }
console.log(`Server-Sounds ${S.tick.length}, Arten ${d.header.sounds!.length}: ${JSON.stringify(cnt)}`)
check((cnt.step ?? 0) > 5000, `Schritt-Sounds aus der Demo ${cnt.step ?? 0} (Soll > 5000)`)
console.log(fails ? `${fails} Abnahme(n) verfehlt` : 'alle Abnahmen OK')
process.exit(fails ? 1 : 0)
