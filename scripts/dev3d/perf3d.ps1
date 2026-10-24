# Mess- und Bild-Lauf der echten App (CPU je Prozess, Hauptthread, ms/Bild, Draw-Calls, HUD-Commits, Screenshots), Plan-Format in perf3d-main.cjs.
#   .\scripts\dev3d\perf3d.ps1 -Plan <plan.json> [-NoBuild]
# Hält F:\csdemoanalysis\.build.lock (fremde Sperre < 20 min: alle 30 s neu versuchen), baut (electron-vite build, niedrige Priorität),
# startet die App mit eigenem userData (Optionen/Hotkeys/Caches getrennt; matches + assets3d als Verknüpfung auf die App, kein Neubau).
# Fenster unsichtbar neben den Monitoren, alle Prozesse mit niedriger Priorität; am Ende ist kein Test-Prozess mehr offen.
param([Parameter(Mandatory)][string]$Plan, [switch]$NoBuild, [string]$UserData = [IO.Path]::GetFullPath("$PSScriptRoot\..\..\..\Daten\perf3d\userdata"))
$ErrorActionPreference = 'Stop'
$env:Path = "C:\Program Files\nodejs;" + $env:Path
$root = Split-Path (Split-Path $PSScriptRoot)
$lock = Join-Path $root '.build.lock'
$planFull = (Resolve-Path $Plan).Path
while ($true) {
  try { $f = [IO.File]::Open($lock, 'CreateNew', 'Write'); $f.Dispose(); Set-Content $lock "perf3d $(Get-Date -Format s)"; break }
  catch {
    if ((Test-Path $lock) -and ((Get-Date) - (Get-Item $lock).LastWriteTime).TotalMinutes -ge 20) { Remove-Item $lock -Force }
    else { "build lock busy ($(Get-Content $lock -ErrorAction SilentlyContinue)), retry in 30 s"; Start-Sleep 30 }
  }
}
try {
  Set-Location $root
  if (-not $NoBuild) { cmd /c --% start "" /low /b /wait npx electron-vite build 2>&1 | Select-String -Pattern 'error' | Write-Output }
  $app = Join-Path $env:APPDATA 'CS Demo Analysis'
  New-Item -ItemType Directory -Force $UserData | Out-Null
  foreach ($d in 'matches', 'assets3d') {
    $l = Join-Path $UserData $d
    if (-not (Test-Path $l)) { New-Item -ItemType Junction -Path $l -Target (Join-Path $app $d) | Out-Null }
  }
  $env:PERF3D_USERDATA = $UserData
  $p = Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList @('scripts\dev3d\perf3d-main.cjs', "`"$planFull`"") -NoNewWindow -PassThru
  $null = $p.Handle # sonst bleibt ExitCode leer
  $p.WaitForExit()
  # Reste (GPU/Renderer/Utility) dieses Laufs beenden
  Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" | Where-Object { $_.CommandLine -match 'perf3d|PERF3D' -or $_.CommandLine -match [regex]::Escape($UserData) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  "exit $($p.ExitCode)"
} finally {
  if ((Get-Content $lock -ErrorAction SilentlyContinue) -like 'perf3d *') { Remove-Item $lock -Force }
}
