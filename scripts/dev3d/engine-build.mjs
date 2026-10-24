// Baut die Engine-Testseite und den Plan: node scripts/dev3d/engine-build.mjs <outDir> [--real-effects] [--id <match-id>] [--profile high|low]
//   [--src <Ordner>] Seite aus einer Quell-Kopie (A/B gegen einen alten Stand), [--assets <assets.json>] Manifest statt prepare3d
// Danach: electron scripts/dev3d/engine-main.cjs <outDir>/plan.json → <outDir>/result.json + PNGs.
// Assets wie die App: prepare3d aus dem Cache (%APPDATA%\CS Demo Analysis\assets3d; fehlt etwas, baut es wie die App → Build-Lock halten).
// Match + CS3D aus %APPDATA%\CS Demo Analysis\matches (Standard user-demo). Effekte: Ersatz (engine-effects-stub.ts) oder echte (--real-effects).
import { build } from 'rolldown'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d }
const out = resolve(process.argv[2])
const real = process.argv.includes('--real-effects')
const id = arg('--id', '4699fdaf49070d28'), profile = arg('--profile', 'high'), src = resolve(arg('--src', '.')), assetsIn = arg('--assets')
const root = join(process.env.APPDATA, 'CS Demo Analysis'), file3d = join(root, 'matches', `${id}.3d.bin.gz`)
mkdirSync(out, { recursive: true })

// ---- Assets (wie prepareForMatch)
let assets
if (assetsIn) assets = JSON.parse(readFileSync(assetsIn, 'utf8'))
else {
  const { prepare3d } = await import(pathToFileURL(resolve('src/main/assets3d/prepare.ts')).href)
  const { prepareInput } = await import(pathToFileURL(resolve('src/shared/assets3d.ts')).href)
  const raw = gunzipSync(readFileSync(file3d)), h = JSON.parse(raw.toString('utf8', 4, 4 + raw.readUInt32LE(0)))
  h.skins ??= []
  let last = ''
  assets = await prepare3d({ root, ...prepareInput(h), profile }, p => { if (p.msg !== last) console.log(`prepare ${p.pct}% ${(last = p.msg)}`) })
}
writeFileSync(join(out, 'assets.json'), JSON.stringify(assets))
const hud = join(root, 'assets3d', 'hud', assets.map.glb.split('/')[3], 'manifest.json')

// ---- Seite (--src: aus einer Quell-Kopie, Pakete weiter aus diesem Repo)
const STUB = resolve(src, 'scripts/dev3d/engine-effects-stub.ts'), REAL = '\0effects-real'
await build({
  input: resolve(src, 'scripts/dev3d/engine-page.ts'),
  platform: 'browser',
  resolve: { modules: [resolve('node_modules'), 'node_modules'] },
  transform: { define: { 'import.meta.glob': '(() => ({}))' } }, // weapons.tsx (über replay/scene) nutzt Vite-Glob
  plugins: [{
    name: 'effects-wrap',
    resolveId(src, importer) {
      if (src === '../effects' && importer && /replay3d[\\/]engine[\\/]index\.ts$/.test(importer)) return real ? REAL : STUB
    },
    load(x) {
      if (x === REAL) return `import { createEffects as real } from ${JSON.stringify(resolve(src, 'src/renderer/replay3d/effects/index.ts'))}\nimport { wrap } from ${JSON.stringify(STUB)}\nexport const createEffects = wrap(real)`
    },
  }],
  output: { file: join(out, 'page.js'), format: 'esm', sourcemap: true },
})
writeFileSync(join(out, 'page.html'), `<!doctype html><html><head><meta charset="utf-8"><title>engine</title>
<style>html,body{margin:0;background:#000;overflow:hidden}</style><script type="module" src="page.js"></script></head><body></body></html>`)

// ---- Plan (Abnahme EN): R15 62,5 s X-Ray (Criminal_Boy hinter der Kiste), 64,5 s Schaden DiiiDiii
const R15 = { round: 15 }, xr = { ...R15, sec: 62.5 }, dm = { ...R15, sec: 64.5, group: ['DiiiDiii'], back: 3.5, up: 1.2, lookUp: 0.9 }
const plan = {
  out, page: out, timeoutMs: 900000,
  files: { 'test/assets.json': join(out, 'assets.json'), 'test/match.json.gz': join(root, 'matches', `${id}.json.gz`), 'test/test.3d.bin.gz': file3d, ...(existsSync(hud) ? { 'test/hud.json': hud } : {}) },
  dirs: { 'assets3d/': join(root, 'assets3d') },
  steps: [
    { step: 'load', stopOnError: true, arg: { profile, opts: { xray: false, damage: true, nadeCam: false, impacts: false, hideAll: false } } },
    { step: 'nade', png: 'nadecam.png' }, // zuerst: erster Einsatz der Granaten-Kamera
    { step: 'shot', arg: { ...xr, mode: 'ego', player: 'Exi', keep: 'off', opts: { xray: false } }, png: 'xray-off.png' },
    { step: 'shot', arg: { ...xr, mode: 'ego', player: 'Exi', opts: { xray: true } }, png: 'xray-on.png' },
    { step: 'shot', arg: { ...xr, mode: 'ego', player: 'Exi', cmp: 'off', opts: { xray: false } }, png: 'xray-off2.png' },
    { step: 'xtoggle', arg: xr },
    { step: 'bench', arg: { ...xr, mode: 'ego', player: 'Exi', speed: 0, seconds: 3, opts: { xray: false } } },
    { step: 'bench', arg: { ...xr, mode: 'ego', player: 'Exi', speed: 0, seconds: 3, opts: { xray: true } } },
    // Schaden blinkt DAMAGE_S = 3 s nach dem letzten Treffer (Ereignisse R15: DiiiDiii 62,41 s −25, 64,42 −21, 65,59 −16; Exi 64,22 −34; Criminal_Boy 3 × −12)
    { step: 'dmgcheck', arg: { expect: [['DiiiDiii', 15, 64.5, 0.08], ['Exi', 15, 64.5, 0.28], ['DiiiDiii', 15, 65.7, 0.11], ['DiiiDiii', 15, 67.7, 2.11], ['DiiiDiii', 15, 68.7, null]] } },
    { step: 'shot', arg: { ...dm, opts: { xray: false, damage: false } } },
    { step: 'shot', arg: { ...dm, opts: { damage: true } }, png: 'damage.png' },
    { step: 'shot', arg: { ...dm, sec: 67.7 }, png: 'damage-2s.png' },
    { step: 'shot', arg: { ...dm, group: ['Exi'], back: 3, up: 1, side: 1 }, png: 'damage-exi.png' },
    { step: 'overlay' },
    { step: 'shot', arg: { round: 1, sec: 6, group: ['Exi'], back: 5, up: 2.2, lookUp: 1.2, ahead: 4 }, png: 'labels.png' },
    { step: 'act', arg: { kind: 'reload' }, png: 'act-reload.png' },
    { step: 'act', arg: { kind: 'throw', frac: 0.6 }, png: 'act-throw.png' },
    { step: 'act', arg: { kind: 'pullpin', frac: 0.7 }, png: 'act-pullpin.png' },
    { step: 'act', arg: { kind: 'light', at: 0.2 }, png: 'act-knife.png' },
    { step: 'act', arg: { kind: 'inspect', def: 7, ego: true, at: 1.2 }, png: 'ego-ak-inspect.png' },
    { step: 'idle', arg: { round: 15, sec: 30 } },
    { step: 'fly', arg: { round: 15, sec: 30, ms: 300, dx: 40 } },
    { step: 'rounds', arg: { sec: 20 } },
    { step: 'errors' },
  ],
}
writeFileSync(join(out, 'plan.json'), JSON.stringify(plan, null, 1))
console.log('built', out, real ? '(real effects)' : '(effects stub)')
