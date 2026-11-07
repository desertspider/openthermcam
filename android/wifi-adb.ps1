# Dev helper: switch the USB-connected phone to adb over Wi-Fi, so the phone's single
# USB-C port is free for the thermal camera while logs can still be read.
param([string]$Tools = "C:\dev\android-tools")
$adb = "$Tools\sdk\platform-tools\adb.exe"
$line = & $adb shell ip -f inet addr show wlan0 | Select-String "inet "
if (-not $line) { Write-Host "Phone is not on Wi-Fi" -ForegroundColor Red; exit 1 }
$ip = ($line.ToString().Trim() -split "\s+")[1].Split("/")[0]
& $adb tcpip 5555 | Out-Null
Start-Sleep -Seconds 3
& $adb connect "${ip}:5555"
& $adb devices -l
Write-Host "Phone IP: $ip  (unplug the USB cable now)" -ForegroundColor Green
