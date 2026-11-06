'use strict';
// Genera el HTML del informe (se convierte a PDF con printToPDF de Electron).
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtBytes(b) {
  if (!b || b < 0) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(i >= 3 ? 1 : 0) + ' ' + u[i];
}

const CAUSE_COLORS = { cable: '#2f80ed', sucio: '#f2994a', controladora: '#9b51e0', desgaste: '#eb5757', otras: '#8a94a6' };
const RISK_COLORS = { bajo: '#27ae60', moderado: '#f2c94c', alto: '#f2994a', critico: '#eb5757' };

function dirtyText(d) { return d === true ? 'Sí (sucio)' : d === false ? 'No' : d === 'noperm' ? 'Sin permiso (requiere administrador)' : 'Desconocido'; }

function riskChartSvg(score, level) {
  const col = RISK_COLORS[level] || '#888';
  const W = 520, x0 = 10, bw = W - 20;
  const seg = [['bajo', 0, 25], ['moderado', 25, 50], ['alto', 50, 75], ['critico', 75, 100]]
    .map(([k, a, b]) => `<rect x="${x0 + bw * a / 100}" y="30" width="${bw * (b - a) / 100}" height="22" fill="${RISK_COLORS[k]}" opacity="0.85"/>`).join('');
  const px = x0 + bw * score / 100;
  return `<svg viewBox="0 0 ${W} 90" width="100%" xmlns="http://www.w3.org/2000/svg" font-family="Segoe UI, Arial" font-size="11">
    ${seg}
    <polygon points="${px - 7},22 ${px + 7},22 ${px},34" fill="#222"/>
    <text x="${px}" y="16" text-anchor="middle" font-size="13" font-weight="700" fill="${col}">${score} / 100</text>
    <text x="${x0}" y="70" fill="#555">Bajo (0–24)</text><text x="${x0 + bw * .25}" y="70" fill="#555">Moderado (25–49)</text>
    <text x="${x0 + bw * .5}" y="70" fill="#555">Alto (50–74)</text><text x="${x0 + bw * .75}" y="70" fill="#555">Crítico (75–100)</text>
    <text x="${x0}" y="86" fill="#777" font-size="10">Estimación orientativa de riesgo de rotura (no es una predicción).</text>
  </svg>`;
}

function buildReportHtml(r, logoDataUri) {
  const d = r.disk, dg = r.diagnosis, c = r.counts || {};
  const smart = r.smart;
  const smartRows = smart && smart.available ? [
    ['Temperatura', smart.Temperature != null ? smart.Temperature + ' °C' : '—'],
    ['Desgaste (Wear)', smart.Wear != null ? smart.Wear + ' %' : '—'],
    ['Horas de uso', smart.PowerOnHours != null ? `${smart.PowerOnHours} h (${Math.floor(smart.PowerOnHours / 24)} días · ${(smart.PowerOnHours / 8760).toFixed(1)} años)` : '—'],
    ['Ciclos de carga/descarga', smart.LoadUnloadCycleCount ?? '—'],
    ['Errores de lectura (total / sin corregir)', `${smart.ReadErrorsTotal ?? '—'} / ${smart.ReadErrorsUncorrected ?? '—'}`],
    ['Errores de escritura (total / sin corregir)', `${smart.WriteErrorsTotal ?? '—'} / ${smart.WriteErrorsUncorrected ?? '—'}`],
    ['Encendidos (ciclos start-stop)', smart.StartStopCycleCount ?? '—'],
  ] : [['Estado', esc(smart ? (smart.error || 'No disponible') : 'No examinado')]];

  const vols = (d.volumes || []).map(v => `<tr><td>${esc(v.letter)}:</td><td>${esc(v.label || '—')}</td><td>${esc(v.fs || '—')}</td><td>${fmtBytes(v.size)}</td><td>${fmtBytes(v.free)}</td><td>${esc(v.health || '—')}</td><td>${dirtyText(v.dirty)}</td></tr>`).join('') || '<tr><td colspan="7">Sin volúmenes con letra</td></tr>';

  const evRows = [
    ['disk 153', 'Reintento de E/S (operación reintentada)', c.disk153], ['disk 7', 'Bloque defectuoso', c.disk7],
    ['disk 11', 'Error de controladora', c.disk11], ['disk 51', 'Error durante paginación', c.disk51],
    ['Ntfs 55', 'Estructura del sistema de archivos corrupta', c.ntfs55], ['Ntfs 98', 'Volumen requiere comprobación', c.ntfs98],
    ['Ntfs 137', 'Fallo del log transaccional', c.ntfs137], ['volmgr', 'Eventos del administrador de volúmenes', c.volmgr],
  ].map(([k, t, n]) => `<tr><td>${k}</td><td>${t}</td><td class="num ${n ? 'hit' : ''}">${n || 0}</td></tr>`).join('');
  const lastEv = (r.events || []).slice(0, 8).map(e => `<li><b>${esc(String(e.TimeCreated).replace('T', ' '))}</b> · ${esc(e.ProviderName)} ${e.Id} — ${esc(String(e.Message || '').replace(/\s+/g, ' ').slice(0, 160))}</li>`).join('');

  const chk = r.chkdsk;
  const chkHtml = chk && chk.ran
    ? `<p>chkdsk en modo <b>solo lectura</b>: ${chk.completed ? 'completado' : 'no completado'}${chk.cancelled ? ' (cancelado por el usuario)' : ''}. Errores: <b>${chk.errorsFound ? 'sí' : 'no'}</b> · errores de índice ($I30): <b>${chk.indexErrors}</b> · sectores defectuosos: <b>${chk.badSectorsKB} KB</b>.</p>${chk.keyLines.length ? '<pre>' + esc(chk.keyLines.slice(0, 14).join('\n')) + '</pre>' : ''}`
    : `<p>chkdsk no se ejecutó${chk && chk.note ? ': ' + esc(chk.note) : ''}.</p>`;

  const bars = dg.causes.map(cz => `
    <div class="cause"><div class="cl"><span>${esc(cz.label)}</span><b>${cz.pct} % <i>(estimado)</i></b></div>
    <div class="bar"><div style="width:${cz.pct}%;background:${CAUSE_COLORS[cz.id]}"></div></div>
    ${cz.reasons.length ? '<ul>' + cz.reasons.map(x => `<li>${esc(x)}</li>`).join('') + '</ul>' : ''}</div>`).join('');

  const col = RISK_COLORS[dg.risk.level];
  const top = dg.causes[0];
  const summary = `Para el disco <b>${esc(d.model)}</b> (${esc(d.bus)}, ${fmtBytes(d.size)}) la causa más probable es <b>${esc(top.label)}</b> (~${top.pct} %, estimación). ${esc(dg.risk.label)} de rotura (${dg.risk.score}/100). ${dg.findings.length ? 'Hallazgos: ' + esc(dg.findings.join('; ')) + '.' : 'No se encontró evidencia de fallo en los datos recolectados.'}`;

  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe NoDiscNoLive</title><style>
  @page{margin:16mm 14mm}
  *{box-sizing:border-box} body{font-family:"Segoe UI",Arial,sans-serif;color:#1d2433;font-size:11.5px;line-height:1.45;margin:0}
  header{display:flex;align-items:center;gap:14px;border-bottom:3px solid #2f80ed;padding-bottom:10px;margin-bottom:14px}
  header img{width:54px;height:54px} header h1{margin:0;font-size:21px} header .sub{color:#667;font-size:11px}
  h2{font-size:14px;margin:18px 0 6px;color:#1b4fa0;border-left:4px solid #2f80ed;padding-left:8px;page-break-after:avoid}
  table{width:100%;border-collapse:collapse;margin:4px 0} th,td{border:1px solid #d5dae3;padding:4px 7px;text-align:left;vertical-align:top}
  th{background:#eef2f9} td.num{text-align:right;width:60px} td.hit{background:#fdecea;font-weight:700}
  .box{border:1px solid #d5dae3;border-radius:6px;padding:9px 12px;background:#f7f9fc}
  .badge{display:inline-block;padding:2px 10px;border-radius:12px;color:#fff;font-weight:700;background:${col}}
  .cause{margin:8px 0;page-break-inside:avoid} .cl{display:flex;justify-content:space-between} .cl i{font-weight:400;color:#777}
  .bar{background:#e6eaf2;border-radius:5px;height:13px;overflow:hidden;margin:3px 0} .bar div{height:100%}
  ul{margin:3px 0 3px 18px;padding:0} pre{background:#f1f3f8;border:1px solid #dde;padding:7px;white-space:pre-wrap;font-size:10px}
  .warn{background:#fff6e5;border:1px solid #f2c94c;border-radius:6px;padding:8px 12px}
  footer{margin-top:18px;border-top:1px solid #d5dae3;padding-top:6px;color:#778;font-size:10px}
  </style></head><body>
  <header>${logoDataUri ? `<img src="${logoDataUri}">` : ''}<div><h1>Informe de diagnóstico de disco</h1><div class="sub">NoDiscNoLive · MAG · ${esc(r.generatedAtText)} · Equipo: ${esc(r.host)}</div></div></header>

  <h2>1. Resumen</h2>
  <div class="box"><span class="badge">${esc(dg.risk.label)} · ${dg.risk.score}/100</span><p style="margin:8px 0 0">${summary}</p></div>

  <h2>2. Datos del disco</h2>
  <table><tr><th>Modelo</th><td>${esc(d.model)}</td><th>Bus</th><td>${esc(d.bus)}</td></tr>
  <tr><th>Tamaño</th><td>${fmtBytes(d.size)}</td><th>Salud (Windows)</th><td>${esc(d.health)} / ${esc(d.operational)}</td></tr>
  <tr><th>Tipo</th><td>${esc(d.media || '—')}</td><th>Partición</th><td>${esc(d.style)}${d.isSystem ? ' · disco del sistema' : ''}</td></tr></table>
  <table><tr><th>Unidad</th><th>Etiqueta</th><th>FS</th><th>Tamaño</th><th>Libre</th><th>Salud</th><th>Bit de suciedad</th></tr>${vols}</table>

  <h2>3. Evidencia</h2>
  <p><b>Eventos del log del sistema (últimos ${r.days} días)</b></p>
  <table><tr><th>Evento</th><th>Significado</th><th>Cantidad</th></tr>${evRows}</table>
  ${lastEv ? `<p>Eventos más recientes:</p><ul>${lastEv}</ul>` : ''}
  <p><b>SMART (Get-StorageReliabilityCounter)</b></p>
  <table>${smartRows.map(([a, b]) => `<tr><th style="width:42%">${a}</th><td>${b}</td></tr>`).join('')}</table>
  <p><b>chkdsk</b></p>${chkHtml}

  <h2>4. Causas probables (porcentajes estimados)</h2>
  <p class="warn">${esc(dg.disclaimer)} Los porcentajes suman 100 %.</p>
  ${bars}

  <h2>5. Gráfico de riesgo de rotura</h2>
  ${riskChartSvg(dg.risk.score, dg.risk.level)}

  <h2>6. Recomendaciones</h2>
  <ol>${r.recommendations.map(x => `<li>${esc(x)}</li>`).join('')}</ol>

  <h2>7. Limitaciones</h2>
  <ul>${r.limitations.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
  <footer>Generado por NoDiscNoLive v${esc(r.appVersion)} — informe orientativo; no sustituye una revisión técnica.</footer>
  </body></html>`;
}

module.exports = { buildReportHtml, fmtBytes };
