// Electron-Harness für replay3d/engine: electron scripts/dev3d/engine-main.cjs <plan.json>
// plan.json: { out, page, files: {rel: absPfad}, dirs: {prefix: absOrdner}, steps: [{ step, arg, png?, stopOnError? }], fast?, timeoutMs? }
// cs3d://<rel> wie das App-Protokoll; Ergebnis: <out>/result.json (nach jedem Schritt) + PNGs (r.png → <png>, r.pngStart → <png ohne .png>.start.png). Fenster 1280x720 neben allen Monitoren,
// niedrige Priorität, harter Timeout.
// Mit vsync (schont die GPU, wenn nebenbei gespielt wird); plan.fast = ohne vsync/Bildlimit. Abbruch nur bei Fehler in Schritten mit stopOnError.
const { app, BrowserWindow, protocol, net, screen } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { execFileSync } = require('node:child_process')

try { os.setPriority(os.constants.priority.PRIORITY_BELOW_NORMAL) } catch {} // Kindprozesse (GPU, Renderer) erben die Klasse
const plan = JSON.parse(fs.readFileSync(process.argv[process.argv.length - 1], 'utf8'))
app.setPath('userData', path.join(plan.out, 'userdata'))
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: 'cs3d', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion') // Fenster außerhalb der Monitore nicht als verdeckt drosseln
if (plan.fast) { app.commandLine.appendSwitch('disable-gpu-vsync'); app.commandLine.appendSwitch('disable-frame-rate-limit') }
const vram = () => { try { return +execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits']).toString().trim() } catch { return null } }
const hard = setTimeout(() => { console.error('hard timeout'); app.exit(2) }, plan.timeoutMs ?? 180000)

app.whenReady().then(async () => {
  const serve = (file) => file && fs.existsSync(file)
    ? net.fetch(pathToFileURL(file).toString()).then(r => new Response(r.body, { status: 200, headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(fs.statSync(file).size), 'access-control-allow-origin': '*' } }))
    : new Response('not found', { status: 404 })
  protocol.handle('app', req => serve(path.join(plan.page, decodeURIComponent(new URL(req.url).pathname))))
  protocol.handle('cs3d', req => {
    const u = new URL(req.url), rel = decodeURIComponent(u.host + u.pathname)
    if (rel.includes('..')) return new Response('forbidden', { status: 403 })
    if (plan.files[rel]) return serve(plan.files[rel])
    const pre = Object.keys(plan.dirs).find(p => rel.startsWith(p)), file = pre && path.join(plan.dirs[pre], rel.slice(pre.length))
    if (file && path.basename(file) === 'tex.pack' && !fs.existsSync(file)) return texPack(path.dirname(file))
    return serve(file)
  })
  // Map-Texturen als ein Stream wie main/assets3d/texpack.ts: [u32 n][u32 len × n][Dateien in der Reihenfolge von gltf.images]
  const texPack = dir => {
    const gltf = fs.readdirSync(dir).find(f => f.endsWith('.gltf'))
    if (!gltf) return new Response('not found', { status: 404 })
    const bufs = JSON.parse(fs.readFileSync(path.join(dir, gltf), 'utf8')).images.map(im => { const f = path.resolve(dir, decodeURIComponent(im.uri)); return fs.existsSync(f) ? fs.readFileSync(f) : Buffer.alloc(0) })
    return new Response(Buffer.concat([Buffer.from(new Uint32Array([bufs.length, ...bufs.map(b => b.length)]).buffer), ...bufs]))
  }
  // wie der App-Selbsttest: angezeigt, aber links neben allen Monitoren und ohne Taskleiste (verborgen liefe rAF nur ~1×/s, GPU-Zeiten falsch)
  const left = Math.min(...screen.getAllDisplays().map(d => d.bounds.x))
  const win = new BrowserWindow({ width: 1280, height: 720, x: left - 1280 - 200, y: 0, useContentSize: true, show: false, skipTaskbar: true, webPreferences: { backgroundThrottling: false } })
  win.showInactive()
  win.webContents.on('console-message', e => { const m = String(e.message ?? e); if (!/ready/.test(m)) console.log('[page]', m.slice(0, 500)) })
  await win.loadURL('app://p/page.html')
  const res = { vramMB: { before: vram() }, steps: [] }
  for (const s of plan.steps) {
    const t0 = Date.now()
    let r
    try { r = await win.webContents.executeJavaScript(`window.step(${JSON.stringify(s.step)}, ${JSON.stringify(s.arg ?? {})})`) }
    catch (e) { r = { error: String(e) } }
    if (r?.png) { if (s.png) fs.writeFileSync(path.join(plan.out, s.png), Buffer.from(r.png.split(',')[1], 'base64')); delete r.png }
    if (r?.pngStart) { if (s.png) fs.writeFileSync(path.join(plan.out, s.png.replace(/\.png$/, '.start.png')), Buffer.from(r.pngStart.split(',')[1], 'base64')); delete r.pngStart }
    if (s.vram) res.vramMB[s.vram] = vram()
    res.steps.push({ step: s.step, png: s.png, wallMs: Date.now() - t0, ...r })
    console.log(s.step, s.png ?? '', JSON.stringify(r).slice(0, 600))
    fs.writeFileSync(path.join(plan.out, 'result.json'), JSON.stringify(res, null, 1)) // auch bei hartem Timeout bleibt alles bis hier
    if (r?.error && s.stopOnError) break
  }
  clearTimeout(hard)
  win.destroy()
  app.quit()
}).catch(e => { console.error(e); app.exit(1) })
