$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot '..\src\ProyectoX.Desktop\ProyectoX.Desktop.csproj'
# Compilar WPF real: los proyectos net8.0 enlazados tienen otros imports implicitos.
& dotnet build $project -c Release --no-restore
if ($LASTEXITCODE -ne 0) { throw 'Ha fallado la prueba de compilacion WPF en Windows.' }
Write-Host 'PASS Compilacion WPF en Windows'
