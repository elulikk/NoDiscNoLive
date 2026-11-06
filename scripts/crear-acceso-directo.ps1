# Crea un acceso directo "NoDiscNoLive" en el Escritorio con el icono de MAG.
# Usa la app empaquetada (dist\win-unpacked) si existe; si no, el Electron local (npm start).
$root = Split-Path -Parent $PSScriptRoot
$icon = Join-Path $root 'build\icon.ico'
$packed = Join-Path $root 'dist\win-unpacked\NoDiscNoLive.exe'
$electron = Join-Path $root 'node_modules\electron\dist\electron.exe'
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'NoDiscNoLive.lnk'))
if (Test-Path $packed) { $lnk.TargetPath = $packed; $lnk.WorkingDirectory = Split-Path $packed }
elseif (Test-Path $electron) { $lnk.TargetPath = $electron; $lnk.Arguments = "`"$root`""; $lnk.WorkingDirectory = $root }
else { throw 'No se encontró la app. Ejecute "npm install" o "npm run build" primero.' }
$lnk.IconLocation = $icon
$lnk.Description = 'NoDiscNoLive - Diagnóstico de discos (MAG)'
$lnk.Save()
Write-Output "Acceso directo creado en el Escritorio -> $($lnk.TargetPath)"
