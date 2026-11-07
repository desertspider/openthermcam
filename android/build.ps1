# Build (and optionally install) the debug APK without Android Studio.
# Tools: JAVA_HOME / ANDROID_HOME if set, otherwise C:\dev\android-tools\{jdk-17,sdk,gradle-8.11.1}.
#   .\build.ps1            -> app\build\outputs\apk\debug\app-debug.apk
#   .\build.ps1 -Install   -> also installs it on the phone connected via adb
param([switch]$Install, [string]$Tools = "C:\dev\android-tools")
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not $env:JAVA_HOME) { $env:JAVA_HOME = "$Tools\jdk-17" }
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$Tools\sdk" }
"sdk.dir=" + ($sdk -replace '\\', '\\') | Set-Content -Encoding ascii local.properties
if (-not (Test-Path "gradlew.bat")) {
    & "$Tools\gradle-8.11.1\bin\gradle.bat" wrapper --gradle-version 8.11.1
}
& .\gradlew.bat assembleDebug --console=plain *>&1 | Tee-Object -FilePath build.log
if ($LASTEXITCODE -ne 0) { Write-Host "BUILD FAILED (see build.log)" -ForegroundColor Red; exit 1 }
Write-Host "APK: $PSScriptRoot\app\build\outputs\apk\debug\app-debug.apk" -ForegroundColor Green
if ($Install) {
    & "$sdk\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
}
