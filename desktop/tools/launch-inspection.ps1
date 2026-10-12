$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$release = Join-Path $root 'artifacts\release'
$executable = Join-Path $release 'ProyectoX.Desktop.exe'
$configPath = Join-Path $release 'config.json'
if (-not (Test-Path $executable) -or -not (Test-Path $configPath)) { throw 'Falta ejecutable o configuración explícita.' }
$config = Get-Content $configPath -Raw | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $config.networkRoot -PathType Container)) { throw 'El destino configurado no está disponible.' }
$previous = $env:PROYECTOX_INSPECT_UI
try {
    # Local diagnostic listener only; inspect-original-ui.mjs closes this diagnostic instance.
    $env:PROYECTOX_INSPECT_UI = '1'
    $process = Start-Process -FilePath $executable -WorkingDirectory $release -PassThru
    Write-Host "Instancia de inspección iniciada: PID $($process.Id). No es el arranque normal."
} finally {
    $env:PROYECTOX_INSPECT_UI = $previous
}
