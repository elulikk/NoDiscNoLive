'use strict';
/**
 * Motor de diagnóstico de NoDiscNoLive.
 * Estima causas probables con porcentajes (SIEMPRE estimaciones, suman 100 %)
 * y un riesgo de rotura, a partir de evidencia recolectada. Reglas puras y deterministas.
 */

const CAUSES = {
  cable:        { id: 'cable',        label: 'Cable, puerto o alimentación USB/SATA' },
  sucio:        { id: 'sucio',        label: 'Cierre sucio / extracción sin expulsar' },
  controladora: { id: 'controladora', label: 'Controladora o adaptador (puente USB-SATA/NVMe)' },
  desgaste:     { id: 'desgaste',     label: 'Desgaste o sectores dañados del medio' },
  otras:        { id: 'otras',        label: 'Otras causas / evidencia insuficiente' },
};

const BASE = { cable: 5, sucio: 5, controladora: 5, desgaste: 5, otras: 10 };

/** Reparte `total` en enteros proporcionales a `weights` (mayor resto). Suma exacta. */
function normalizeTo100(weights, total = 100) {
  const keys = Object.keys(weights);
  const sum = keys.reduce((a, k) => a + weights[k], 0) || 1;
  const raw = keys.map(k => ({ k, v: (weights[k] / sum) * total }));
  const out = {};
  let used = 0;
  raw.forEach(r => { out[r.k] = Math.floor(r.v); used += out[r.k]; });
  raw.sort((a, b) => (b.v - Math.floor(b.v)) - (a.v - Math.floor(a.v)));
  for (let i = 0; used < total; i++, used++) out[raw[i % raw.length].k]++;
  return out;
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
/** Puntos que crecen con el nº de eventos y saturan (un solo evento no domina). */
const sat = (count, max, k = 10) => (count <= 0 ? 0 : Math.round(max * (1 - Math.exp(-count / k))));

function riskLevel(score) {
  if (score < 25) return { level: 'bajo', label: 'Riesgo bajo' };
  if (score < 50) return { level: 'moderado', label: 'Riesgo moderado' };
  if (score < 75) return { level: 'alto', label: 'Riesgo alto' };
  return { level: 'critico', label: 'Riesgo crítico' };
}

/**
 * @param {object} ev evidencia:
 *  disk:   { bus, health }
 *  smart:  null | { available, wear, readErrorsUncorrected, writeErrorsUncorrected, ... }
 *  chkdsk: null | { completed, errorsFound, indexErrors, badSectorsKB }
 *  dirty:  true | false | null
 *  events: { disk153, disk7, disk11, disk51, ntfs55, ntfs98, ntfs137, volmgr }
 */
function diagnose(ev) {
  const disk = ev.disk || {};
  const smart = ev.smart && ev.smart.available ? ev.smart : null;
  const chk = ev.chkdsk || null;
  const e = Object.assign({ disk153: 0, disk7: 0, disk11: 0, disk51: 0, ntfs55: 0, ntfs98: 0, ntfs137: 0, volmgr: 0 }, ev.events || {});
  const isUSB = /usb/i.test(disk.bus || '');

  const w = Object.assign({}, BASE);
  const why = { cable: [], sucio: [], controladora: [], desgaste: [], otras: [] };
  const add = (cause, pts, reason) => { if (pts > 0) { w[cause] += pts; if (reason) why[cause].push(reason); } };
  const findings = [];

  // --- Eventos de disco ---
  if (e.disk153 > 0) {
    findings.push(`${e.disk153} evento(s) disk 153 (reintentos de E/S)`);
    add('cable', sat(e.disk153, isUSB ? 32 : 24), `Reintentos de E/S (disk 153 ×${e.disk153}) típicos de conexión inestable${isUSB ? ' USB' : ''}`);
    add('controladora', sat(e.disk153, isUSB ? 16 : 8), 'Los reintentos también apuntan al adaptador/controladora');
    add('desgaste', sat(e.disk153, 6), 'Los reintentos pueden deberse a zonas lentas del medio');
  }
  if (e.disk7 > 0) {
    findings.push(`${e.disk7} evento(s) disk 7 (bloque defectuoso)`);
    add('desgaste', sat(e.disk7, 30, 3), `Bloques defectuosos reportados (disk 7 ×${e.disk7})`);
  }
  if (e.disk11 > 0) {
    findings.push(`${e.disk11} evento(s) disk 11 (error de controladora)`);
    add('controladora', sat(e.disk11, 30, 4), `Errores de controladora (disk 11 ×${e.disk11})`);
    add('cable', sat(e.disk11, 12, 4), 'Los errores de controladora pueden venir del cable');
  }
  if (e.disk51 > 0) {
    findings.push(`${e.disk51} evento(s) disk 51 (error durante paginación)`);
    add('desgaste', sat(e.disk51, 12, 4), 'Error de E/S en paginación');
    add('cable', sat(e.disk51, 10, 4), null);
    add('controladora', sat(e.disk51, 10, 4), null);
  }
  if (e.volmgr > 0) {
    findings.push(`${e.volmgr} evento(s) volmgr`);
    add('controladora', sat(e.volmgr, 10, 4), 'Eventos volmgr (volumen/dispositivo desconectado)');
    add('cable', sat(e.volmgr, 8, 4), 'Desconexiones del volumen');
    add('sucio', sat(e.volmgr, 6, 4), null);
  }
  // --- NTFS ---
  if (e.ntfs98 > 0) { findings.push(`${e.ntfs98} evento(s) Ntfs 98`); add('sucio', sat(e.ntfs98, 18, 3), `Ntfs 98 ×${e.ntfs98}: el volumen requirió comprobación (apagado incorrecto)`); }
  if (e.ntfs55 > 0) { findings.push(`${e.ntfs55} evento(s) Ntfs 55 (estructura corrupta)`); add('sucio', sat(e.ntfs55, 14, 3), `Ntfs 55 ×${e.ntfs55}: estructura del sistema de archivos corrupta`); add('desgaste', sat(e.ntfs55, 8, 3), null); }
  if (e.ntfs137 > 0) { findings.push(`${e.ntfs137} evento(s) Ntfs 137`); add('sucio', sat(e.ntfs137, 8, 3), 'Ntfs 137: fallo del log transaccional'); add('controladora', sat(e.ntfs137, 6, 3), null); }

  // --- Bit de suciedad ---
  if (ev.dirty === true) { findings.push('Bit de suciedad (dirty) activo'); add('sucio', 20, 'Volumen marcado como sucio (fsutil dirty)'); }

  // --- chkdsk ---
  if (chk && chk.completed) {
    if (chk.indexErrors > 0) {
      findings.push(`chkdsk: ${chk.indexErrors} error(es) de índice ($I30)`);
      add('sucio', 18, 'Errores de índice $I30: patrón típico de cierre sucio');
      add('controladora', 4, null);
    } else if (chk.errorsFound) {
      findings.push('chkdsk: errores del sistema de archivos');
      add('sucio', 8, 'chkdsk halló errores lógicos');
    }
    if (chk.badSectorsKB > 0) {
      findings.push(`chkdsk: ${chk.badSectorsKB} KB en sectores defectuosos`);
      add('desgaste', 35, `chkdsk reporta ${chk.badSectorsKB} KB en sectores defectuosos`);
    }
    if (!chk.errorsFound && chk.badSectorsKB === 0) findings.push('chkdsk (solo lectura) sin problemas');
  }

  // --- SMART ---
  let smartRisk = 0;
  if (smart) {
    if (n(smart.readErrorsUncorrected) > 0) { findings.push(`SMART: ${smart.readErrorsUncorrected} errores de lectura no corregidos`); add('desgaste', 25, 'Errores de lectura no corregidos en SMART'); smartRisk += 25; }
    if (n(smart.writeErrorsUncorrected) > 0) { findings.push(`SMART: ${smart.writeErrorsUncorrected} errores de escritura no corregidos`); add('desgaste', 20, 'Errores de escritura no corregidos en SMART'); smartRisk += 20; }
    if (n(smart.wear) >= 80) { findings.push(`SMART: desgaste ${smart.wear} %`); add('desgaste', 20, `Desgaste SSD elevado (${smart.wear} %)`); smartRisk += 20; }
    if (n(smart.readErrorsUncorrected) === 0 && n(smart.writeErrorsUncorrected) === 0 && n(smart.wear) < 80) findings.push('SMART sin errores no corregidos');
  } else {
    why.otras.push('SMART no disponible (adaptador USB sin paso de SMART o falta de permisos): menor certeza');
    w.otras += 5;
  }
  if (findings.length === 0) why.otras.push('No hay evidencia de fallo: puede ser normal o faltan datos');
  if (disk.health && /unhealthy|warning/i.test(disk.health)) add('desgaste', 10, `Windows reporta salud: ${disk.health}`);

  // --- Porcentajes (suman 100, siempre estimaciones) ---
  const pct = normalizeTo100(w);
  const causes = Object.keys(CAUSES).map(k => ({
    id: k, label: CAUSES[k].label, pct: pct[k], reasons: why[k], estimated: true,
  })).sort((a, b) => b.pct - a.pct);

  // --- Riesgo de rotura (0-100) ---
  let risk = 8;
  if (chk && chk.badSectorsKB > 0) risk += 25;
  risk += smartRisk;
  risk += sat(e.disk7, 20, 3);
  risk += sat(e.disk11, 8, 4) + sat(e.disk51, 8, 4);
  risk += sat(e.disk153, 14, 15);
  risk += sat(e.ntfs55 + e.ntfs137, 6, 4);
  if (disk.health && /unhealthy/i.test(disk.health)) risk += 30;
  else if (disk.health && /warning/i.test(disk.health)) risk += 15;
  risk = clamp(Math.round(risk), 0, 100);
  const lvl = riskLevel(risk);

  return {
    estimated: true,
    disclaimer: 'Los porcentajes son ESTIMACIONES heurísticas calculadas por reglas a partir de la evidencia disponible; no son mediciones ni un diagnóstico de laboratorio.',
    causes,
    risk: { score: risk, level: lvl.level, label: lvl.label },
    findings,
    smartAvailable: !!smart,
    topCause: causes[0].id,
  };
}

function recommendations(diag, ctx = {}) {
  const r = [];
  const top = diag.topCause;
  if (diag.risk.score >= 50 || ctx.badSectors) r.push('Copiar YA los datos importantes a otro disco antes de cualquier reparación; considerar reemplazar la unidad.');
  else r.push('Hacer una copia de seguridad de los datos importantes antes de cualquier reparación.');
  if (top === 'cable' || ctx.isUSB) r.push('Probar con otro cable USB (corto y de buena calidad), otro puerto directo en la placa (sin hubs) y, si es un disco de 2,5", alimentación externa.');
  if (top === 'sucio' || ctx.dirty) r.push('Usar siempre "Quitar hardware de forma segura" antes de desconectar; evitar apagones o suspensión con el disco en uso.');
  if (top === 'controladora') r.push('Probar el disco con otro adaptador/carcasa o conectarlo directo por SATA/NVMe para descartar el puente USB.');
  if (top === 'desgaste' || diag.risk.score >= 50) r.push('Revisar SMART con la herramienta del fabricante y programar el reemplazo del disco.');
  r.push('Si hay errores lógicos, ejecutar chkdsk /f desde NoDiscNoLive solo DESPUÉS de copiar los datos (/r es lento y estresa un disco dudoso).');
  r.push('Repetir el examen tras los cambios para ver si los eventos disk 153 / Ntfs dejan de aparecer.');
  return r;
}

const LIMITATIONS = [
  'Los porcentajes son estimaciones heurísticas basadas en reglas; no sustituyen un análisis de laboratorio.',
  'Muchos adaptadores USB no transmiten SMART; la ausencia de datos no implica que el disco esté sano.',
  'El chkdsk en modo solo lectura no corrige nada y puede no detectar fallos intermitentes.',
  'Los eventos del log se atribuyen al disco por número o letra de unidad; algunos pueden no vincularse.',
  'El riesgo de rotura es un indicador orientativo, no una predicción de fallo.',
];

module.exports = { diagnose, recommendations, normalizeTo100, riskLevel, LIMITATIONS, CAUSES };
