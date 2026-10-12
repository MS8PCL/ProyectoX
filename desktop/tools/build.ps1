param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Release',
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$frontend = Join-Path (Split-Path -Parent $root) 'frontend'
$dist = Join-Path $root 'frontend-dist'
$project = Join-Path $root 'src\ProyectoX.Desktop\ProyectoX.Desktop.csproj'
if (-not (Test-Path (Join-Path $frontend 'node_modules\vite\bin\vite.js'))) {
    throw 'Faltan dependencias del frontend. Instale con npm ci desde frontend antes de compilar desktop.'
}
Push-Location $frontend
try {
    & npm.cmd run build -- --mode desktop --outDir $dist --emptyOutDir
    if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la compilación de Vue.' }
} finally { Pop-Location }
& dotnet build $project -c $Configuration
if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la compilación del host Windows.' }
if ($Publish) {
    $output = Join-Path $root 'artifacts\release'
    # No config is copied: the operator must explicitly choose the data root.
    & dotnet publish $project -c $Configuration -r win-x64 --self-contained false -o $output
    if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la publicación.' }
    Write-Host "Publicación framework-dependent: $output"
    Write-Host 'Requiere .NET Desktop Runtime 8 y WebView2 Runtime. Configure config.json junto al EXE antes de abrirlo.'
}
