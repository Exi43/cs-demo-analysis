// Agenten-Testseite (Spielermodelle): baut page.js/page.html und den Plan für das unveränderte engine-main.cjs.
//   node scripts/dev3d/agent-build.mjs <outDir> [<id>.3d.bin.gz]      (Standard: user-demo 4699fdaf49070d28)
//   electron scripts/dev3d/engine-main.cjs <outDir>/plan.json          → <outDir>/result.json + reload/throw/knife/shoot/labels.png
//   (checks: Gehen/Sprung, gaps: Hand ↔ Waffe je Welt-Clip, bench: pose() für 10 Agenten vorher/nachher)
// Assets wie prepare3d, nur aus dem Cache (%APPDATA%\CS Demo Analysis\assets3d, nichts wird gebaut): Waffen mit glb/root,
// vm (für actionsOf, gleiche Aktionen wie actions-check) und world-Clips, Agenten-Clips clips_min2, HUD-Manifest.
// agents.ts vor den Spielermodell-Änderungen (Commit 82f72a3) wird als Modul 'agents-old' mitgebündelt: Messung „vorher“;
// agents.ts/xray.ts aus Commit be79ebe (BASE) als 'agents-head'/'xray-head' (Draw-Calls und Bild vor Hülle + Culling: calls, cull, diff).
//   --only=calls,cull,diff,sphere: nur diese Schritte (load immer)
import { build } from 'rolldown'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { vmVariation, weaponAsset, weaponFile } from '../../src/main/assets3d/models.ts'

const only = process.argv.find(a => a.startsWith('--only='))?.slice(7).split(',')
const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const out = resolve(args[0] ?? 'out-agent')
const root = join(process.env.APPDATA, 'CS Demo Analysis')
const demo = args[1] ?? join(root, 'matches', '4699fdaf49070d28.3d.bin.gz')
const pak = readdirSync(join(root, 'assets3d')).find(p => existsSync(join(root, 'assets3d', p, 'items.json')))
if (!pak) throw new Error('no asset cache with items.json (open a 3D replay in the app once)')
const P = join(root, 'assets3d', pak), url = rel => `cs3d://assets3d/${pak}/${rel}`
const json = f => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }

// ---- Assets (Ausschnitt von prepare3d)
const items = json(join(P, 'items.json')).items, roots = json(join(P, 'weapons', 'roots.json')) ?? {}
const table = json(join(P, 'viewmodel', 'table3.json')) ?? {}
const weapons = {}
for (const [def, w] of Object.entries(items.weapons)) {
  const g = weaponFile(w.model)
  const a = weapons[def] = weaponAsset(w, roots[w.model], existsSync(join(P, 'weapons', g)) ? url(`weapons/${g}`) : undefined)
  const v = vmVariation(w.cls), vm = json(join(P, 'viewmodel', `vm_${v}.json`)), wl = json(join(P, 'world', `${w.cls}.json`))
  if (table[v] && vm?.dur) a.vm = { glb: '', clips: '', roles: table[v].roles, dur: vm.dur, snd: vm.snd, win: vm.win }
  if (wl) a.world = { clips: url(`world/${w.cls}.glb`), roles: wl.roles, dur: wl.dur }
}
const assets = {
  clips: url('agents/clips_min2.glb'),
  models: { T: url(`agents/${items.agents[5036]}.glb`), CT: url(`agents/${items.agents[5037]}.glb`) },
  weapons,
  hud: existsSync(join(root, 'assets3d', 'hud', pak, 'manifest.json')) ? `cs3d://assets3d/hud/${pak}/manifest.json` : '',
  // alle Agenten-Modelle im Cache (Draw-Calls je Modell)
  all: [...new Set(Object.values(items.agents))].filter(a => existsSync(join(P, 'agents', `${a}.glb`))).map(a => url(`agents/${a}.glb`)),
  agentUrls: Object.fromEntries(Object.entries(items.agents).filter(([, a]) => existsSync(join(P, 'agents', `${a}.glb`))).map(([id, a]) => [id, url(`agents/${a}.glb`)])),
  toSun: json(join(P, 'maps', 'de_dust2', 'high', 'map.json'))?.settings.sun.toSunGltf ?? [0, 1, 0], // Schritt frame (Dust2)
}
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'assets.json'), JSON.stringify(assets))

// ---- Seite
// virtuelle Module (Dateien gibt es nicht): Inhalt aus Git, relative Importe wie im Original
const E = 'src/renderer/replay3d/engine/', BASE = 'be79ebe' // letzter Stand vor Paket E
const GIT = {
  'agents-old': [resolve(E + 'agents.before-sm.ts'), '82f72a3:' + E + 'agents.ts'],
  'agents-head': [resolve(E + 'agents.head.ts'), BASE + ':' + E + 'agents.ts'],
  'xray-head': [resolve(E + 'xray.head.ts'), BASE + ':' + E + 'xray.ts'],
}
await build({
  input: resolve('scripts/dev3d/agent-page.ts'),
  platform: 'browser',
  transform: { define: { 'import.meta.glob': '(() => ({}))' } }, // weapons.tsx (über replay/scene) nutzt Vite-Glob
  plugins: [{
    name: 'git-modules',
    resolveId: src => GIT[src]?.[0],
    load: id => { const g = Object.values(GIT).find(([f]) => f === id); return g ? execFileSync('git', ['show', g[1]], { encoding: 'utf8' }) : undefined },
  }, { name: 'no-css', load: id => (id.endsWith('.css') ? { code: '', moduleType: 'js' } : undefined) }], // Hud.tsx (drawScope) importiert hud.css
  output: { file: join(out, 'page.js'), format: 'esm', sourcemap: true },
})
writeFileSync(join(out, 'page.html'), `<!doctype html><html><head><meta charset="utf-8"><title>agents</title>
<style>html,body{margin:0;background:#000;overflow:hidden}</style><script type="module" src="page.js"></script></head><body></body></html>`)

// ---- Plan für engine-main.cjs
const plan = {
  out, page: out, timeoutMs: 600000,
  files: {
    'test/assets.json': join(out, 'assets.json'), 'test/demo.3d.bin.gz': demo, 'test/match.json.gz': demo.replace(/.3d.bin.gz$/, '.json.gz'),
    // CS2-Ladebild Dust2 (licht-vergleich/ref) als Szene unter dem Zielfernrohr
    'test/scope-bg.png': '../Daten/downloads/spike/fidelity/licht-vergleich/ref/panorama/images/map_icons/screenshots/1080p/de_dust2_1_png.png',
    'test/ref.png': resolve('docs/ui-referenz/2026-10-21_2_namen-ueber-kopf.png'),
  },
  dirs: { 'assets3d/': join(root, 'assets3d') },
  steps: [
    { step: 'load' },
    { step: 'scene', arg: { kind: 'reload' }, png: 'reload.png' },
    { step: 'scene', arg: { kind: 'throw' }, png: 'throw.png' },
    { step: 'scene', arg: { kind: 'knife' }, png: 'knife.png' },
    { step: 'scene', arg: { kind: 'shoot' }, png: 'shoot.png' },
    { step: 'checks' },
    { step: 'gaps' },
    { step: 'bench', arg: { frames: 1500, reps: 5 } },
    { step: 'labels', png: 'labels.png' },
    { step: 'calls' },
    { step: 'cull', png: 'cull.png' },
    { step: 'diff', png: 'diff.png' },
    { step: 'sphere', arg: { rounds: 'all', frames: 12 } },
    // Dust2 R15 3 s Ego Exi (match.players[8]) wie V/perf-baseline, X-Ray aus/an
    { step: 'frame', arg: { round: 15, sec: 3, player: 8, xray: false }, png: 'frame-r15.png' },
    { step: 'frame', arg: { round: 15, sec: 3, player: 8, xray: true } },
    // Zielfernrohr (Hud.tsx drawScope) über dem CS2-Ladebild: ruhig und bewegt (k wie scopeBlur bei 100 u/s); Vergleich: E/scope-ref.mjs
    { step: 'scope', arg: { k: 0 }, png: 'scope-k0.png' },
    { step: 'scope', arg: { k: 0.36 }, png: 'scope-k036.png' },
  ].filter(s => !only || s.step === 'load' || only.includes(s.step)),
}
writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 1))
console.log('built', out, `(assets ${pak}, ${Object.values(weapons).filter(w => w.world).length} weapons with world clips)`)
