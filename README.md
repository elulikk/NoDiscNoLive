# NoDiscNoLive

Aplicación de escritorio para Windows (MAG) que examina discos y volúmenes y genera informes de diagnóstico en PDF, en español.

> **Tecnología: Electron + Node** — permite lanzar PowerShell/chkdsk elevados con UAC, mantener la UI fluida (procesos hijos asíncronos, cancelables), generar el PDF con el propio Chromium (`printToPDF`) sin dependencias extra y empaquetar un instalador con `electron-builder`.

## Funciones

1. **Discos y volúmenes**: modelo, bus (USB/SATA/NVMe), tamaño, espacio libre, salud de Windows y bit de suciedad (`fsutil dirty query`).
2. **Examen por disco**
   - SMART con `Get-StorageReliabilityCounter` (pide administrador y avisa si falta el permiso; muchos adaptadores USB no exponen SMART).
   - `chkdsk` en **solo lectura** con barra de progreso en vivo, sin bloquear la UI y **cancelable**.
   - Eventos del log del sistema de los últimos 60 días: `disk` 153/7/11/51, `Ntfs` 55/98/137 y `volmgr`.
3. **Motor de diagnóstico** (`src/engine/diagnostic.js`): reglas sobre la evidencia que estiman causas probables (cable/puerto/alimentación, cierre sucio, controladora/adaptador, desgaste o sectores dañados, otras) y un riesgo de rotura. Los porcentajes se **etiquetan siempre como estimaciones** y **suman 100 %**.
4. **Informe PDF** con: resumen, datos del disco, evidencia, causas con porcentajes, gráfico de riesgo, recomendaciones y limitaciones.
5. **Reparación opcional** (`chkdsk /f` o `/r`): solo tras advertir que primero hay que copiar los datos, con casilla de respaldo, texto de confirmación (`REPARAR X:`) y un diálogo nativo adicional; con elevación UAC. Nunca repara sin confirmar y no toca el disco del sistema.
6. **Imagen**: splash al iniciar, icono de app, tema oscuro/claro.

## Requisitos

- Windows 10/11, Node.js 20+.

## Uso

```bash
npm install
npm start          # ejecuta la app
npm test           # pruebas del motor con datos simulados
npm run shortcut   # crea el icono de acceso directo en el Escritorio
npm run build      # pruebas + instalador NSIS y portable en dist/
```

Para evitar pedir UAC en cada paso, use el botón **Reiniciar como administrador**. Si no es administrador, cada paso elevado (SMART, chkdsk) pedirá UAC y, si se rechaza, se omite y se avisa en el informe.

## Estructura

```
src/engine/   diagnostic.js (reglas y porcentajes), parsers.js (chkdsk, fsutil, eventos)
src/main/     main.js (IPC, examen, PDF, reparación), winsys.js (PowerShell/UAC), report.js, preload.js
src/renderer/ UI (index.html, app.js, styles.css) y splash.html
test/         pruebas del motor con datos simulados (node:test)
scripts/      build.js
```

## Logo de MAG

El logo se tomó de `C:\MAGSAPP\assets` (`magsapp.png` → `assets/mag-logo.png`; `magsapp.ico` → `build/icon.ico`). Si se dispone del logo corporativo definitivo, reemplace esos dos archivos (el `.ico` debe incluir 256×256) y vuelva a ejecutar `npm run build`.

## Limitaciones

- Los porcentajes son estimaciones heurísticas, no mediciones.
- Algunos puentes USB no transmiten SMART; la falta de datos no implica un disco sano.
- La atribución de eventos del log a un disco se hace por número `HarddiskN` o letra de unidad; algunos eventos pueden no vincularse.
- El `chkdsk` en solo lectura puede no detectar fallos intermitentes.
