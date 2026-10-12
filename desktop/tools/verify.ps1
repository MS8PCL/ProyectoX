$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location (Join-Path (Split-Path -Parent $root) 'frontend')
try {
    & node --test src/lib/desktop.test.js src/lib/desktopStartup.test.js src/lib/desktopIdempotency.test.js src/lib/desktopMultipart.test.js src/lib/storage.desktop.test.js src/lib/i18n.test.js src/lib/listingKinds.test.js src/lib/candidateName.test.js
    if ($LASTEXITCODE -ne 0) { throw 'Han fallado las pruebas JavaScript.' }
} finally { Pop-Location }
& dotnet run --project (Join-Path $root 'tests\ProyectoX.Storage.Tests\ProyectoX.Storage.Tests.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw 'Han fallado las pruebas de persistencia.' }
& (Join-Path $PSScriptRoot 'build.ps1') -Configuration Release
& (Join-Path $root 'tests\test_windows_build.ps1')
$assembly = Join-Path $root 'src\ProyectoX.Desktop\bin\Release\net8.0-windows\ProyectoX.Desktop.dll'
$dist = Join-Path $root 'frontend-dist'
& dotnet run --project (Join-Path $root 'tests\ProyectoX.Application.Tests\ProyectoX.Application.Tests.csproj') -c Release -- $assembly $dist
if ($LASTEXITCODE -ne 0) { throw 'Han fallado las pruebas de casos de uso o de recursos embebidos.' }
foreach ($test in @('ProyectoX.Legacy.Tests', 'ProyectoX.Documents.Tests', 'ProyectoX.DesktopBridge.Tests')) {
    & dotnet run --project (Join-Path $root "tests\$test\$test.csproj") -c Release
    if ($LASTEXITCODE -ne 0) { throw "Han fallado las pruebas $test." }
}
& python (Join-Path $root 'tests\test_migrate_pocketbase.py')
if ($LASTEXITCODE -ne 0) { throw 'Han fallado las pruebas de migración.' }
& dotnet run --project (Join-Path $root 'tests\ProyectoX.Installer.Tests\ProyectoX.Installer.Tests.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw 'Han fallado las pruebas del instalador.' }
& dotnet build (Join-Path $root 'src\ProyectoX.Installer\ProyectoX.Installer.csproj') -c Release
if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la compilacion del asistente de instalacion.' }
Write-Host 'Pruebas locales y compilación completadas. No se ha abierto la aplicación ni validado una ruta SMB real.'
