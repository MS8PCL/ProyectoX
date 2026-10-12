param([Parameter(Mandatory=$true)][int]$ProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $ProcessId)
$window = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
if (-not $window) { throw 'No se encontró la ventana del proceso seleccionado.' }
$controls = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
Write-Host "Controles accesibles: $($controls.Count)"
foreach ($control in $controls) {
    $name = $control.Current.Name
    if ($name -match 'No se ha podido|Configuración necesaria|Comprobando configuración|No se pudo conectar') { Write-Host $name }
}
