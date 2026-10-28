// Läuft gerade ein Spiel? Dann wartet die Hintergrundarbeit (3D-Vorbau, Neu-Einlesen alter Matches), damit das Spiel Ruhe hat.
// Nur die Prozessliste lesen (WMI per PowerShell, ~0,4 s), nie an Prozesse anhängen. Gefragt wird nur, solange Hintergrundarbeit
// ansteht, höchstens alle 30 s; ohne Antwort (kein Windows, Fehler) gilt: kein Spiel.
import { execFile } from 'node:child_process'
import { constants, setPriority } from 'node:os'

/** Spiele-Ordner von Steam, Riot und Epic sowie cs2.exe */
const GAME = /\\steamapps\\common\\|\\Riot Games\\|\\Epic Games\\|\\cs2\.exe$/i
/** Werkzeuge in diesen Ordnern, die oft dauernd laufen. shortcut: feste Liste; blockiert ein weiteres Werkzeug den Hintergrund, hier ergänzen */
const TOOL = /\\steamapps\\common\\(wallpaper_engine|rainmeter|Lossless Scaling|Steamworks Shared|Steam Controller Configs)\\|\\Riot Games\\Riot Client\\|\\Epic Games\\(Launcher|Epic Online Services)\\/i
export const isGame = (exe: string) => GAME.test(exe) && !TOOL.test(exe)

const WQL = ['%\\\\steamapps\\\\common\\\\%', '%\\\\Riot Games\\\\%', '%\\\\Epic Games\\\\%'].map(p => `ExecutablePath like '${p}'`).join(' or ') + ` or Name = 'cs2.exe'`
// Klartext statt -EncodedCommand: den prüft der Virenscanner beim Start ~1,4 s, so lange stand der Main-Prozess (Fenster hing) still
const PS = `Get-CimInstance Win32_Process -Property ExecutablePath -Filter "${WQL}" | ForEach-Object ExecutablePath`
const POLL = 30e3

let last = -Infinity, cur: Promise<boolean> = Promise.resolve(false)
/** true = ein Spiel läuft; Antwort höchstens POLL alt */
export function gameRunning(): Promise<boolean> {
  if (process.platform !== 'win32' || Date.now() - last < POLL) return cur
  last = Date.now()
  return (cur = new Promise(res => {
    const ps = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], { windowsHide: true, timeout: 20e3 },
      (err, out) => res(!err && out.split(/\r?\n/).some(isGame)))
    try { setPriority(ps.pid!, constants.priority.PRIORITY_LOW) } catch {}
  }))
}

/** wartet, bis kein Spiel mehr läuft */
export async function noGame() { while (await gameRunning()) await new Promise(r => setTimeout(r, POLL)) }
