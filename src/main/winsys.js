'use strict';
// Acceso a Windows: PowerShell, elevación (UAC), listado de discos, SMART, eventos y ejecución de chkdsk.
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseDirty, summarizeEvents } = require('../engine/parsers');

const PS_PREFIX = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';";

/** Ejecuta un script de PowerShell (sin elevar) enviándolo por stdin. */
function runPS(script, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const file = path.join(os.tmpdir(), 'ndnl-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.ps1');
    fs.writeFileSync(file, '﻿' + PS_PREFIX + script, 'utf8');
    const done = () => { try { fs.unlinkSync(file); } catch { /* ignore */ } };
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); done(); reject(new Error('Tiempo de espera agotado en PowerShell')); }, timeoutMs);
    p.stdout.on('data', d => (out += d.toString('utf8')));
    p.stderr.on('data', d => (err += d.toString('utf8')));
    p.on('error', e => { clearTimeout(timer); done(); reject(e); });
    p.on('close', code => {
      clearTimeout(timer); done();
      if (code !== 0 && !out.trim()) reject(new Error(err.trim() || 'PowerShell terminó con código ' + code));
      else resolve(out.replace(/^﻿/, ''));
    });
  });
}

function parseJson(s, fallback) {
  try { const t = String(s).trim(); return t ? JSON.parse(t) : fallback; } catch { return fallback; }
}

let _isAdmin = null;
async function isAdmin() {
  if (_isAdmin !== null) return _isAdmin;
  try {
    const o = await runPS('([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)');
    _isAdmin = /true/i.test(o);
  } catch { _isAdmin = false; }
  return _isAdmin;
}

// ---------------------------------------------------------------- listado
const LIST_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$pds = @(Get-PhysicalDisk)
$res = @()
foreach($d in @(Get-Disk)){
  $pd = $pds | Where-Object { $_.DeviceId -eq "$($d.Number)" } | Select-Object -First 1
  $vols = @()
  foreach($p in @(Get-Partition -DiskNumber $d.Number)){
    if($p.DriveLetter){
      $v = Get-Volume -DriveLetter $p.DriveLetter
      $raw = (& fsutil dirty query ("{0}:" -f $p.DriveLetter) 2>&1 | Out-String)
      $vols += [pscustomobject]@{ letter="$($p.DriveLetter)"; fs=$v.FileSystem; label=$v.FileSystemLabel; size=[int64]$v.Size; free=[int64]$v.SizeRemaining; health="$($v.HealthStatus)"; dirtyRaw=$raw }
    }
  }
  $res += [pscustomobject]@{
    number=[int]$d.Number; name=$d.FriendlyName; model=$d.Model; bus="$($d.BusType)"; size=[int64]$d.Size;
    health= if($pd){"$($pd.HealthStatus)"}else{"$($d.HealthStatus)"}; operational="$($d.OperationalStatus)";
    media= if($pd){"$($pd.MediaType)"}else{''}; style="$($d.PartitionStyle)"; isSystem=[bool]$d.IsSystem; isBoot=[bool]$d.IsBoot;
    serial=("$($d.SerialNumber)").Trim(); volumes=$vols
  }
}
ConvertTo-Json -InputObject @($res) -Depth 5 -Compress
`;

async function listDisks() {
  const out = await runPS(LIST_SCRIPT);
  let arr = parseJson(out, []);
  if (!Array.isArray(arr)) arr = [arr];
  return arr.map(d => ({
    ...d,
    model: String(d.name || d.model || '').trim(),
    volumes: (Array.isArray(d.volumes) ? d.volumes : d.volumes ? [d.volumes] : []).map(v => ({ ...v, dirty: parseDirty(v.dirtyRaw) })),
  }));
}

// ---------------------------------------------------------------- elevación
/** Relanza la aplicación con permisos de administrador (UAC). */
function relaunchAsAdmin(app) {
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [app.getAppPath()];
  const argList = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',');
  const cmd = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' ${argList ? '-ArgumentList ' + argList : ''} -Verb RunAs`;
  return runPS(cmd).then(() => true);
}

/**
 * Ejecuta una línea de comandos (cmd) con permisos de administrador, volcando la salida a un archivo
 * que se va leyendo (progreso en vivo). Si la app ya es admin no se vuelve a pedir UAC.
 * Devuelve { promise, cancel, getOutput }.
 */
function runPrivileged(commandLine, { onChunk, tag = 'job' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndnl-' + tag + '-'));
  const f = n => path.join(dir, n);
  const outF = f('out.txt'), cancelF = f('cancel.flag'), doneF = f('done.txt'), batF = f('job.cmd'), psF = f('runner.ps1');
  fs.writeFileSync(batF, `@echo off\r\nchcp 65001 >nul\r\n${commandLine}\r\n`);
  fs.writeFileSync(psF, `
$p = Start-Process -FilePath cmd.exe -ArgumentList '/c ""${batF}" > "${outF}" 2>&1"' -WindowStyle Hidden -PassThru
while(-not $p.HasExited){
  if(Test-Path '${cancelF}'){ & taskkill /T /F /PID $p.Id | Out-Null; break }
  Start-Sleep -Milliseconds 400
}
$p.WaitForExit()
Set-Content -Path '${doneF}' -Value $p.ExitCode
`);
  let cancelled = false, finished = false, offset = 0, text = '';
  const readNew = () => {
    try {
      const st = fs.statSync(outF);
      if (st.size > offset) {
        const fd = fs.openSync(outF, 'r');
        const buf = Buffer.alloc(st.size - offset);
        fs.readSync(fd, buf, 0, buf.length, offset); fs.closeSync(fd);
        offset = st.size;
        const chunk = buf.toString('utf8');
        text += chunk;
        if (onChunk) onChunk(chunk);
      }
    } catch { /* aún no existe */ }
  };

  const promise = new Promise(async (resolve) => {
    const admin = await isAdmin();
    const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', psF];
    let launcher;
    if (admin) {
      launcher = spawn('powershell.exe', psArgs, { windowsHide: true });
    } else {
      const arglist = psArgs.map(a => (/\s/.test(a) ? `'"${a}"'` : `'${a}'`)).join(',');
      launcher = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `try { Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList ${arglist} -ErrorAction Stop } catch { Write-Output 'UAC_DENIED'; exit 5 }`], { windowsHide: true });
    }
    let launchOut = '', launchFailed = false;
    launcher.stdout.on('data', d => (launchOut += d));
    launcher.on('close', code => { if (!admin && code !== 0) launchFailed = true; });
    launcher.on('error', () => { launchFailed = true; });
    const iv = setInterval(() => {
      readNew();
      if (launchFailed) { clearInterval(iv); finished = true; cleanup(); resolve({ ok: false, denied: true, cancelled, output: text, exitCode: null }); return; }
      if (fs.existsSync(doneF)) {
        setTimeout(() => {
          readNew(); clearInterval(iv); finished = true;
          let code = null; try { code = parseInt(fs.readFileSync(doneF, 'utf8').trim(), 10); } catch { }
          cleanup(); resolve({ ok: true, denied: false, cancelled, output: text, exitCode: code });
        }, 600);
        clearInterval(iv);
      }
    }, 500);
  });
  function cleanup() { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
  return {
    promise,
    cancel() { if (!finished) { cancelled = true; try { fs.writeFileSync(cancelF, '1'); } catch { } } },
    getOutput: () => text,
  };
}

// ---------------------------------------------------------------- SMART
async function readSmart(diskNumber) {
  const script = `
try {
  $pd = Get-PhysicalDisk | Where-Object { $_.DeviceId -eq "${Number(diskNumber)}" } | Select-Object -First 1
  if(-not $pd){ throw 'Disco no encontrado' }
  $c = $pd | Get-StorageReliabilityCounter
  if(-not $c){ throw 'El controlador no expone contadores de fiabilidad' }
  $c | Select-Object Temperature,TemperatureMax,Wear,ReadErrorsTotal,ReadErrorsUncorrected,ReadErrorsCorrected,WriteErrorsTotal,WriteErrorsUncorrected,PowerOnHours,StartStopCycleCount,LoadUnloadCycleCount | ConvertTo-Json -Compress
} catch { '{"error":"' + ($_.Exception.Message -replace '"',"'") + '"}' }
`;
  const admin = await isAdmin();
  let raw;
  if (admin) raw = await runPS(script);
  else {
    // PowerShell elevado vía runner: se guarda el script en un .ps1 temporal
    const tmp = path.join(os.tmpdir(), 'ndnl-smart-' + Date.now() + '.ps1');
    fs.writeFileSync(tmp, PS_PREFIX + script, 'utf8');
    const job = runPrivileged(`powershell -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`, { tag: 'smart' });
    const r = await job.promise;
    try { fs.unlinkSync(tmp); } catch { }
    if (r.denied) return { available: false, needsAdmin: true, error: 'Falta el permiso de administrador (UAC rechazado): SMART no se pudo leer.' };
    raw = r.output;
  }
  const j = parseJson((raw.match(/\{[\s\S]*\}/) || [''])[0], null);
  if (!j) return { available: false, error: 'No se pudo interpretar la respuesta de SMART.' };
  if (j.error) {
    const denied = /acceso|denied|denegado|permission|privileg/i.test(j.error);
    return { available: false, needsAdmin: denied, error: j.error };
  }
  const nonNull = Object.values(j).some(v => v !== null);
  if (!nonNull) return { available: false, error: 'El adaptador (típico de USB) no transmite datos SMART.' };
  return { available: true, ...j };
}

// ---------------------------------------------------------------- eventos
const EVENT_FILTERS = [
  { ProviderName: 'disk', Id: [153, 7, 11, 51] },
  { ProviderName: 'Ntfs', Id: [55, 98, 137] },
  { ProviderName: 'volmgr' },
];

async function readEvents(days = 60) {
  const parts = EVENT_FILTERS.map(f => {
    const id = f.Id ? `; Id=@(${f.Id.join(',')})` : '';
    return `try { Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='${f.ProviderName}'${id}; StartTime=$start} -ErrorAction Stop } catch {}`;
  });
  const script = `
$start=(Get-Date).AddDays(-${Number(days)})
$ev = @(${parts.join('; ')})
$ev = $ev | Sort-Object TimeCreated -Descending | Select-Object -First 600 | ForEach-Object {
  $m = "$($_.Message)"; if($m.Length -gt 300){ $m = $m.Substring(0,300) }
  [pscustomobject]@{ TimeCreated=$_.TimeCreated.ToString('s'); Id=[int]$_.Id; ProviderName="$($_.ProviderName)"; Message=$m }
}
ConvertTo-Json -InputObject @($ev) -Compress
`;
  const out = await runPS(script, { timeoutMs: 180000 });
  let arr = parseJson(out, []);
  if (!Array.isArray(arr)) arr = [arr];
  return arr;
}

/** Filtra eventos que corresponden a un disco (por número Harddisk N o letras de sus volúmenes). */
function eventsForDisk(events, disk) {
  const letters = (disk.volumes || []).map(v => v.letter.toUpperCase());
  return events.filter(e => {
    const m = String(e.Message || '');
    const hd = m.match(/Harddisk(\d+)/i);
    if (hd) return Number(hd[1]) === disk.number;
    const lm = m.match(/\b([A-Z]):/g);
    if (lm) return lm.some(x => letters.includes(x[0].toUpperCase()));
    return false;
  });
}

module.exports = { runPS, isAdmin, listDisks, relaunchAsAdmin, runPrivileged, readSmart, readEvents, eventsForDisk, summarizeEvents };
