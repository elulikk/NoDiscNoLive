# Crea un acceso directo "NoDiscNoLive" en el Escritorio con el icono de MAG.
# Usa la app empaquetada (dist\win-unpacked) si existe; si no, el Electron local (npm start).
$root = Split-Path -Parent $PSScriptRoot
# Se copia el .ico a una ruta con hash propio: Windows cachea iconos por ruta y, si no, seguiría mostrando uno viejo.
$hash = (Get-FileHash (Join-Path $root 'build\icon.ico') -Algorithm MD5).Hash.Substring(0, 8)
$iconDir = Join-Path $env:LOCALAPPDATA 'NoDiscNoLive'
New-Item -ItemType Directory -Force $iconDir | Out-Null
$icon = Join-Path $iconDir "nodisclive-$hash.ico"
Copy-Item (Join-Path $root 'build\icon.ico') $icon -Force
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
Start-Process ie4uinit.exe -ArgumentList '-show' -WindowStyle Hidden -ErrorAction SilentlyContinue  # refresca la caché de iconos
Write-Output "Acceso directo creado en el Escritorio -> $($lnk.TargetPath)"
