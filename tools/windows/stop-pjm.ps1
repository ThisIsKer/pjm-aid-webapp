# Stops the PJM aid backend (started by the desktop icon or by hand).
$conn = Get-NetTCPConnection -LocalPort 4310 -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conn) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
$msg = $(if ($conn) { 'PJM aid stopped.' } else { 'PJM aid was not running.' })
Write-Host $msg
# the desktop icon has no window: confirm with a small popup that closes by itself after 3 s
try { (New-Object -ComObject WScript.Shell).Popup($msg, 3, 'PJM aid', 64) | Out-Null } catch { }
