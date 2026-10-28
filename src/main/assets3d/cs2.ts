// CS2-Installation finden, Source2Viewer-CLI (VRF) bereitstellen und aufrufen, KeyValues (KV1/KV3) lesen.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { unzipSync } from 'fflate'

export const VRF_VERSION = '20.1'
const VRF_URL = `https://github.com/ValveResourceFormat/ValveResourceFormat/releases/download/${VRF_VERSION}/cli-windows-x64.zip`
// SHA-256 von cli-windows-x64.zip (20.1): die heruntergeladene exe wird ausgeführt, also nur genau diese Datei annehmen
const VRF_SHA256 = '67aaf8a67a85ca60fd09ff343e62103a4cdf3a2d177fc656231d7d734c5b3aa3'

export interface CS2 { csgo: string; pak: string; gi: string; patch: string }

/** HKCU\Software\Valve\Steam SteamPath + steamapps\libraryfolders.vdf → …\game\csgo; Patch = steam.inf ClientVersion */
export function findCS2(): CS2 {
  let steam = ''
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true })
    steam = /SteamPath\s+REG_SZ\s+(.+)/.exec(out)?.[1].trim() ?? ''
  } catch {}
  if (!steam) throw new Error('Steam was not found on this PC (registry key HKCU\\Software\\Valve\\Steam is missing).')
  const libs = [steam]
  const vdf = join(steam, 'steamapps', 'libraryfolders.vdf')
  if (existsSync(vdf)) for (const [, lib] of kvList(kv1(readFileSync(vdf, 'utf8')), 'libraryfolders')) { const p = Array.isArray(lib) && kvGet(lib, 'path'); if (typeof p === 'string') libs.push(p) }
  for (const lib of libs) {
    const csgo = join(lib, 'steamapps', 'common', 'Counter-Strike Global Offensive', 'game', 'csgo')
    const pak = join(csgo, 'pak01_dir.vpk')
    if (!existsSync(pak)) continue
    const inf = existsSync(join(csgo, 'steam.inf')) ? readFileSync(join(csgo, 'steam.inf'), 'utf8') : ''
    const patch = /ClientVersion=(\d+)/.exec(inf)?.[1] ?? `m${Math.floor(statSync(pak).mtimeMs / 1000)}`
    return { csgo, pak, gi: join(csgo, 'gameinfo.gi'), patch }
  }
  throw new Error('Counter-Strike 2 is not installed in any Steam library. The 3D replay needs the game files.')
}

/** Größe+mtime einer Datei als Cache-Schlüssel */
export const fileKey = (f: string) => { const s = statSync(f); return `${s.size}:${Math.floor(s.mtimeMs)}` }

/** VRF-CLI nach dir laden (einmalig, 52.8 MB), Rückgabe: Pfad der exe */
export async function ensureVrf(dir: string, onPct: (f: number) => void): Promise<string> {
  const exe = join(dir, 'Source2Viewer-CLI.exe'), stamp = join(dir, 'version.txt')
  if (existsSync(exe) && existsSync(stamp) && readFileSync(stamp, 'utf8') === VRF_VERSION) return exe
  const res = await fetch(VRF_URL)
  if (!res.ok || !res.body) throw new Error(`Downloading Source 2 Viewer failed (HTTP ${res.status}). Check the internet connection.`)
  const total = Number(res.headers.get('content-length')) || 52.8e6
  const parts: Uint8Array[] = []
  let got = 0
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) { parts.push(c); got += c.length; onPct(Math.min(1, got / total)) }
  const zip = Buffer.concat(parts)
  if (createHash('sha256').update(zip).digest('hex') !== VRF_SHA256) throw new Error('Source 2 Viewer download is corrupt (checksum mismatch).')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const [name, data] of Object.entries(unzipSync(zip))) if (!name.endsWith('/')) writeFileSync(join(dir, basename(name)), data)
  if (!existsSync(exe)) throw new Error('Source 2 Viewer archive has no Source2Viewer-CLI.exe.')
  writeFileSync(stamp, VRF_VERSION)
  return exe
}

/**
 * .NET-GC von VRF sparsamer: Map-Export 4,6–4,8 statt 5,1 GB RAM, gleich schnell (gemessen). Kerne nicht begrenzen
 * (DOTNET_PROCESSOR_COUNT=2: 9,4 GB, die Texturen stauen sich)
 */
const VRF_ENV = { ...process.env, DOTNET_GCConserveMemory: '7' }

/**
 * VRF strikt mit 1 Thread; Ausgabe in eine Logdatei (nicht in eine Pipe: dort einmal 0xC0000005).
 * Zielordner von -o muss existieren, sonst nimmt VRF ihn bei genau einer Datei als Dateinamen.
 */
export function vrf(exe: string, args: string[], log: string, retry = true) {
  const fd = openSync(log, 'a')
  try {
    execFileSync(exe, [...args.map(a => a.replaceAll('\\', '/')), '--threads', '1'], { stdio: ['ignore', fd, fd], windowsHide: true, maxBuffer: 1 << 20, env: VRF_ENV })
  } catch (e: any) {
    // selten AccessViolation in TextureExtract.CopyChannel (ORM-Packen läuft trotz --threads 1 parallel): einmal wiederholen
    if (retry && e?.status === 0xc0000005) return vrf(exe, args, log, false)
    throw new Error(`Source 2 Viewer failed (${e?.status ?? e?.code ?? e}). Log: ${log}`)
  } finally { closeSync(fd) }
}

// ---------------------------------------------------------------- Tempo: Hintergrund schonend, Vordergrund parallel
// Hintergrund (Import, App-Start, Match geöffnet): Teile nacheinander, 1 Stapel, 2 Bildaufträge wie früher. Wartet die 3D-Ansicht
// (worker.ts → boost): Teile gleichzeitig, mehr Stapel/Bildaufträge, zusammen höchstens Kerne − 2. Priorität bleibt BELOW_NORMAL.

/** Zähl-Semaphore mit änderbarer Grenze */
export function limiter(max: number) {
  let n = 0
  const q: (() => void)[] = []
  const next = () => { while (n < lim.max && q.length) { n++; q.shift()!() } }
  const lim = {
    max,
    /** freier Platz: f startet sofort (synchron, z. B. VRF-Prozess auch dann, wenn danach blockierender Code folgt) */
    run<T>(f: () => T | Promise<T>): Promise<T> {
      const go = async () => { try { return await f() } finally { n--; next() } }
      if (n < lim.max) { n++; return go() }
      return new Promise<void>(r => q.push(r)).then(go)
    },
    set(m: number) { lim.max = m; next() },
  }
  return lim
}
/** gleichzeitige Skin-Stapel (VRF-Export samt Umwandlung) */
export const slots = limiter(1), MAX_SLOTS = 4
/** gleichzeitige sharp-Aufträge von textureCompress (startet alle Texturen eines Modells auf einmal) */
export const images = limiter(2)
/** große glTF-Exporte (Modelle, Map: 1–5 GB RAM je VRF-Prozess) immer einzeln */
const heavy = limiter(1)

let goFast!: () => void, fastNow = false
/** erfüllt, sobald die 3D-Ansicht wartet (auch mitten im Bau: Promise.race([schritt, fast]) wartet nur im Hintergrund) */
export const fast = new Promise<void>(r => (goFast = r))
/** Vordergrund ab jetzt (Grenzen setzt worker.ts) */
export const boost = () => { fastNow = true; goFast() }
export const isFast = () => fastNow
/** je Bau: lane(f) = unabhängiger Teil, im Hintergrund nach dem vorigen, im Vordergrund sofort; nach einem Fehler startet keiner mehr */
export function lanes() {
  let chain: Promise<unknown> = Promise.resolve(), failed = false
  return <T>(f: () => Promise<T>): Promise<T> => {
    const p = Promise.race([chain, fast]).then(() => { if (failed) throw new Error('3D preparation stopped after an error'); return f() })
    chain = p.catch(() => { failed = true }) // zugleich: Ablehnung gilt als behandelt, der Aufrufer bekommt sie beim await
    return p
  }
}

const procs = new Set<Promise<unknown>>()
const spawnVrf = (exe: string, args: string[], log: string) => {
  const p = new Promise<number | null>((ok, fail) => {
    const fd = openSync(log, 'a')
    try {
      spawn(exe, [...args.map(a => a.replaceAll('\\', '/')), '--threads', '1'], { stdio: ['ignore', fd, fd], windowsHide: true, env: VRF_ENV }).on('error', fail).on('exit', ok)
    } finally { closeSync(fd) } // das Kind hat eine eigene Kopie des Handles
  })
  procs.add(p); p.then(() => procs.delete(p), () => procs.delete(p))
  return p
}
/** bis kein VRF-Prozess mehr läuft (nach einem Fehler, bevor prepare3d tmp löscht) */
export const vrfIdle = async () => { while (procs.size) await Promise.allSettled([...procs]) }
/** vrf() als eigener Prozess, ohne den Worker zu blockieren (andere Teile rechnen weiter); glTF-Exporte einzeln (heavy) */
export function vrfAsync(exe: string, args: string[], log: string): Promise<void> {
  const go = async () => {
    let code = await spawnVrf(exe, args, log)
    if (code === 0xc0000005) code = await spawnVrf(exe, args, log) // wie vrf(): AccessViolation einmal wiederholen
    if (code !== 0) throw new Error(`Source 2 Viewer failed (${code}). Log: ${log}`)
  }
  return args.includes('--gltf_export_format') ? heavy.run(go) : go()
}

/** Datei atomar schreiben (Abbruch hinterlässt keine halbe Datei, die als Cache gälte) */
export function writeAtomic(file: string, data: string | Uint8Array) {
  writeFileSync(file + '.part', data)
  renameSync(file + '.part', file)
}

// ---------------------------------------------------------------- KeyValues

/** KV1 (items_game.txt, libraryfolders.vdf) als Paarliste, doppelte Schlüssel bleiben erhalten */
export type KV = [string, string | KV][]
export function kv1(text: string): KV {
  const re = /"((?:[^"\\]|\\.)*)"|([{}])/g
  const toks: (string | 0 | 1)[] = [] // 0 = '{', 1 = '}'
  for (let m; (m = re.exec(text));) toks.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] === '{' ? 0 : 1)
  let i = 0
  const obj = (): KV => {
    const o: KV = []
    while (i < toks.length) {
      const k = toks[i++]
      if (typeof k !== 'string') return o
      const v = toks[i++]
      o.push([k, v === 0 ? obj() : typeof v === 'string' ? v : ''])
    }
    return o
  }
  return obj()
}
export const kvGet = (o: KV, k: string) => o.find(e => e[0] === k)?.[1]
/** alle Kinder aller Blöcke mit Schlüssel k */
export const kvList = (o: KV, k: string): KV => o.flatMap(e => (e[0] === k && Array.isArray(e[1]) ? e[1] : []))

/** KV3-Text (VRF-dekompiliert: .vsndevts, .vdata, .vsurf, soundmixers.txt) → JS-Objekt */
export function kv3(text: string): any {
  text = text.replace(/^<!--.*?-->/s, '')
  let i = 0
  const n = text.length
  const ws = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++
      if (text.startsWith('//', i)) { while (i < n && text[i] !== '\n') i++; continue }
      if (text.startsWith('/*', i)) { i = text.indexOf('*/', i) + 2; continue }
      break
    }
  }
  const ident = () => {
    const m = /^[A-Za-z0-9_.\-:+]+/.exec(text.slice(i, i + 256))
    if (!m) throw new Error('KV3: unexpected text at ' + i)
    i += m[0].length
    return m[0]
  }
  const str = () => {
    if (text.startsWith('"""', i)) { const e = text.indexOf('"""', i + 3); const s = text.slice(i + 3, e); i = e + 3; return s }
    i++
    let s = ''
    while (text[i] !== '"') { if (text[i] === '\\') { s += text[i + 1]; i += 2 } else s += text[i++] }
    i++
    return s
  }
  const value = (): any => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      const o: any = {}
      for (;;) {
        ws()
        if (text[i] === '}') { i++; return o }
        const k = text[i] === '"' ? str() : ident()
        ws()
        if (text[i] !== '=') throw new Error('KV3: = expected at ' + i)
        i++
        o[k] = value()
      }
    }
    if (c === '[') {
      i++
      const a: any[] = []
      for (;;) { ws(); if (text[i] === ']') { i++; return a } a.push(value()); ws(); if (text[i] === ',') i++ }
    }
    if (c === '"') return str()
    const id = ident()
    if (id.endsWith(':') && text[i] === '"') return value() // resource:"…"
    ws()
    if (text[i] === ':') { i++; return value() }
    if (id === 'true') return true
    if (id === 'false') return false
    if (id === 'null') return null
    const num = Number(id)
    if (!Number.isNaN(num)) return num
    if (/^[a-z_]+$/.test(id) && text[i] === '"') return value() // Flag-Präfix
    return id
  }
  return value()
}
