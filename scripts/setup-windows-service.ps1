# Requires: Run in an Administrator PowerShell window

# --- CONFIG: Update only if your paths differ ---
$RepoDir    = "C:\Users\dana_\Documents\GitHub\DDHQ-Discord"
$NodeExe    = "C:\Program Files\nodejs\node.exe"
$ServiceName = "DaSurvey"
$StdOut     = Join-Path $RepoDir "bot.out.log"
$StdErr     = Join-Path $RepoDir "bot.err.log"
$BotScript  = Join-Path $RepoDir "src\bot.js"

Write-Host "[Setup] Starting Windows Service setup for $ServiceName" -ForegroundColor Cyan

# --- Preflight checks ---
if (-not (Test-Path $NodeExe)) { Write-Error "Node not found at $NodeExe"; exit 1 }
if (-not (Test-Path $BotScript)) { Write-Error "Bot script missing at $BotScript"; exit 1 }
if (-not (Test-Path (Join-Path $RepoDir ".env"))) { Write-Warning ".env missing in $RepoDir. Bot will not auth without env vars." }

# --- Download NSSM (no Chocolatey required) ---
$Temp = Join-Path $env:TEMP "nssm-setup"
New-Item -ItemType Directory -Force -Path $Temp | Out-Null
$Zip = Join-Path $Temp "nssm.zip"
$NssmUrl = "https://nssm.cc/release/nssm-2.24.zip"
Write-Host "[Setup] Downloading NSSM from $NssmUrl" -ForegroundColor Yellow
Invoke-WebRequest -Uri $NssmUrl -OutFile $Zip
Expand-Archive -Force -Path $Zip -DestinationPath $Temp

# Pick 64-bit nssm.exe if present
$NssmExe = Get-ChildItem -Recurse -Path $Temp -Filter "nssm.exe" | Where-Object { $_.FullName -match "win64" } | Select-Object -First 1
if (-not $NssmExe) { $NssmExe = Get-ChildItem -Recurse -Path $Temp -Filter "nssm.exe" | Select-Object -First 1 }
if (-not $NssmExe) { Write-Error "nssm.exe not found in extracted archive"; exit 1 }
$Nssm = $NssmExe.FullName
Write-Host "[Setup] Using NSSM at $Nssm" -ForegroundColor Green

# --- Create/Update Windows Service ---
Write-Host "[Service] Removing existing service if any..." -ForegroundColor Yellow
& $Nssm stop $ServiceName 2>$null | Out-Null
& $Nssm remove $ServiceName confirm 2>$null | Out-Null

Write-Host "[Service] Installing $ServiceName" -ForegroundColor Yellow
& $Nssm install $ServiceName $NodeExe $BotScript
& $Nssm set $ServiceName AppDirectory $RepoDir
& $Nssm set $ServiceName AppStdout $StdOut
& $Nssm set $ServiceName AppStderr $StdErr
& $Nssm set $ServiceName Start SERVICE_AUTO_START

Write-Host "[Service] Starting $ServiceName" -ForegroundColor Yellow
& $Nssm start $ServiceName

# --- Power settings: disable sleep/hibernate; lid Do Nothing (AC/DC) ---
Write-Host "[Power] Disabling hibernate and sleep; lid action Do nothing" -ForegroundColor Yellow
powercfg /HIBERNATE OFF
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 0
powercfg /SETACVALUEINDEX SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /SETDCVALUEINDEX SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /SETACTIVE SCHEME_CURRENT

# --- Summary ---
Write-Host "[Done] Service created and power settings applied." -ForegroundColor Green
Write-Host "Check service state:" -NoNewline; Write-Host "  sc query $ServiceName" -ForegroundColor Cyan
Write-Host "Test in Discord: /health and /ping" -ForegroundColor Cyan
