'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = b => { if (!b || b < 0) return '—'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = b; while (v >= 1024 && i < 4) { v /= 1024; i++; } return v.toFixed(i >= 3 ? 1 : 0) + ' ' + u[i]; };
const COLORS = { cable: '#2f80ed', sucio: '#f2994a', controladora: '#9b51e0', desgaste: '#eb5757', otras: '#8a94a6' };
const RCOL = { bajo: '#27ae60', moderado: '#f2c94c', alto: '#f2994a', critico: '#eb5757' };
const dirtyTxt = d => d === true ? '<span class="bad">Sucio</span>' : d === false ? '<span class="ok">Limpio</span>' : d === 'noperm' ? '<span class="warnc">Requiere admin</span>' : '<span class="muted">?</span>';

const st = { disks: [], sel: null, admin: false, running: false, results: {} };

// ---- tema
(function () {
  let t = null; try { t = localStorage.getItem('ndnl-theme'); } catch { }
  if (!t) t = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = t;
})();
$('#btnTheme').onclick = () => {
  const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = t; try { localStorage.setItem('ndnl-theme', t); } catch { }
};

async function init() {
  const info = await ndnl.info();
  st.admin = info.admin;
  const b = $('#adminBadge');
  b.textContent = info.admin ? 'Administrador' : 'Sin permisos de administrador';
  b.className = 'badge ' + (info.admin ? 'admin' : 'user');
  $('#btnAdmin').classList.toggle('hidden', info.admin);
  const bn = $('#banner');
  if (!info.admin) { bn.classList.remove('hidden'); bn.textContent = 'Sin permisos de administrador: SMART, chkdsk y el bit de suciedad requieren elevación. Al examinar se pedirá UAC; si se rechaza esos pasos se omiten. Use "Reiniciar como administrador" para evitar avisos repetidos.'; }
  await refresh();
}
$('#btnAdmin').onclick = async () => { const r = await ndnl.relaunchAdmin(); if (!r.ok) alert(r.error); };
$('#btnRefresh').onclick = () => !st.running && refresh();

async function refresh() {
  $('#diskList').innerHTML = '<div class="muted pad">Cargando discos…</div>';
  const r = await ndnl.listDisks();
  if (!r.ok) { $('#diskList').innerHTML = `<div class="pad bad">Error: ${esc(r.error)}</div>`; return; }
  st.disks = r.disks;
  renderList();
  if (st.sel != null && st.disks.some(d => d.number === st.sel)) renderDetail(); else { st.sel = null; $('#detail').innerHTML = '<div class="empty">Seleccione un disco de la lista.</div>'; }
}

function healthCls(h) { return /healthy/i.test(h) ? 'ok' : /warning/i.test(h) ? 'warnc' : 'bad'; }

function renderList() {
  $('#diskList').innerHTML = st.disks.map(d => {
    const used = d.volumes.reduce((a, v) => a + (v.size - v.free), 0), tot = d.volumes.reduce((a, v) => a + v.size, 0);
    return `<div class="dcard ${st.sel === d.number ? 'sel' : ''}" data-n="${d.number}">
      <h3>Disco ${d.number} · ${esc(d.model)}</h3>
      <div class="tags"><span class="tag ${/usb/i.test(d.bus) ? 'usb' : ''}">${esc(d.bus)}</span><span class="tag">${fmt(d.size)}</span>${d.media && d.media !== 'Unspecified' ? `<span class="tag">${esc(d.media)}</span>` : ''}${d.isSystem ? '<span class="tag">Sistema</span>' : ''}</div>
      <div>Salud Windows: <b class="${healthCls(d.health)}">${esc(d.health)}</b></div>
      <div class="muted">${d.volumes.map(v => v.letter + ':').join(' ') || 'Sin letras'}</div>
      ${tot ? `<div class="mini"><i style="width:${Math.round(100 * used / tot)}%"></i></div>` : ''}</div>`;
  }).join('') || '<div class="muted pad">No se encontraron discos.</div>';
  document.querySelectorAll('.dcard').forEach(el => el.onclick = () => { if (st.running) return; st.sel = +el.dataset.n; renderList(); renderDetail(); });
}

function renderDetail() {
  const d = st.disks.find(x => x.number === st.sel); if (!d) return;
  const res = st.results[d.number];
  $('#detail').innerHTML = `
  <div class="panel"><h2>Disco ${d.number} · ${esc(d.model)}</h2>
    <table><tr><th>Bus</th><td>${esc(d.bus)}</td><th>Tamaño</th><td>${fmt(d.size)}</td><th>Salud</th><td class="${healthCls(d.health)}">${esc(d.health)} / ${esc(d.operational)}</td></tr></table>
    <table style="margin-top:8px"><tr><th>Unidad</th><th>Etiqueta</th><th>FS</th><th>Tamaño</th><th>Libre</th><th>Salud</th><th>Bit de suciedad</th></tr>
    ${d.volumes.map(v => `<tr><td>${esc(v.letter)}:</td><td>${esc(v.label || '—')}</td><td>${esc(v.fs || '—')}</td><td>${fmt(v.size)}</td><td>${fmt(v.free)}</td><td class="${healthCls(v.health)}">${esc(v.health || '—')}</td><td>${dirtyTxt(v.dirty)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin volúmenes con letra</td></tr>'}</table>
  </div>
  <div class="panel"><h2>Examen del disco</h2>
    <div class="steps">
      <label><input type="checkbox" id="sSmart" checked> SMART</label>
      <label><input type="checkbox" id="sEvents" checked> Eventos (60 días)</label>
      <label><input type="checkbox" id="sChk" checked> chkdsk solo lectura <span class="muted">(puede tardar mucho)</span></label>
    </div>
    <div class="actions"><button id="bStart">▶ Examinar</button><button id="bCancel" class="ghost hidden">■ Cancelar</button></div>
    <div id="prog" class="hidden"><div class="pbar" id="pbar"><i id="pfill"></i></div><div id="pstat" class="muted"></div><pre id="plog" class="hidden"></pre></div>
  </div>
  <div id="resBox">${res ? resultHtml(res) : ''}</div>`;
  $('#bStart').onclick = startExam;
  $('#bCancel').onclick = () => ndnl.cancelExam();
  bindResultButtons();
}

let offProg = null;
async function startExam() {
  const d = st.disks.find(x => x.number === st.sel);
  const steps = { smart: $('#sSmart').checked, events: $('#sEvents').checked, chkdsk: $('#sChk').checked };
  if (!steps.smart && !steps.events && !steps.chkdsk) return alert('Seleccione al menos un paso.');
  st.running = true;
  $('#bStart').disabled = true; $('#bCancel').classList.remove('hidden'); $('#prog').classList.remove('hidden'); $('#resBox').innerHTML = '';
  document.querySelectorAll('.dcard').forEach(e => e.style.opacity = e.dataset.n == d.number ? 1 : .5);
  offProg = ndnl.onExamProgress(p => {
    $('#pstat').textContent = p.text || '';
    if (p.step === 'chkdsk') {
      $('#pbar').classList.toggle('ind', !!p.indeterminate && p.pct == null);
      if (p.pct != null) $('#pfill').style.width = p.pct + '%';
      if (p.line) { const l = $('#plog'); l.classList.remove('hidden'); l.textContent += p.line + '\n'; l.scrollTop = l.scrollHeight; }
    } else { $('#pbar').classList.add('ind'); }
  });
  const r = await ndnl.startExam({ diskNumber: d.number, steps });
  offProg && offProg();
  st.running = false;
  document.querySelectorAll('.dcard').forEach(e => e.style.opacity = 1);
  if (!r.ok) { $('#bStart').disabled = false; $('#bCancel').classList.add('hidden'); $('#pstat').innerHTML = `<span class="bad">Error: ${esc(r.error)}</span>`; return; }
  st.results[d.number] = r.result;
  await refresh(); // actualiza bit de suciedad / estado
  renderDetail();
}

function resultHtml(r) {
  const dg = r.diagnosis, c = r.counts || {};
  const pos = dg.risk.score;
  const evs = [['disk 153', c.disk153], ['disk 7', c.disk7], ['disk 11', c.disk11], ['disk 51', c.disk51], ['Ntfs 55', c.ntfs55], ['Ntfs 98', c.ntfs98], ['Ntfs 137', c.ntfs137], ['volmgr', c.volmgr]];
  const s = r.smart;
  return `
  ${r.warnings.length ? `<div class="panel"><h2>Avisos</h2><ul class="warns">${r.warnings.map(w => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
  <div class="panel"><h2>Diagnóstico <span class="tag" style="color:${RCOL[dg.risk.level]}">${esc(dg.risk.label)} · ${dg.risk.score}/100</span></h2>
    <div class="disc">${esc(dg.disclaimer)}</div>
    ${dg.causes.map(z => `<div class="cause"><div class="l"><span>${esc(z.label)}</span><b>${z.pct} % <i>(estimado)</i></b></div><div class="bar"><div style="width:${z.pct}%;background:${COLORS[z.id]}"></div></div>${z.reasons.length ? '<ul>' + z.reasons.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}</div>`).join('')}
    <h2 style="margin-top:14px">Riesgo de rotura</h2>
    <div class="risk">${['bajo', 'moderado', 'alto', 'critico'].map(k => `<span style="background:${RCOL[k]}"></span>`).join('')}<div class="pin" style="left:${pos}%;color:${RCOL[dg.risk.level]}">${pos}</div></div>
    <div class="muted" style="font-size:12px;margin-top:4px">Bajo · Moderado · Alto · Crítico — indicador orientativo, no una predicción.</div>
  </div>
  <div class="panel"><h2>Evidencia</h2>
    <table><tr>${evs.map(([k]) => `<th>${k}</th>`).join('')}</tr><tr>${evs.map(([, n]) => `<td class="${n ? 'bad' : ''}"><b>${n || 0}</b></td>`).join('')}</tr></table>
    <p class="muted" style="margin:8px 0 2px">SMART: ${s ? (s.available ? `Temp ${s.Temperature ?? '—'} °C · Desgaste ${s.Wear ?? '—'} % · Err. lectura sin corregir ${s.ReadErrorsUncorrected ?? '—'} · Horas ${s.PowerOnHours ?? '—'}` : esc(s.error || 'no disponible')) : 'no examinado'}</p>
    <p class="muted" style="margin:2px 0">chkdsk: ${r.chkdsk.ran ? `${r.chkdsk.completed ? 'completado' : 'incompleto'}${r.chkdsk.cancelled ? ' (cancelado)' : ''} · errores: ${r.chkdsk.errorsFound ? 'sí' : 'no'} · índice $I30: ${r.chkdsk.indexErrors} · sectores defectuosos: ${r.chkdsk.badSectorsKB} KB` : 'no ejecutado' + (r.chkdsk.note ? ' (' + esc(r.chkdsk.note) + ')' : '')}</p>
  </div>
  <div class="panel"><h2>Recomendaciones</h2><ol>${r.recommendations.map(x => `<li>${esc(x)}</li>`).join('')}</ol>
    <div class="actions"><button id="bPdf">📄 Generar informe PDF</button><button id="bRepair" class="danger">🛠 Reparar (chkdsk /f /r)…</button></div></div>`;
}

function bindResultButtons() {
  const pdf = $('#bPdf'); if (pdf) pdf.onclick = async () => { pdf.disabled = true; const r = await ndnl.saveReport(st.sel); pdf.disabled = false; if (!r.ok && !r.canceled) alert(r.error); };
  const rep = $('#bRepair'); if (rep) rep.onclick = openRepair;
}

// ---- reparación
function openRepair() {
  const d = st.disks.find(x => x.number === st.sel);
  const vols = d.volumes;
  if (!vols.length) return alert('El disco no tiene volúmenes con letra.');
  const sel = $('#mVol');
  sel.innerHTML = vols.map(v => `<option>${esc(v.letter)}:</option>`).join('');
  const L = () => sel.value.replace(':', '');
  const upd = () => { $('#mExpect').textContent = `REPARAR ${L()}:`; check(); };
  sel.onchange = upd;
  $('#mText').value = ''; $('#mBackup').checked = false; $('#mCancel').textContent = 'Cancelar'; $('#mProgress').classList.add('hidden'); $('#mLog').textContent = '';
  $('#modal').classList.remove('hidden');
  const check = () => { $('#mGo').disabled = !($('#mBackup').checked && $('#mText').value === `REPARAR ${L()}:`); };
  $('#mBackup').onchange = check; $('#mText').oninput = check; upd();
  let running = false, off = null;
  $('#mCancel').onclick = async () => { if (running) await ndnl.cancelRepair(); else $('#modal').classList.add('hidden'); };
  $('#mGo').onclick = async () => {
    const mode = document.querySelector('input[name=mode]:checked').value;
    running = true; $('#mGo').disabled = true; $('#mProgress').classList.remove('hidden'); $('#mStatus').textContent = 'Esperando confirmación y permisos…';
    off = ndnl.onRepairProgress(p => { $('#mStatus').textContent = p.text; if (p.pct != null) $('#mFill').style.width = p.pct + '%'; if (p.line) { $('#mLog').textContent += p.line + '\n'; $('#mLog').scrollTop = 1e9; } });
    const r = await ndnl.repair({ diskNumber: d.number, letter: L(), mode, confirmText: $('#mText').value, dataBackedUp: $('#mBackup').checked });
    off && off(); running = false;
    if (r.canceled) { $('#mStatus').textContent = 'Reparación cancelada: no se modificó nada.'; return; }
    if (!r.ok) { $('#mStatus').innerHTML = `<span class="bad">${esc(r.error)}</span>`; return; }
    $('#mStatus').textContent = r.cancelled ? 'Reparación interrumpida por el usuario.' : `Reparación finalizada (código ${r.exitCode}). Vuelva a examinar el disco.`;
    $('#mLog').textContent = r.output; $('#mCancel').textContent = 'Cerrar';
    await refresh();
  };
}

init();
