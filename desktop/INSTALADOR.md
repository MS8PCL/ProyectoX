# Instalador Windows con selección de datos locales o UNC

## Uso

Ejecutar `ProyectoX.Installer.exe` sin elevación, con la identidad Windows que utilizará la aplicación.

1. Escribir o seleccionar mediante **Explorar** una **carpeta existente de datos**, local (`G:\Prueba X`) o UNC (`\\servidor\recurso\carpeta`). Son ejemplos, no destinos autorizados. Se rechazan rutas relativas y de dispositivo. Para el uso compartido definitivo, preferir UNC a letras de unidades mapeadas, que dependen de la sesión Windows.
2. Elegir una carpeta **local nueva o vacía** para instalar, independiente de la carpeta de datos: no pueden coincidir ni estar una dentro de la otra. Por defecto: `%LOCALAPPDATA%\Programs\ProyectoX`. El padre debe existir; el instalador puede crear el padre `Programs` de la ubicación predeterminada.
3. Elegir **Solo lectura** (activado por defecto) o desactivarlo para permitir las operaciones de escritura de la aplicación.
4. Seleccionar el rol operativo: `rrhh`, `it` o `admin`. No concede permisos Windows; las ACL del recurso son la frontera de seguridad.
5. Pulsar **Instalar**. Al terminar, usar **Abrir Proyecto X** o el acceso del menú Inicio si se ha podido crear.

El instalador genera `config.json` junto al ejecutable mediante serialización JSON, con la ruta local o UNC, solo lectura y rol elegidos. El campo sigue llamándose `networkRoot` por compatibilidad con el host. No es necesario editar el archivo a mano. No crea carpetas ni archivos en el destino de datos, no inicializa el almacén y no hace una prueba de escritura. La carpeta de datos debe existir antes de instalar. Si no existe o no está accesible, rechaza la instalación: **no crea ni selecciona un destino alternativo**. Usar una ruta local es una elección explícita, no un fallback. También rechaza, igual que la aplicación al arrancar, una carpeta de datos que sea o esté dentro de un enlace, junction o carpeta sincronizada (por ejemplo OneDrive): la aplicación no abriría esos datos. Una consulta SMB puede tardar si la red no responde; la interfaz permanece activa, pero se debe esperar a que termine antes de cerrar.

La instalación se prepara en una carpeta temporal local y se publica al final. Un destino ocupado se rechaza, conservando configuración, ejecutables y datos anteriores. No cambia ACL ni almacena credenciales de red. Usa el acceso SMB de la sesión Windows actual.

## Distribución y requisitos

- Windows x64 compatible con .NET 8/WPF.
- **.NET 8 incluido** en el instalador y en la aplicación instalada; no necesita instalarse aparte.
- **Microsoft Edge WebView2 Runtime requerido**. El asistente lo comprueba antes de instalar y muestra instrucciones si falta. No lo descarga automáticamente. Puede obtenerse desde [Microsoft](https://developer.microsoft.com/microsoft-edge/webview2).
- El instalador no está firmado; Windows puede mostrar advertencias de reputación/SmartScreen. No desactivar las políticas de seguridad para distribuirlo.
- Instalación por usuario, sin administrador ni modificaciones del registro del sistema.
- No implementa actualización sobre una instalación existente, reparación o desinstalación registrada. Para probar otra versión, elegir otra carpeta local nueva. La eliminación manual de la carpeta local y de su acceso no elimina datos en el recurso compartido; cerrar antes la aplicación.
- El acceso `Proyecto X.lnk` existente nunca se sobrescribe. Si ya existe, abrir la nueva instalación desde su carpeta.

El ejecutable distribuible es un archivo único:

```text
desktop/artifacts/installer/ProyectoX.Installer.exe
```

Los artefactos, configuración y datos están excluidos de Git. No subir el EXE ni configuraciones al repositorio.

## Compilación

Desde la raíz, con SDK .NET 8 y las dependencias frontend instaladas:

```powershell
npm --prefix frontend ci
powershell -ExecutionPolicy Bypass -File .\desktop\tools\build.ps1 -Installer
```

El comando compila Vue, publica la aplicación self-contained en una carpeta nueva, empaqueta únicamente esa publicación, valida el ZIP con pruebas y publica el asistente WPF como EXE único self-contained. Usa los paquetes existentes de .NET y WebView2, sin herramientas de instalación externas. `-Publish` mantiene la distribución portable anterior; pueden combinarse ambos switches.

No ejecutar la generación del instalador simultáneamente con un proceso que lea `installer-payload.zip`: Windows bloquea la sustitución de archivos abiertos. Si está abierto el EXE anterior, cerrar esa ventana antes de regenerarlo o generar en otra carpeta con `tools/build-installer.ps1 -OutputDirectory ./desktop/artifacts/installer-local`, desde la raíz y con el frontend ya compilado.

## Validación

```powershell
powershell -ExecutionPolicy Bypass -File .\desktop\tools\verify.ps1
powershell -ExecutionPolicy Bypass -File .\desktop\tests\test_installer_window.ps1
dotnet run --project desktop/tests/ProyectoX.Installer.Tests/ProyectoX.Installer.Tests.csproj -c Release -- desktop/artifacts/installer-payload.zip
```

- `verify.ps1` ejecuta las pruebas del motor y compila el asistente, además de todas las pruebas existentes. No lanza GUI.
- La prueba de ventana requiere un escritorio Windows interactivo. Abre el **EXE distribuible real**, verifica campos y solo lectura por defecto, prueba el rechazo de una ruta relativa y de una UNC sintética bajo el dominio reservado `.invalid`, y cierra únicamente su proceso. Comprueba la detección de WebView2, que no se instala nada con la UNC inaccesible y que se admite una ruta local existente hasta validar la separación de carpetas.
- El harness con argumento extrae el ZIP real a una carpeta temporal propia usando una UNC sintética con existencia inyectada y también una carpeta local real sintética: valida configuración, binarios self-contained y que los datos locales quedan intactos. **No certifica conectividad SMB real**.
- Pruebas del motor: UNC, roles, destino vacío/ocupado, conservación de config, ZIP corrupto, traversal, exclusión de datos privados, límites, rollback y carreras al publicar.

Se han pasado `verify.ps1`, las 23 pruebas del motor, las dos pruebas adicionales del ZIP real (25/25) y la prueba de ventana real en Windows. Las pruebas nuevas se ejecutaron antes del cambio y reprodujeron el rechazo de rutas locales; después pasaron. Sigue pendiente instalar contra el recurso SMB autorizado y ejecutar el recorrido completo con dos equipos según `VERIFICACION_WINDOWS.md`.
