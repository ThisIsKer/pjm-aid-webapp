# Opens PJM aid: starts the backend (API + built web app on http://localhost:4310) in the background with no
# window if it is not running yet, then opens the browser. Used by the "PJM aid" desktop icon (create-shortcut.ps1).
# Claude Code is not started here: the backend runs it on its own for "Sync now" and the daily auto-sync.
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$port = 4310
$url = "http://localhost:$port"
$logDir = Join-Path $repo 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir ('server-' + (Get-Date -Format 'yyyy-MM-dd') + '.log')
function Write-Log($msg) { Add-Content -Path $log -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  [start] ' + $msg) }
function Show-Message($msg) { (New-Object -ComObject WScript.Shell).Popup($msg, 0, 'PJM aid', 48) | Out-Null }
function Test-Running { [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) }

# already running -> just open the browser
if (Test-Running) { Start-Process $url; exit 0 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Show-Message 'Node.js not found (node is not in PATH).'; exit 1 }

# Claude Code for "Sync now": pass the full path so the backend finds it
if (-not $env:PJM_CLAUDE_BIN) {
  $claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
  if (-not $claude) {
    $guess = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
    if (Test-Path $guess) { $claude = $guess }
  }
  if ($claude) { $env:PJM_CLAUDE_BIN = $claude } else { Write-Log 'claude not found: Sync now will not work' }
}

Set-Location $repo
# first run (or after a fresh clone): build the web app once
if (-not (Test-Path (Join-Path $repo 'frontend\dist\frontend\browser\index.html'))) {
  Write-Log 'web app not built yet: npm run build'
  cmd /c "npm run build >> `"$log`" 2>&1"
}

# keep the last 14 daily logs
Get-ChildItem $logDir -Filter 'server-*.log' | Sort-Object Name -Descending | Select-Object -Skip 14 | Remove-Item -ErrorAction SilentlyContinue

Write-Log "starting backend with $node (claude: $env:PJM_CLAUDE_BIN)"
# its own hidden console: keeps running after this script ends; stop it with stop-pjm.ps1 (or the "stop" icon)
Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -WindowStyle Hidden -WorkingDirectory $repo `
  -ArgumentList '/c', "`"`"$node`" --disable-warning=ExperimentalWarning backend\src\server.ts >> `"$log`" 2>&1`""

# wait until it answers (max 60 s), then open the browser
for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Running) { Start-Process $url; exit 0 }
}
Write-Log 'backend did not start within 60 s'
Show-Message "PJM aid did not start. See the log:`n$log"
exit 1
