# Selbsttest: baut die App, öffnet eine Ansicht und speichert einen Screenshot.
# Beispiel: .\scripts\shot.ps1 -View auto/replay/3/38 -Out $env:TEMP\shot.png [-Demo demos\x.dem]
param([string]$View = 'auto/replay/1/10', [string]$Out = "$env:TEMP\csda.png", [string]$Demo = '', [int]$Wait = 5000, [int]$Scroll = 0)
$env:CSDA_SCROLL = if ($Scroll) { $Scroll } else { '' }
$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location (Split-Path $PSScriptRoot)
npx electron-vite build 2>&1 | Select-String -Pattern 'error' | Write-Output
$env:CSDA_SHOT = $Out; $env:CSDA_VIEW = $View; $env:CSDA_WAIT = $Wait
$env:CSDA_DEMO = if ($Demo) { (Resolve-Path $Demo).Path } else { '' }
$p = Start-Process -FilePath 'node_modules\electron\dist\electron.exe' -ArgumentList '.' -PassThru -Wait -RedirectStandardError "$env:TEMP\csda_err.txt"
Get-Content "$env:TEMP\csda_err.txt" -Tail 15
"exit $($p.ExitCode) -> $Out"
