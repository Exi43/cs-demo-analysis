import { describe, expect, it } from 'vitest'
import { isGame } from './game.ts'

describe('isGame', () => {
  it('games in Steam, Riot and Epic folders and cs2.exe count', () => {
    for (const p of [
      'D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive\\game\\bin\\win64\\cs2.exe',
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arc Raiders\\PioneerGame.exe',
      'C:\\Riot Games\\VALORANT\\live\\VALORANT.exe',
      'C:\\Program Files\\Epic Games\\Fortnite\\FortniteGame\\Binaries\\Win64\\FortniteClient-Win64-Shipping.exe',
      'E:\\Games\\cs2.exe',
      'F:\\EFT\\EFT\\EscapeFromTarkov.exe',
      'EscapeFromTarkov.exe', // Pfad von BattlEye verborgen: nur der Name
      'RobloxPlayerBeta.exe',
    ]) expect(isGame(p), p).toBe(true)
  })
  it('tools in those folders, launchers and other programs do not', () => {
    for (const p of [
      'C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe',
      'D:\\SteamLibrary\\steamapps\\common\\rainmeter\\Rainmeter.exe',
      'D:\\SteamLibrary\\steamapps\\common\\Lossless Scaling\\LosslessScaling.exe',
      'C:\\Riot Games\\Riot Client\\RiotClientServices.exe',
      'C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win64\\EpicGamesLauncher.exe',
      'C:\\Program Files (x86)\\Steam\\steam.exe',
      'C:\\Windows\\explorer.exe',
    ]) expect(isGame(p), p).toBe(false)
  })
})
