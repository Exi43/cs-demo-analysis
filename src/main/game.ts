// Läuft gerade ein Spiel? Dann wartet die Hintergrundarbeit (3D-Vorbau, Neu-Einlesen alter Matches), damit das Spiel Ruhe hat.
// Nur die Prozessliste lesen (WMI per PowerShell, ~0,4 s), nie an Prozesse anhängen. Gefragt wird nur, solange Hintergrundarbeit
// ansteht, höchstens alle 30 s; ohne Antwort (kein Windows, Fehler) gilt: kein Spiel.
import { execFile } from 'node:child_process'
import { constants, setPriority } from 'node:os'

/** Spiele-Ordner von Steam, Riot und Epic sowie cs2.exe */
const GAME = /\\steamapps\\common\\|\\Riot Games\\|\\Epic Games\\|\\cs2\.exe$/i
/** Werkzeuge in diesen Ordnern, die oft dauernd laufen. shortcut: feste Liste; blockiert ein weiteres Werkzeug den Hintergrund, hier ergänzen */
const TOOL = /\\steamapps\\common\\(wallpaper_engine|rainmeter|Lossless Scaling|Steamworks Shared|Steam Controller Configs)\\|\\Riot Games\\Riot Client\\|\\Epic Games\\(Launcher|Epic Online Services)\\/i
/**
 * Spiele außerhalb dieser Ordner bzw. mit verborgenem Pfad (Anti-Cheat wie BattlEye: WMI liefert dann kein ExecutablePath) per Prozessname.
 * shortcut: feste Liste; läuft ein weiteres Spiel ohne Pause der Hintergrundarbeit, hier ergänzen
 */
const NAMES = ['cs2.exe', 'EscapeFromTarkov.exe', 'RobloxPlayerBeta.exe', 'VALORANT-Win64-Shipping.exe', 'League of Legends.exe',
  'FortniteClient-Win64-Shipping.exe', 'r5apex.exe', 'r5apex_dx12.exe', 'GTA5.exe', 'GTA5_Enhanced.exe', 'FiveM.exe', 'Overwatch.exe',
  'RainbowSix.exe', 'RainbowSix_BE.exe', 'cod.exe', 'RustClient.exe', 'TslGame.exe', 'Minecraft.Windows.exe']
const byName = new Set(NAMES.map(n => n.toLowerCase()))
export const isGame = (exe: string) => (GAME.test(exe) && !TOOL.test(exe)) || byName.has(exe.split('\\').pop()!.toLowerCase())

const WQL = ['%\\\\steamapps\\\\common\\\\%', '%\\\\Riot Games\\\\%', '%\\\\Epic Games\\\\%'].map(p => `ExecutablePath like '${p}'`).join(' or ')
  + NAMES.map(n => ` or Name = '${n}'`).join('')
// Klartext statt -EncodedCommand: den prüft der Virenscanner beim Start ~1,4 s, so lange stand der Main-Prozess (Fenster hing) still.
// Ohne Pfad (Anti-Cheat) den Namen ausgeben
const PS = `Get-CimInstance Win32_Process -Property ExecutablePath,Name -Filter "${WQL}" | ForEach-Object { if ($_.ExecutablePath) { $_.ExecutablePath } else { $_.Name } }`
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
