// App-Protokoll (log.ts): Pfade anonymisieren, gleiche Meldungen drosseln, Rotation nach *.old.log, Zeilen zum 3D-Bau
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

// log.ts legt beim Import das App-Protokoll <userData>\app.log an (schreibt erst bei Aufruf)
vi.mock('electron', () => ({ app: { getPath: () => `${process.env.TEMP ?? '/tmp'}/csda-log-test-${process.pid}` } }))
const { createLog, log3d, log3dView } = await import('./log.ts')

const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
const tmpLog = () => { const d = mkdtempSync(join(tmpdir(), 'csda-log-')); dirs.push(d); return join(d, 'app.log') }
/** Zeilen ohne Zeitstempel: "LEVEL text" */
const lines = (f: string) => readFileSync(f, 'utf8').trimEnd().split('\n').map(l => l.slice(24).replace(/ +/, ' '))

describe('createLog', () => {
  it('ersetzt den Benutzerordner in jeder Schreibweise, aber keinen anderen Benutzer', () => {
    const f = tmpLog(), L = createLog(f, 'C:\\Users\\Max Muster (x)')
    L.info('C:\\Users\\Max Muster (x)\\AppData\\Roaming\\CS Demo Analysis | file:///c:/users/max%20muster%20(x)/demo.dem')
    L.info('C:\\Users\\Max Muster (x)2\\a.dem | D:\\Demos\\b.dem | "C:\\Users\\Max Muster (x)"')
    expect(lines(f)).toEqual([
      'INFO %USERPROFILE%\\AppData\\Roaming\\CS Demo Analysis | file:///%USERPROFILE%/demo.dem',
      'INFO C:\\Users\\Max Muster (x)2\\a.dem | D:\\Demos\\b.dem | "%USERPROFILE%"',
    ])
    const g = tmpLog() // kein Benutzerordner bekannt: nichts ersetzen (leeres Muster träfe sonst jede Stelle)
    createLog(g, '').info('C:\\Users\\Max\\a.dem')
    expect(lines(g)).toEqual(['INFO C:\\Users\\Max\\a.dem'])
  })

  it('schreibt gleiche Meldungen höchstens 1×/min und meldet die übersprungenen', () => {
    let t = Date.UTC(2026, 9, 28, 3, 0, 0)
    const f = tmpLog(), L = createLog(f, 'C:\\Users\\Max', 2e6, () => t)
    for (let i = 0; i < 5; i++) { L.warn('GPU process gone'); t += 1000 } // 1 geschrieben, 4 gezählt
    L.error('GPU process gone') // andere Stufe = andere Meldung
    t += 60e3
    L.warn('GPU process gone') // neue Minute: mit Zahl der übersprungenen
    L.info('Quit'); L.info('Quit')
    L.flush()
    L.flush() // zweimal: nichts doppelt
    const until = new Date(Date.UTC(2026, 9, 28, 3, 0, 4)).toTimeString().slice(0, 8)
    expect(lines(f)).toEqual([
      'WARN GPU process gone',
      'ERROR GPU process gone',
      `WARN (+4 more until ${until}) GPU process gone`,
      'INFO Quit',
      `INFO (+1 more until ${new Date(t).toTimeString().slice(0, 8)}) Quit`,
    ])
  })

  it('kürzt lange Meldungen und rückt Folgezeilen ein', () => {
    const f = tmpLog(), L = createLog(f, 'C:\\Users\\Max')
    L.error(`Error: boom\n    at x (a.js:1:2)\n${'y'.repeat(6000)}`)
    const text = readFileSync(f, 'utf8')
    expect(text).toContain('ERROR Error: boom\n        at x (a.js:1:2)\n    yyy')
    expect(text).toMatch(/y … \(\+1032 chars\)\n$/)
    expect(text.length).toBeLessThan(5100)
  })

  it('benennt bei Überschreiten der Größe in app.old.log um und schreibt neu weiter', () => {
    const f = tmpLog(), old = f.replace(/app\.log$/, 'app.old.log'), L = createLog(f, 'C:\\Users\\Max', 400)
    for (let i = 0; i < 6; i++) L.info(`line ${i} ${'x'.repeat(60)}`)
    expect(existsSync(old)).toBe(true)
    expect(statSync(f).size).toBeLessThanOrEqual(400)
    expect(lines(old)[0]).toMatch(/^INFO line 0 /)
    const now = lines(f)
    expect(now[0]).toBe('INFO Log continues, older lines in app.old.log')
    expect(now.at(-1)).toMatch(/^INFO line 5 /)
    // vorhandene Datei: Größe zählt weiter (neue Instanz = neuer App-Start)
    createLog(f, 'C:\\Users\\Max', 400).info('y'.repeat(300))
    expect(lines(f)).toEqual(['INFO Log continues, older lines in app.old.log', `INFO ${'y'.repeat(300)}`])
  })
})

describe('log3d', () => {
  it('Start vorne/hinten, Schritte ab 1 s, Cache, Fehler mit letztem Schritt', () => {
    const dir = `${process.env.TEMP ?? '/tmp'}/csda-log-test-${process.pid}`
    mkdirSync(dir, { recursive: true }); dirs.push(dir)
    vi.useFakeTimers({ now: Date.UTC(2026, 9, 28, 3) })
    const st = (id: string, msg: string, ms: number, pct = 0) => { log3d({ id, state: 'building', pct, msg }); vi.advanceTimersByTime(ms) }
    log3dView('a') // 3D-Replay geöffnet → Vordergrund
    st('a', 'Starting', 1500) // Prozessstart zählt nicht als Schritt
    st('a', 'Locating', 200)
    st('a', 'Exporting map', 95000, 8)
    st('a', 'Ready', 0, 100)
    log3d({ id: 'a', state: 'ready', pct: 100, msg: 'Ready' })
    log3dView('a') // Ergebnis im Speicher
    st('b', 'Starting', 1200)
    st('b', 'Locating', 300)
    log3d({ id: 'b', state: 'ready', pct: 100, msg: 'Ready' })
    st('c', 'Starting', 100)
    st('c', 'Exporting map', 2000, 12)
    log3d({ id: 'c', state: 'error', pct: 0, msg: '3D asset builder crashed (code 1).' })
    vi.useRealTimers()
    expect(lines(join(dir, 'app.log'))).toEqual([
      'INFO 3D replay opened: a',
      'INFO 3D a: build start (foreground)',
      "INFO 3D a: 'Exporting map' took 95.0 s",
      'INFO 3D a: ready after 96.7 s',
      'INFO 3D replay opened: a (assets cached)',
      'INFO 3D b: build start (background)',
      'INFO 3D b: ready after 1.5 s (all cached)',
      'INFO 3D c: build start (background)',
      "ERROR 3D c: failed after 2.1 s at 'Exporting map' (12 %): 3D asset builder crashed (code 1).",
    ])
  })
})
