# Dev helper: (re)start the app on the connected phone, then collect logcat + a screenshot
# into app\build\debug\ (logcat.txt, screen.png).
param([switch]$NoStart, [int]$Wait = 6, [string]$Tools = "C:\dev\android-tools")
$adb = "$Tools\sdk\platform-tools\adb.exe"
$out = Join-Path $PSScriptRoot "app\build\debug"
New-Item -ItemType Directory -Force $out | Out-Null
if (-not $NoStart) {
    & $adb logcat -c
    & $adb shell am force-stop io.github.desertspider.openthermcam
    & $adb shell am start -n io.github.desertspider.openthermcam/.MainActivity | Out-Null
}
Start-Sleep -Seconds $Wait
& $adb logcat -d -v time chromium:V UvcCamera:V AndroidRuntime:E ActivityManager:W *:S | Out-File -Encoding utf8 "$out\logcat.txt"
& $adb shell screencap -p /sdcard/otc-screen.png
& $adb pull /sdcard/otc-screen.png "$out\screen.png" | Out-Null
& $adb shell rm /sdcard/otc-screen.png
Write-Host "debug output in $out"
