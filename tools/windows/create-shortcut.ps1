# Creates the desktop icons "PJM aid" (start + open the browser, no window) and "PJM aid - stop".
#   powershell -ExecutionPolicy Bypass -File tools\windows\create-shortcut.ps1
#   ... -Remove   removes both icons
param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$desktop = [Environment]::GetFolderPath('Desktop')   # follows OneDrive desktop redirection
$icons = @(
  @{ Name = 'PJM aid'; Script = 'start-pjm.ps1'; Text = 'Start PJM aid and open it in the browser' },
  @{ Name = 'PJM aid - stop'; Script = 'stop-pjm.ps1'; Text = 'Stop PJM aid' }
)

# an autostart task from an earlier version is not wanted anymore
if (Get-ScheduledTask -TaskName 'PJM aid' -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName 'PJM aid' -Confirm:$false
  Write-Host "Removed the old 'PJM aid' autostart task."
}

$shell = New-Object -ComObject WScript.Shell
foreach ($i in $icons) {
  $lnk = Join-Path $desktop ($i.Name + '.lnk')
  if ($Remove) { Remove-Item $lnk -ErrorAction SilentlyContinue; continue }
  $s = $shell.CreateShortcut($lnk)
  # conhost --headless: PowerShell runs with no window at all (Windows 10 21H2+ / Windows 11)
  $s.TargetPath = "$env:SystemRoot\System32\conhost.exe"
  $s.Arguments = "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path $PSScriptRoot $i.Script) + "`""
  $s.WorkingDirectory = $repo
  $s.IconLocation = (Join-Path $repo 'frontend\public\favicon.ico') + ',0'
  $s.Description = $i.Text
  $s.WindowStyle = 7
  $s.Save()
  Write-Host "Created $lnk"
}
if ($Remove) { Write-Host 'Icons removed.' }
