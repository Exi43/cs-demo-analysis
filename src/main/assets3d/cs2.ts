// CS2-Installation finden, Source2Viewer-CLI (VRF) bereitstellen und aufrufen, KeyValues (KV1/KV3) lesen.
import { execFileSync } from 'node:child_process'
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
 * VRF strikt mit 1 Thread; Ausgabe in eine Logdatei (nicht in eine Pipe: dort einmal 0xC0000005).
 * Zielordner von -o muss existieren, sonst nimmt VRF ihn bei genau einer Datei als Dateinamen.
 */
export function vrf(exe: string, args: string[], log: string, retry = true) {
  const fd = openSync(log, 'a')
  try {
    execFileSync(exe, [...args.map(a => a.replaceAll('\\', '/')), '--threads', '1'], { stdio: ['ignore', fd, fd], windowsHide: true, maxBuffer: 1 << 20 })
  } catch (e: any) {
    // selten AccessViolation in TextureExtract.CopyChannel (ORM-Packen läuft trotz --threads 1 parallel): einmal wiederholen
    if (retry && e?.status === 0xc0000005) return vrf(exe, args, log, false)
    throw new Error(`Source 2 Viewer failed (${e?.status ?? e?.code ?? e}). Log: ${log}`)
  } finally { closeSync(fd) }
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
