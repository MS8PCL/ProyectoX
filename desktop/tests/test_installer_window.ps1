param([string]$Executable = (Join-Path $PSScriptRoot '..\artifacts\installer\ProyectoX.Installer.exe'))
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$process = Start-Process -FilePath (Resolve-Path $Executable) -PassThru
function Find-Control($window, $id) {
    $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id)
    $element = $window.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
    if ($null -eq $element) { throw "No se encuentra el control: $id" }
    return $element
}
try {
    $window = $null
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ($null -eq $window -and [DateTime]::UtcNow -lt $deadline) {
        $process.Refresh()
        if ($process.HasExited) { throw 'El instalador se ha cerrado antes de mostrar la ventana.' }
        if ($process.MainWindowHandle -ne [IntPtr]::Zero) {
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
        }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $window) { throw 'No aparece la ventana del instalador; requiere escritorio interactivo.' }
    $network = Find-Control $window 'NetworkRoot'
    $destination = Find-Control $window 'InstallDirectory'
    $button = Find-Control $window 'Install'
    $readonly = Find-Control $window 'ReadOnly'
    Find-Control $window 'OperationalRole' | Out-Null
    Find-Control $window 'BrowseNetwork' | Out-Null
    Find-Control $window 'BrowseLocal' | Out-Null
    $toggle = $readonly.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)
    if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::On) { throw 'Solo lectura no viene seleccionado.' }
    $value = $destination.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($value.Current.Value -notmatch '^[A-Za-z]:\\') { throw 'El destino por defecto no es absoluto.' }
    # Las rutas relativas siguen siendo invalidas; una ruta local absoluta ahora es valida.
    $network.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('datos-relativos-sinteticos')
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 500
    $status = Find-Control $window 'Status'
    if ($status.Current.Name -notlike '*ruta absoluta*') { throw 'No se muestra el rechazo de la ruta relativa.' }
    if (-not $button.Current.IsEnabled) { throw 'El rechazo deja bloqueado el asistente.' }
    Write-Host 'PASS Ventana real del instalador, campos, solo lectura y rechazo de ruta relativa.'
    # Dominio reservado .invalid: no contiene datos reales ni puede ser un recurso autorizado.
    $syntheticDestination = Join-Path ([System.IO.Path]::GetTempPath()) ('proyectox-ui-' + [Guid]::NewGuid().ToString('N'))
    $value.SetValue($syntheticDestination)
    $network.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue('\\proyectox-test.invalid\synthetic')
    $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
    Start-Sleep -Milliseconds 250
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while (-not $button.Current.IsEnabled -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
    $status = Find-Control $window 'Status'
    if (-not $button.Current.IsEnabled -or $status.Current.Name -notlike '*carpeta de datos*') { throw 'No se obtiene el rechazo del recurso UNC inaccesible tras comprobar WebView2.' }
    if (Test-Path -LiteralPath $syntheticDestination) { throw 'Se ha creado una instalacion pese al recurso UNC inaccesible.' }
    Write-Host 'PASS WebView2 disponible y UNC inaccesible rechazada sin instalacion ni fallback local.'
    $localData = Join-Path ([System.IO.Path]::GetTempPath()) ('proyectox-ui-local-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $localData | Out-Null
    try {
        $network.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue($localData)
        $value.SetValue($localData)
        $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        Start-Sleep -Milliseconds 250
        $deadline = [DateTime]::UtcNow.AddSeconds(15)
        while (-not $button.Current.IsEnabled -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 250 }
        $status = Find-Control $window 'Status'
        if (-not $button.Current.IsEnabled -or $status.Current.Name -notlike '*independientes*') { throw 'La ruta local no se acepta hasta validar la separacion de datos e instalacion.' }
        if (@(Get-ChildItem -LiteralPath $localData -Force).Count -ne 0) { throw 'El rechazo de carpetas coincidentes ha escrito datos.' }
        Write-Host 'PASS Ruta local existente admitida y carpetas coincidentes rechazadas sin escritura.'
    } finally { Remove-Item -LiteralPath $localData -Recurse -Force }
} finally {
    if (-not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        if (-not $process.WaitForExit(5000)) { $process.Kill() }
    }
    $process.Dispose()
}
