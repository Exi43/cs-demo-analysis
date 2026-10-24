# Selbsttest: baut die App, öffnet eine Ansicht und speichert einen Screenshot (Fenster unsichtbar neben den Monitoren, CSDA_SHOW=1 = Monitor 2).
# Beispiel: .\scripts\shot.ps1 -View auto/replay/3/38 -Out $env:TEMP\shot.png [-Demo demos\x.dem] [-NoBuild]
# 3D: .\scripts\shot.ps1 -View auto/replay3d/20/37.3/ego/3[/xray,impacts,nadeCam] -Ready 600000 -Wait 2500
#     Ready: erst warten, bis 3D läuft; Kamera ego|free, Spielerindex in match.players; Optionen nur für diese Sitzung (options.ts,
#     Name = an, Name=0 = aus, z. B. 'showKeys,minimap=0' oder 'hideAll'). Größe: $env:CSDA_SIZE = '1920x1080'.
param([string]$View = 'auto/replay/1/10', [string]$Out = "$env:TEMP\csda.png", [string]$Demo = '', [int]$Wait = 5000, [int]$Scroll = 0, [int]$Ready = 0, [switch]$NoBuild)
$env:CSDA_SCROLL = if ($Scroll) { $Scroll } else { '' }
$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location (Split-Path $PSScriptRoot)
if (-not $NoBuild) { npx electron-vite build 2>&1 | Select-String -Pattern 'error' | Write-Output }
$env:CSDA_SHOT = $Out; $env:CSDA_VIEW = $View; $env:CSDA_WAIT = $Wait; $env:CSDA_READY = $Ready
$env:CSDA_DEMO = if ($Demo) { (Resolve-Path $Demo).Path } else { '' }
$p = Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.' -PassThru -Wait -RedirectStandardOutput "$env:TEMP\csda_out.txt" -RedirectStandardError "$env:TEMP\csda_err.txt"
Get-Content "$env:TEMP\csda_out.txt" -Tail 10
Get-Content "$env:TEMP\csda_err.txt" -Tail 15
"exit $($p.ExitCode) -> $Out"
