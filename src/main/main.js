'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const win = require('./winsys');
const { parseChkdsk, parseChkdskProgress, parseChkdskStage } = require('../engine/parsers');
const { diagnose, recommendations, LIMITATIONS } = require('../engine/diagnostic');
const { buildReportHtml } = require('./report');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const ICON = path.join(__dirname, '..', '..', 'build', 'icon.ico');
const LOGO = path.join(ASSETS, 'logo.png');

let mainWin = null, splash = null;
let currentJob = null, cancelFlag = false;
const results = new Map(); // diskNumber -> resultado del último examen

const send = (ch, payload) => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(ch, payload); };

function createSplash() {
  splash = new BrowserWindow({ width: 460, height: 300, frame: false, resizable: false, center: true, alwaysOnTop: true, show: false, icon: ICON, backgroundColor: '#0f1420', webPreferences: { contextIsolation: true } });
  splash.loadFile(path.join(__dirname, '..', 'renderer', 'splash.html'));
  splash.once('ready-to-show', () => splash.show());
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1180, height: 780, minWidth: 900, minHeight: 600, show: false, icon: ICON, backgroundColor: '#0f1420', title: 'NoDiscNoLive',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  mainWin.setMenuBarVisibility(false);
  mainWin.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  const started = Date.now();
  mainWin.once('ready-to-show', () => {
    setTimeout(() => { if (splash && !splash.isDestroyed()) splash.close(); mainWin.show(); }, Math.max(0, 2200 - (Date.now() - started)));
  });
  mainWin.on('closed', () => { if (currentJob) currentJob.cancel(); mainWin = null; });
}

app.disableHardwareAcceleration(); // evita el destello/glitch gráfico (caídas del proceso GPU)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.whenReady().then(() => { createSplash(); createMain(); if (process.env.NDNL_SELFTEST) selfTest(); });
  app.on('window-all-closed', () => app.quit());
}

// ------------------------------------------------------------------ IPC básicos
ipcMain.handle('app:info', async () => ({ admin: await win.isAdmin(), version: app.getVersion(), host: os.hostname() }));
ipcMain.handle('disks:list', async () => {
  try { return { ok: true, disks: await win.listDisks() }; } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('app:relaunch-admin', async () => {
  try { await win.relaunchAsAdmin(app); setTimeout(() => app.quit(), 500); return { ok: true }; }
  catch (e) { return { ok: false, error: 'No se concedió el permiso de administrador: ' + e.message }; }
});

// ------------------------------------------------------------------ examen
function mergeChk(list) {
  const ran = list.filter(x => x.ran);
  if (!ran.length) return { ran: false, completed: false, errorsFound: false, indexErrors: 0, badSectorsKB: 0, keyLines: [], note: (list[0] && list[0].note) || 'no se ejecutó', perVolume: list };
  return {
    ran: true, cancelled: ran.some(x => x.cancelled), completed: ran.every(x => x.completed), errorsFound: ran.some(x => x.errorsFound),
    indexErrors: ran.reduce((a, x) => a + x.indexErrors, 0), badSectorsKB: ran.reduce((a, x) => a + x.badSectorsKB, 0),
    keyLines: ran.flatMap(x => x.keyLines.map(l => `[${x.letter}:] ${l}`)).slice(0, 40), perVolume: list,
  };
}

ipcMain.handle('exam:start', async (_e, { diskNumber, steps, days = 60 }) => {
  if (currentJob) return { ok: false, error: 'Ya hay un examen en curso.' };
  cancelFlag = false;
  const warnings = [];
  const step = (name, state, extra = {}) => send('exam:progress', { step: name, state, ...extra });
  try {
    const disks = await win.listDisks();
    const disk = disks.find(d => d.number === diskNumber);
    if (!disk) return { ok: false, error: 'El disco ya no está disponible.' };
    const admin = await win.isAdmin();
    if (!admin && (steps.smart || steps.chkdsk)) warnings.push('La aplicación no se ejecuta como administrador: se pedirá elevación (UAC) para SMART y chkdsk. Si se rechaza, esos pasos se omiten.');

    let smart = null, events = [], counts = null, chk = [];
    // ---- SMART
    if (steps.smart && !cancelFlag) {
      step('smart', 'running', { text: 'Leyendo SMART…' });
      smart = await win.readSmart(diskNumber);
      if (!smart.available) warnings.push('SMART: ' + (smart.error || 'no disponible') + (smart.needsAdmin ? ' (falta permiso de administrador)' : ''));
      step('smart', 'done', { text: smart.available ? 'SMART leído' : 'SMART no disponible' });
    }
    // ---- Eventos
    if (steps.events && !cancelFlag) {
      step('events', 'running', { text: `Leyendo eventos del sistema (${days} días)…` });
      const all = await win.readEvents(days);
      events = win.eventsForDisk(all, disk);
      const unattributed = all.length - events.length;
      counts = win.summarizeEvents(events);
      if (unattributed > 0) warnings.push(`${unattributed} evento(s) del log no se pudieron vincular a este disco y no se contaron.`);
      step('events', 'done', { text: `${events.length} evento(s) vinculados` });
    }
    // ---- chkdsk (solo lectura)
    if (steps.chkdsk) {
      const vols = disk.volumes.filter(v => v.letter);
      if (!vols.length) chk.push({ ran: false, note: 'el disco no tiene volúmenes con letra' });
      for (let i = 0; i < vols.length && !cancelFlag; i++) {
        const v = vols[i];
        step('chkdsk', 'running', { text: `chkdsk ${v.letter}: (solo lectura)…`, pct: Math.round(100 * i / vols.length), indeterminate: true });
        let acc = '';
        const job = win.runPrivileged(`chkdsk ${v.letter}:`, {
          tag: 'chk',
          onChunk: ch => {
            acc += ch;
            const p = parseChkdskProgress(ch), st = parseChkdskStage(ch);
            const lastLine = ch.split(/\r|\n/).map(s => s.trim()).filter(Boolean).pop();
            step('chkdsk', 'running', {
              text: `chkdsk ${v.letter}: ${st ? `etapa ${st.stage}/${st.of}` : ''}${p != null ? ` · ${p} %` : ''}`,
              pct: p != null ? Math.round(100 * (i + p / 100) / vols.length) : undefined, indeterminate: p == null, line: lastLine,
            });
          },
        });
        currentJob = job;
        const r = await job.promise;
        currentJob = null;
        if (r.denied) { chk.push({ ran: false, note: 'permiso de administrador denegado (UAC)' }); warnings.push('chkdsk omitido: falta el permiso de administrador.'); break; }
        const parsed = parseChkdsk(r.output);
        if (parsed.accessDenied) { chk.push({ ran: false, note: 'acceso denegado por falta de privilegios' }); warnings.push('chkdsk: acceso denegado (ejecute como administrador).'); break; }
        chk.push({ ran: true, letter: v.letter, cancelled: r.cancelled, ...parsed, rawTail: r.output.split(/\r?\n|\r/).slice(-30).join('\n') });
      }
      step('chkdsk', 'done', { text: cancelFlag ? 'chkdsk cancelado' : 'chkdsk finalizado', pct: 100 });
    }
    if (cancelFlag) { step('all', 'cancelled', { text: 'Examen cancelado' }); }

    const chkM = steps.chkdsk ? mergeChk(chk) : { ran: false, note: 'no solicitado', keyLines: [] };
    const dirtyVals = disk.volumes.map(v => v.dirty);
    const dirty = dirtyVals.includes(true) ? true : dirtyVals.length && dirtyVals.every(x => x === false) ? false : null;
    if (dirtyVals.includes('noperm')) warnings.push('Bit de suciedad: fsutil requiere administrador para algunos volúmenes.');
    const diagnosis = diagnose({ disk: { bus: disk.bus, health: disk.health }, smart, chkdsk: chkM.ran ? chkM : null, dirty, events: counts || {} });
    const recs = recommendations(diagnosis, { isUSB: /usb/i.test(disk.bus), dirty: dirty === true, badSectors: chkM.badSectorsKB > 0 });
    const result = {
      disk, smart, chkdsk: chkM, events, counts: counts || {}, days, dirty, diagnosis, recommendations: recs, limitations: LIMITATIONS, warnings,
      generatedAt: new Date().toISOString(), generatedAtText: new Date().toLocaleString('es-AR'), host: os.hostname(), appVersion: app.getVersion(), cancelled: cancelFlag,
    };
    results.set(diskNumber, result);
    step('all', 'done', { text: 'Examen finalizado' });
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { currentJob = null; }
});

ipcMain.handle('smart:read', async (_e, n) => { try { return await win.readSmart(Number(n)); } catch (e) { return { available: false, error: e.message }; } });
ipcMain.handle('exam:cancel', () => { cancelFlag = true; if (currentJob) currentJob.cancel(); return true; });

// ------------------------------------------------------------------ informe PDF
ipcMain.handle('report:save', async (_e, { diskNumber }) => {
  const r = results.get(diskNumber);
  if (!r) return { ok: false, error: 'Primero examine el disco.' };
  const stamp = new Date().toISOString().slice(0, 10);
  const sel = await dialog.showSaveDialog(mainWin, { title: 'Guardar informe PDF', defaultPath: path.join(app.getPath('documents'), `NoDiscNoLive_Disco${diskNumber}_${stamp}.pdf`), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
  if (sel.canceled || !sel.filePath) return { ok: false, canceled: true };
  let logo = '';
  try { logo = 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64'); } catch { /* sin logo */ }
  const tmp = path.join(os.tmpdir(), `ndnl-report-${Date.now()}.html`);
  fs.writeFileSync(tmp, buildReportHtml(r, logo), 'utf8');
  const w = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await w.loadFile(tmp);
    const pdf = await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } });
    fs.writeFileSync(sel.filePath, pdf);
    shell.showItemInFolder(sel.filePath);
    return { ok: true, path: sel.filePath };
  } catch (e) { return { ok: false, error: e.message }; }
  finally { w.destroy(); try { fs.unlinkSync(tmp); } catch { } }
});

// ------------------------------------------------------------------ reparación (opcional, con confirmación explícita)
ipcMain.handle('repair:start', async (_e, { diskNumber, letter, mode, confirmText, dataBackedUp }) => {
  if (currentJob) return { ok: false, error: 'Hay otra operación en curso.' };
  letter = String(letter || '').toUpperCase();
  if (!/^[A-Z]$/.test(letter) || !['f', 'r'].includes(mode)) return { ok: false, error: 'Parámetros inválidos.' };
  if (dataBackedUp !== true) return { ok: false, error: 'Debe confirmar que ya copió sus datos.' };
  if (confirmText !== `REPARAR ${letter}:`) return { ok: false, error: 'El texto de confirmación no coincide.' };
  const disks = await win.listDisks();
  const disk = disks.find(d => d.number === diskNumber);
  const vol = disk && disk.volumes.find(v => v.letter.toUpperCase() === letter);
  if (!vol) return { ok: false, error: 'El volumen no pertenece a ese disco.' };
  if (disk.isSystem || disk.isBoot || letter === (process.env.SystemDrive || 'C:')[0].toUpperCase())
    return { ok: false, error: 'No se repara el disco del sistema desde la aplicación (requiere reinicio/entorno de recuperación).' };
  // Segunda confirmación nativa: nunca se repara sin ella
  const c = await dialog.showMessageBox(mainWin, {
    type: 'warning', title: 'Confirmar reparación', buttons: ['Cancelar', `Sí, ejecutar chkdsk /${mode}`], defaultId: 0, cancelId: 0, noLink: true,
    message: `Se ejecutará chkdsk ${letter}: /${mode}`,
    detail: 'Esta operación MODIFICA el disco y puede tardar horas (/r). Si el disco está fallando puede empeorar la pérdida de datos. Confirme que YA copió sus datos a otro disco.',
  });
  if (c.response !== 1) return { ok: false, canceled: true };
  const stepR = (p) => send('repair:progress', p);
  let acc = '';
  const cmd = `(echo S& echo Y& echo S& echo Y)|chkdsk ${letter}: /${mode}`;
  const job = win.runPrivileged(cmd, {
    tag: 'fix',
    onChunk: ch => { acc += ch; const p = parseChkdskProgress(ch), st = parseChkdskStage(ch); stepR({ text: `chkdsk /${mode} ${letter}:${st ? ` · etapa ${st.stage}/${st.of}` : ''}${p != null ? ` · ${p} %` : ''}`, pct: p, line: ch.split(/\r|\n/).map(s => s.trim()).filter(Boolean).pop() }); },
  });
  currentJob = job;
  try {
    const r = await job.promise;
    if (r.denied) return { ok: false, error: 'Permiso de administrador denegado (UAC). No se modificó nada.' };
    return { ok: true, cancelled: r.cancelled, exitCode: r.exitCode, output: r.output.split(/\r?\n|\r/).slice(-60).join('\n') };
  } finally { currentJob = null; }
});
ipcMain.handle('repair:cancel', () => { if (currentJob) currentJob.cancel(); return true; });

// Autoprueba para CI/humo: NDNL_SELFTEST=<carpeta de salida> electron .
async function selfTest() {
  const out = process.env.NDNL_SELFTEST;
  const log = [];
  mainWin.webContents.on('console-message', (_e, level, msg) => log.push(`[renderer:${level}] ${msg}`));
  try {
    await new Promise(r => mainWin.webContents.once('did-finish-load', r));
    await new Promise(r => setTimeout(r, 9000));
    const n = await mainWin.webContents.executeJavaScript("document.querySelectorAll('.dcard').length");
    log.push('tarjetas de disco en la UI: ' + n);
    const disks = await win.listDisks();
    const target = disks.find(d => /usb/i.test(d.bus)) || disks[0];
    const noop = { sender: null };
    const handler = ipcMain._invokeHandlers && ipcMain._invokeHandlers.get('exam:start');
    const r = handler ? await handler(noop, { diskNumber: target.number, steps: { smart: false, events: true, chkdsk: false } }) : null;
    log.push('examen: ' + (r && r.ok ? 'ok' : JSON.stringify(r)));
    if (r && r.ok) {
      const html = buildReportHtml(r.result, 'data:image/png;base64,' + fs.readFileSync(LOGO).toString('base64'));
      const f = path.join(out, 'informe.html'); fs.writeFileSync(f, html, 'utf8');
      const w = new BrowserWindow({ show: false }); await w.loadFile(f);
      fs.writeFileSync(path.join(out, 'informe.pdf'), await w.webContents.printToPDF({ pageSize: 'A4', printBackground: true }));
      log.push('PDF generado');
    }
    const shot = await mainWin.webContents.capturePage(); fs.writeFileSync(path.join(out, 'ui.png'), shot.toPNG());
  } catch (e) { log.push('ERROR ' + e.stack); }
  fs.writeFileSync(path.join(out, 'selftest.log'), log.join('\n'));
  app.exit(0);
}
