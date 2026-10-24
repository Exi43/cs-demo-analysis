// Mess- und Bild-Lauf mit der echten App (out/ von electron-vite build), gestartet von perf3d.ps1: electron perf3d-main.cjs <plan.json>
// plan: { out, userData? (sonst PERF3D_USERDATA), view, size?, ready?, demo?, steps: [{ label, js?, focus?, act?, wait?, measure?, png? }] }
//   view    = Optionen immer im Hash festlegen (z. B. build-light-skins/V/mkplan.cjs PIN): der perf3d-userData speichert Toggles früherer Läufe
//   js      = Ausdruck in der Seite, z. B. "__h3.at(15, 3)", "__h3.act('xray')", "__h3.opt({ lowQuality: true })", "__h3.audio()" (Replay3DView, nur unter #auto/)
//   focus   = true: Fensterfokus emulieren (CDP, document.hasFocus() = true, ohne Berat den Fokus zu stehlen); false: ohne Fokus
//   act     = 'minimize' (danach nicht wiederherstellen: restore holt das Fenster nach vorn)
//   measure = ms: CPU je Prozess (app.getAppMetrics), Renderer-Hauptthread (CDP Performance ThreadTime), Bilder/s, Draw-Calls und ms/Bild
//             aus [data-h3-stats], DOM-Commits/s des HUD (MutationObserver ≈ React-Renders mit Änderung)
//   profile = ms: CDP-CPU-Profil des Renderers (<label>.cpuprofile, in DevTools ladbar) + Top-Funktionen self/total in % aller Samples
// Ergebnis: <out>/<plan.log ?? perf.json> (nach jedem Schritt) + PNGs. Fenster wie der Selbsttest unsichtbar neben den Monitoren (CSDA_SHOT), niedrige
// Priorität, eigener userData-Ordner (Optionen/Hotkeys/Caches getrennt, matches + assets3d per Verknüpfung aus perf3d.ps1).
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')

try { os.setPriority(os.constants.priority.PRIORITY_LOW) } catch { /* nicht erlaubt: normal weiter */ } // GPU/Renderer erben die Klasse (Berat spielt)
const ROOT = path.resolve(__dirname, '../..')
const plan = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'))
const out = path.resolve(plan.out)
fs.mkdirSync(out, { recursive: true })
app.setPath('userData', process.env.PERF3D_USERDATA || plan.userData)
app.getAppPath = () => ROOT // resources/maps relativ zum Projekt, nicht zu scripts/dev3d
Object.assign(process.env, {
  CSDA_SHOT: path.join(out, '_last.png'), CSDA_VIEW: plan.view, CSDA_READY: String(plan.ready ?? 600000), CSDA_WAIT: String(864e5),
  CSDA_SIZE: plan.size ?? '1920x1080', CSDA_DEMO: plan.demo ?? '',
})
const sleep = ms => new Promise(r => setTimeout(r, ms))
setTimeout(() => { console.log('perf3d: timeout'); app.exit(2) }, plan.timeoutMs ?? 20 * 60e3).unref()

// Seite: DOM-Commits des HUD zählen
const PAGE = `(() => { if (window.__perf) return; const p = window.__perf = { n: 0 }; const hud = document.querySelector('.hud-stage');
  if (hud) new MutationObserver(() => { p.n++ }).observe(hud, { subtree: true, childList: true, attributes: true, characterData: true }) })()` // ohne 3D-Ansicht (view auto/report): keine Zählung

async function run(win) {
  const dbg = win.webContents.debugger, eval_ = js => win.webContents.executeJavaScript(js)
  dbg.attach('1.3')
  await dbg.sendCommand('Performance.enable', { timeDomain: 'threadTicks' })
  win.webContents.setBackgroundThrottling(true) // wie die echte App (der Selbsttest schaltet es aus)
  for (const end = Date.now() + (plan.ready ?? 600000); Date.now() < end && !(await eval_(`!!document.querySelector('[data-h3-ready], .h3-load .error')`)); await sleep(500));
  await eval_(PAGE)
  const metrics = async () => Object.fromEntries((await dbg.sendCommand('Performance.getMetrics')).metrics.map(m => [m.name, m.value]))
  const cpu = () => Object.fromEntries(app.getAppMetrics().map(m => [m.type + (m.type === 'Utility' ? `:${m.name ?? m.pid}` : ''), m.cpu.cumulativeCPUUsage ?? NaN]))
  const log = { started: new Date().toISOString(), cpus: os.cpus()[0]?.model, plan: path.basename(process.argv[process.argv.length - 1]), view: plan.view, steps: [] }
  for (const s of plan.steps) {
    const e = { label: s.label }
    try {
      if (s.focus !== undefined) await dbg.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: !!s.focus })
      if (s.js) e.js = await eval_(s.js)
      if (s.act === 'minimize') win.minimize()
      await sleep(s.wait ?? 1000)
      if (s.measure) {
        await eval_('window.__perf.n = 0')
        const t0 = Date.now(), c0 = cpu(), p0 = await metrics()
        await sleep(s.measure)
        const c1 = cpu(), p1 = await metrics(), sec = (Date.now() - t0) / 1000, r1 = v => Math.round(v * 10) / 10
        e.cpuPct = Object.fromEntries(Object.keys(c1).map(k => [k, r1((c1[k] - (c0[k] ?? c1[k])) / sec * 100)]))
        e.mainThreadPct = r1((p1.ThreadTime - p0.ThreadTime) / sec * 100)
        e.scriptPct = r1((p1.ScriptDuration - p0.ScriptDuration) / sec * 100)
        e.hudCommitsPerS = r1(await eval_('window.__perf.n') / sec)
        e.stats = await eval_(`document.querySelector('[data-h3-stats]')?.getAttribute('data-h3-stats') ?? ''`)
        // '<fps> fps · <n> draw calls (world 300, viewmodel 5, post 10) · …': Aufteilung optional
        const m = /^(\d+) fps · (\d+) draw calls(?: \(([^)]*)\))? · ([\d.]+) ms\/frame · cpu ([\d.]+) ms/.exec(e.stats)
        if (m) Object.assign(e, { fps: +m[1], drawCalls: +m[2], msPerFrame: +m[4], cpuMsPerFrame: +m[5] }, m[3] && { callsBy: Object.fromEntries(m[3].split(', ').map(x => x.split(' ')).map(([k, v]) => [k, +v])) })
      }
      if (s.profile) {
        await dbg.sendCommand('Profiler.enable'); await dbg.sendCommand('Profiler.setSamplingInterval', { interval: 250 })
        await dbg.sendCommand('Profiler.start'); await sleep(s.profile)
        const { profile: pr } = await dbg.sendCommand('Profiler.stop')
        fs.writeFileSync(path.resolve(out, `${s.label}.cpuprofile`), JSON.stringify(pr))
        e.profile = topFns(pr)
      }
      if (s.png) { fs.writeFileSync(path.resolve(out, s.png), (await win.webContents.capturePage()).toPNG()); e.png = s.png }
    } catch (err) { e.error = String(err?.message ?? err) }
    log.steps.push(e)
    console.log('perf3d', JSON.stringify(e))
    fs.writeFileSync(path.join(out, plan.log ?? 'perf.json'), JSON.stringify(log, null, 1))
  }
}

/** Top-n Funktionen eines CDP-Profils: self = eigene Samples, total = inkl. Aufgerufener (Rekursion einmal gezählt), in % aller Samples (inkl. idle) */
function topFns(pr, n = 25) {
  const byId = new Map(pr.nodes.map(x => [x.id, x])), self = new Map(), total = new Map(), seen = new Set()
  const all = pr.nodes.reduce((a, x) => a + (x.hitCount ?? 0), 0) || 1
  const key = ({ callFrame: c }) => `${c.functionName || '(anon)'} ${c.url.split('/').pop()}:${c.lineNumber + 1}`
  const add = (m, k, v) => m.set(k, (m.get(k) ?? 0) + v)
  const walk = x => {
    const k = key(x), first = !seen.has(k)
    seen.add(k)
    let t = x.hitCount ?? 0
    for (const c of x.children ?? []) t += walk(byId.get(c))
    if (first) { seen.delete(k); add(total, k, t) }
    add(self, k, x.hitCount ?? 0)
    return t
  }
  walk(pr.nodes[0])
  const top = m => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${(v / all * 100).toFixed(1)}% ${k}`)
  return { samples: all, self: top(self), total: top(total) }
}

app.on('browser-window-created', (_e, win) => {
  win.webContents.once('did-finish-load', () => run(win).catch(e => console.log('perf3d failed', e)).finally(() => app.exit(0)))
})
require(path.join(ROOT, 'out/main/index.js'))
