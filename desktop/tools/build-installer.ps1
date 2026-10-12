$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root 'artifacts'
$staging = Join-Path $artifacts ('installer-build-' + [Guid]::NewGuid().ToString('N'))
$payload = Join-Path $artifacts 'installer-payload.zip'
$output = Join-Path $artifacts 'installer'
$application = Join-Path $root 'src\ProyectoX.Desktop\ProyectoX.Desktop.csproj'
$installer = Join-Path $root 'src\ProyectoX.Installer\ProyectoX.Installer.csproj'
try {
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    # Publicacion nueva: nunca empaquetar configuracion o datos de una instalacion previa.
    & dotnet publish $application -c Release -r win-x64 --self-contained true -o $staging -p:DebugType=None -p:DebugSymbols=false
    if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la publicacion de la aplicacion para el instalador.' }
    if (Test-Path (Join-Path $staging 'config.json')) { throw 'El paquete contiene configuracion privada.' }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    if (Test-Path $payload) { Remove-Item -LiteralPath $payload }
    [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $payload)
    & dotnet run --project (Join-Path $root 'tests\ProyectoX.Installer.Tests\ProyectoX.Installer.Tests.csproj') -c Release -- $payload
    if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la validacion del paquete real del instalador.' }
    & dotnet publish $installer -c Release -r win-x64 --self-contained true -o $output -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true -p:DebugType=None -p:DebugSymbols=false
    if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la publicacion del instalador.' }
    Write-Host "Instalador generado: $output\ProyectoX.Installer.exe"
    Write-Host 'Incluye .NET 8. Requiere WebView2 Runtime. El usuario elige expresamente una UNC existente.'
} finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
}
