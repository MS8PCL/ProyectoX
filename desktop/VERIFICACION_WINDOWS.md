# Verificación final en Windows

Resultados observados de la PR #1: [RESULTADOS_WINDOWS.md](RESULTADOS_WINDOWS.md). Las casillas pendientes no están aprobadas.

Lo que no se puede comprobar fuera de Windows: compilación WPF, WebView2, diálogos nativos y una carpeta SMB real con varios equipos. Unos 30 minutos.

## 1. Compilación y pruebas

```powershell
npm --prefix frontend ci
powershell -ExecutionPolicy Bypass -File .\desktop\tools\verify.ps1
powershell -ExecutionPolicy Bypass -File .\desktop\tools\build.ps1 -Publish
```

Todo debe terminar sin errores.

## 2. Instalación de prueba

1. Crear una carpeta **nueva y vacía** en el recurso compartido (`\\EQUIPO\RECURSO\ProyectoX-prueba`).
2. Copiar `desktop/artifacts/release` a dos equipos (A y B) con `config.json` apuntando a esa carpeta y `"readOnly": false`.
3. En un tercer equipo, o en B más tarde, usar `"readOnly": true`.

## 3. Recorrido en el equipo A

- [ ] Arranca, muestra la bienvenida y el título de la ventana es «Proyecto X».
- [ ] Perfil: rellenar nombre, título y ubicación → «Perfil guardado».
- [ ] Publicar una oferta → aparece en Buscar.
- [ ] Pipeline → Importar un candidato con CV (PDF) y un certificado → «✓ … importado». Un segundo clic no hace nada.
- [ ] Ficha → CV → Abrir: pide confirmación y abre el PDF en el visor de Windows.
- [ ] Exportar candidatura (ZIP) y Exportar ZIP de la oferta: abre el diálogo Guardar. **Esperar más de 30 s antes de guardar**: no debe aparecer error y el ZIP debe contener `manifest.json` y el CV.
- [ ] Enviar email: pide confirmación y abre el cliente de correo.
- [ ] Notas y mover tarjetas entre etapas.
- [ ] Marcar contratado → Alta IT con departamento y puesto de las listas → aparece en Altas Pendientes con todos los datos → Marcar completado.
- [ ] Alta IT (sin candidatura) desde el menú.
- [ ] Informes → Exportar CSV: abre el diálogo Guardar y el CSV se abre bien en Excel.
- [ ] Auditoría muestra las acciones anteriores.
- [ ] Cambiar tema e idioma.
- [ ] Eliminar una candidatura sin alta → desaparece.

## 4. Dos equipos a la vez (A y B)

- [ ] Con el pipeline abierto en ambos, A mueve la tarjeta X y B escribe una nota en la tarjeta Y → ambos guardan sin error.
- [ ] A y B editan la nota de la **misma** tarjeta casi a la vez → uno guarda y el otro ve «Los datos han cambiado»; tras recargar (15 s o al reintentar) repite y guarda.
- [ ] B cambia el tema mientras A trabaja → sin error.
- [ ] Con un diálogo Guardar abierto en A, B sigue trabajando con normalidad.

## 5. Fallos de red y permisos

- [ ] Desconectar la red de A con la app abierta → al guardar, aviso de almacenamiento no disponible; al reconectar, recargar y los datos están intactos.
- [ ] Equipo en solo lectura: el título dice «Solo lectura» y publicar muestra «…modo de solo lectura».
- [ ] Un usuario sin permiso de escritura en la carpeta (ACL) no puede guardar.
- [ ] No queda `commit.pending` en la carpeta tras cerrar todas las aplicaciones.

Si algo falla, anotar el paso, la hora y el mensaje mostrado.
