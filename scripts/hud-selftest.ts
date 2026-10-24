// Test HUD-Daten (src/main/parsehud.ts): node --max-old-space-size=4096 scripts/hud-selftest.ts [demo …]
// Je Demo: Zeit, Größe, Anzahl Änderungen, Plausibilität, Treffer-HP gegen v1-HP. user-demo zusätzlich: Runde 15 gegen den Entwurf v2
// und ein Import über den echten Parser-Prozess (normal + erzwungener HUD-Fehler). v1 wird wie in dev3d/parse3d-test.ts gecacht.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { parseDemo } from '../src/main/parse.ts'
import { RESERVE_MAX, parseHud } from '../src/main/parsehud.ts'
import { at, type HudTrack } from '../src/shared/hud.ts'
import type { MatchData } from '../src/shared/model.ts'

const DEMOS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['F:/csdemoanalysis/demos/user-demo.dem', 'F:/csdemoanalysis/demos/faceit-de_mirage-6de46e85.dem']
const CACHE = '../Daten/downloads/spike/build/data3d'
mkdirSync(CACHE, { recursive: true })
const NADES = new Set([43, 44, 45, 46, 47, 48])

function loadV1(demo: string, raw: Buffer): MatchData {
  const f = `${CACHE}/${basename(demo)}.v1.json.gz`
  if (existsSync(f)) return JSON.parse(gunzipSync(readFileSync(f)).toString())
  const m = parseDemo(raw, basename(demo))
  writeFileSync(f, gzipSync(JSON.stringify(m)))
  return m
}

/** Treffer-HP gegen v1-HP (16 Hz): HP vor und nach jedem Treffer (Kette der health-Werte) muss in v1 stehen, ±1 Frame */
function checkHp(m: MatchData, h: HudTrack) {
  let ok = 0, n = 0, dmgOff = 0
  const bad: string[] = []
  for (const R of m.rounds) {
    const ft = R.frameTicks; if (!ft.length) continue
    const hits = h.hurt.filter(e => e.tick >= ft[0] && e.tick <= ft[ft.length - 1])
    for (const tr of R.tracks) {
      const mine = hits.filter(e => e.victim === tr.steamid)
      // HP laut Treffer-Kette zum Tick (vor dem ersten Treffer: v1-HP am Rundenanfang)
      const chain = (t: number) => { let v = tr.hp[0]; for (const e of mine) if (e.tick <= t) v = e.health; return v }
      let before = tr.hp[0]
      for (const e of mine) {
        n++
        if (before - e.health !== e.dmg) dmgOff++
        const fa = ft.findIndex(t => t >= e.tick), fb = fa - 1
        const after = [fa, fa + 1].some(a => a >= 0 && a < ft.length && tr.hp[a] === chain(ft[a]))
        const prev = [fb, fb - 1].some(b => b >= 0 && tr.hp[b] === chain(ft[b]))
        if (after && prev) ok++
        else if (bad.length < 4) bad.push(`R${R.num} ${e.tick} ${e.victim.slice(-4)} vor ${before} health ${e.health} v1 ${tr.hp.slice(Math.max(0, fb - 1), fa + 2).join('/')}`)
        before = e.health
      }
    }
  }
  return { ok, n, dmgOff, bad }
}

for (const demo of DEMOS) {
  const raw = readFileSync(demo), m = loadV1(demo, raw)
  let t0 = performance.now()
  const h = parseHud(raw, m)
  const msParse = Math.round(performance.now() - t0); t0 = performance.now()
  const gz = gzipSync(JSON.stringify(h))
  const msGz = Math.round(performance.now() - t0)
  const P = h.rounds.flatMap(R => Object.values(R.players))
  const cnt = (k: 'inv' | 'helmet' | 'kit' | 'buyzone' | 'reserve') => P.reduce((a, p) => a + p[k].length, 0)
  console.log(`${basename(demo)}: parseHud ${msParse} ms + JSON/gzip ${msGz} ms, ${(gz.length / 1024).toFixed(1)} KB gz | ${h.rounds.length} Runden, ` +
    `Änderungen inv ${cnt('inv')}, helmet ${cnt('helmet')}, kit ${cnt('kit')}, buyzone ${cnt('buyzone')}, reserve ${cnt('reserve')}, Treffer ${h.hurt.length}`)
  assert.ok(gz.length <= 200 * 1024, 'hud-Datei > 200 KB gz')
  if (basename(demo) === 'user-demo.dem') assert.ok(msParse + msGz <= 3000, `Import > 3 s länger (${msParse + msGz} ms)`)

  // Plausibilität
  assert.equal(h.rounds.length, m.rounds.filter(R => R.frameTicks.length).length)
  const ids = Object.values(h.slots)
  assert.ok(m.players.every(p => h.slots[p.steamid] !== undefined) && new Set(ids).size === ids.length, `Slots ${JSON.stringify(h.slots)}`)
  const buyS = h.rounds.map((R, r) => (R.buyEndTick - m.rounds[r].freezeEndTick) / m.tickrate)
  assert.ok(buyS.filter(s => Math.abs(s - 20) < 1).length >= 0.9 * buyS.length, `buytime_ended − Freeze-Ende ${buyS}`)
  const sorted = (l: [number, ...unknown[]][]) => l.every((e, i) => !i || e[0] > l[i - 1][0])
  assert.ok(P.every(p => sorted(p.inv) && sorted(p.helmet) && sorted(p.kit) && sorted(p.buyzone)), 'Listen nicht aufsteigend')
  assert.ok(P.every(p => p.helmet.every((e, i) => !i || e[1] !== p.helmet[i - 1][1])), 'helmet: doppelte Einträge statt nur Änderungen')
  const dup = P.reduce((a, p) => a + p.inv.filter(([, d]) => d.filter(x => x === 43).length > 1).length, 0)
  assert.ok(dup > 0, 'keine 2 Flashbangs im Inventar (Duplikate verloren?)')
  assert.ok(P.every(p => p.reserve.every(([, d, k]) => k >= 0 && k <= RESERVE_MAX[d])), 'Reserve außerhalb 0..Maximum')
  assert.ok(h.hurt.every((e, i) => !i || e.tick >= h.hurt[i - 1].tick), 'Treffer nicht sortiert')
  const hp = checkHp(m, h)
  console.log(`  2 Flashbangs in ${dup} Inventaren, buytime_ended ${buyS.filter(s => s >= 0).length}/${buyS.length} (${Math.min(...buyS).toFixed(1)}..${Math.max(...buyS).toFixed(1)} s), ` +
    `Slots ${ids.sort((a, b) => a - b).join(',')} | HP-Kette = v1: ${hp.ok}/${hp.n} (${((100 * hp.ok) / hp.n).toFixed(1)} %), dmg_health ≠ HP-Verlust ${hp.dmgOff}`)
  if (hp.bad.length) console.log('  Abweichungen z. B.', hp.bad.join(' | '))
  assert.ok(hp.ok >= 0.99 * hp.n, 'HP-Kette stimmt in < 99 % der Treffer')

  if (basename(demo) !== 'user-demo.dem') continue
  // Runde 15, 3 s nach Freeze-Ende: Utility, Kit, Helm wie im Entwurf v2 (assets-mockup/data-v2.js, Zustand 'start').
  // Ausnahme C3M0 (+HE) und SymboIe (+2 Flash): item_pickup 5–20 Ticks NACH Freeze-Ende, der Entwurf nahm das v1-Inventar bei Freeze-Ende.
  const r15 = m.rounds.findIndex(R => R.num === 15), H15 = h.rounds[r15], t3 = m.rounds[r15].freezeEndTick + 3 * 64
  const want: Record<string, [number[], 0 | 1]> = {
    tyrannus00: [[48], 1], Derdummbadss: [[43, 44, 45, 46], 0], Kugel666: [[], 0], stakson: [[43, 44, 45, 46], 0], sk1nnex: [[43, 43, 45, 46], 0],
    DiiiDiii: [[43, 44, 45, 46], 0], C3M0: [[43, 44], 0], Criminal_Boy: [[43, 44, 45, 46], 0], Exi: [[], 0], SymboIe: [[43, 43], 0],
  }
  const sidOf = new Map(m.players.map(p => [p.name, p.steamid]))
  for (const [name, [nades, kit]] of Object.entries(want)) {
    const p = H15.players[sidOf.get(name)!]
    assert.deepEqual(at(p.inv, t3)?.[1].filter(d => NADES.has(d)), nades, `R15 ${name} Utility`)
    assert.equal(at(p.kit, t3)?.[1], kit, `R15 ${name} Kit`); assert.equal(at(p.helmet, t3)?.[1], 1, `R15 ${name} Helm`)
  }
  // Treffer bei 64,5 s: Exi 100 → 66 (−34, DiiiDiii AK)
  const exi = sidOf.get('Exi')!, t64 = m.rounds[r15].freezeEndTick + 64.5 * 64
  const hitsExi = h.hurt.filter(e => e.victim === exi && e.tick >= m.rounds[r15].frameTicks[0] && e.tick <= t64)
  const last = hitsExi.at(-1)!, before = hitsExi.at(-2)?.health ?? 100
  assert.ok(last && t64 - last.tick < 64 && last.health === 66 && before - last.health === 34 && last.attacker === sidOf.get('DiiiDiii'), `Exi-Treffer ${JSON.stringify(last)}`)
  console.log(`  R15 bei 3 s = Entwurf (Utility, Kit, Helm) | Exi ${(t64 - last.tick) / 64} s vor 64,5 s: ${before} → ${last.health} (−${before - last.health}, dmg_health ${last.dmg})`)

  // Import über den echten Parser-Prozess (Electron-parentPort nachgebaut): normal und mit erzwungenem HUD-Fehler
  const out = `${CACHE}/hud-import`; mkdirSync(out, { recursive: true })
  let handler: (e: { data: { file: string; outDir: string } }) => void = () => {}
  const msgs: any[] = []
  ;(process as any).parentPort = { on: (_: string, f: typeof handler) => (handler = f), postMessage: (x: any) => msgs.push(x) }
  await import('../src/main/parser-process.ts')
  const run = () => { msgs.length = 0; const t = performance.now(); handler({ data: { file: demo, outDir: out } }); return Math.round(performance.now() - t) }
  const msImport = run()
  const done = msgs.find(x => x.type === 'done'), hudFile = `${out}/${done?.summary.id}.hud.json.gz`
  assert.ok(done && !done.summary.error3d, `Import: ${JSON.stringify(msgs.at(-1))}`)
  assert.deepEqual(JSON.parse(gunzipSync(readFileSync(hudFile)).toString()), JSON.parse(JSON.stringify(h)), 'hud-Datei ≠ parseHud')
  assert.ok(msgs.some(x => x.msg === 'Reading HUD data') && msgs.filter(x => x.type === 'progress').every((x, i, a) => !i || x.pct >= a[i - 1].pct), 'Fortschritt')
  // Fehler erzwingen: am Zielpfad liegt ein Ordner → Schreiben scheitert, Import muss trotzdem fertig werden
  rmSync(hudFile); mkdirSync(hudFile)
  const msFail = run()
  const done2 = msgs.find(x => x.type === 'done')
  assert.ok(done2 && done2.summary.id === done.summary.id && statSync(hudFile).isDirectory(), `erzwungener Fehler: ${JSON.stringify(msgs.at(-1))}`)
  rmSync(out, { recursive: true, force: true })
  console.log(`  Import (Parser-Prozess) ${msImport} ms mit HUD-Datei = parseHud; erzwungener HUD-Fehler: Import fertig (${msFail} ms), keine hud-Datei`)
}
console.log('hud-selftest OK')
