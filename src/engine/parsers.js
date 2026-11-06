'use strict';
// Parsers de salida de herramientas de Windows (independientes del idioma en lo posible).

/** Interpreta la salida de `fsutil dirty query X:` -> true | false | null | 'noperm' */
function parseDirty(raw) {
  if (!raw) return null;
  const t = String(raw);
  if (/(acceso denegado|access is denied|privilegio|privilege|administrador|administrator)/i.test(t)) return 'noperm';
  if (/\bno\b[^\n]*(sucio|suciedad|dirty)|not dirty|\bis not\b/i.test(t)) return false;
  if (/(sucio|suciedad|dirty|contiene errores|contains errors)/i.test(t)) return true;
  return null;
}

/** Analiza la salida de texto de chkdsk (solo lectura o reparación). */
function parseChkdsk(text) {
  const t = String(text || '');
  const lines = t.split(/\r?\n|\r/).map(l => l.trim()).filter(Boolean);
  const res = {
    completed: false, errorsFound: false, indexErrors: 0, badSectorsKB: 0,
    orphanFiles: 0, accessDenied: false, keyLines: [],
  };
  if (/(acceso denegado|access denied|privilegios? insuficientes|insufficient privileges)/i.test(t)) res.accessDenied = true;
  if (/(no ha encontrado problemas|found no problems|no problems found)/i.test(t)) res.completed = true;
  if (/(se encontraron problemas|found problems|errors found|se han encontrado errores|Windows ha encontrado errores|has found errors)/i.test(t)) {
    res.errorsFound = true; res.completed = true;
  }
  if (/(Windows ha comprobado el sistema de archivos|Windows has scanned the file system|Total disk space|espacio total en disco)/i.test(t)) res.completed = true;
  for (const l of lines) {
    const isIndex = /(\$I30|index entry|entrada de [íi]ndice|[íi]ndice|index)/i.test(l);
    const isErr = /(error|incorrect|inv[aá]lid|corrupt|da[ñn]ad|damaged|unsorted|sin ordenar|problem)/i.test(l);
    if (isIndex && isErr) { res.indexErrors++; res.errorsFound = true; }
    if (/(\$I30)/i.test(l) || (isIndex && isErr) || /(archivos hu[eé]rfanos|orphan)/i.test(l) || /(sectores defectuosos|bad sectors)/i.test(l) || /(se encontraron problemas|found problems|no ha encontrado|found no problems)/i.test(l)) {
      if (res.keyLines.length < 40) res.keyLines.push(l);
    }
  }
  const m = t.match(/([\d.,]+)\s*KB\s+(?:en sectores defectuosos|in bad sectors)/i);
  if (m) res.badSectorsKB = parseInt(m[1].replace(/[.,]/g, ''), 10) || 0;
  if (res.badSectorsKB > 0) res.errorsFound = true;
  const o = t.match(/(\d+)\s+(?:archivos hu[eé]rfanos|orphan)/i);
  if (o) res.orphanFiles = parseInt(o[1], 10);
  return res;
}

/** Extrae porcentaje de progreso de un fragmento de salida de chkdsk. Devuelve null si no hay. */
function parseChkdskProgress(chunk) {
  const s = String(chunk || '');
  let last = null, m;
  const re = /(\d{1,3})\s*(?:%|por ciento|percent)/gi;
  while ((m = re.exec(s))) { const v = parseInt(m[1], 10); if (v >= 0 && v <= 100) last = v; }
  return last;
}

/** Etapa actual ("Etapa 2 de 3" / "Stage 2 of 3") */
function parseChkdskStage(chunk) {
  const m = String(chunk || '').match(/(?:etapa|stage)\s+(\d+)\s+(?:de|of)\s+(\d+)/gi);
  if (!m) return null;
  const n = m[m.length - 1].match(/(\d+)\D+(\d+)/);
  return { stage: +n[1], of: +n[2] };
}

/** Normaliza eventos del log del sistema a conteos. */
function summarizeEvents(events) {
  const c = { disk153: 0, disk7: 0, disk11: 0, disk51: 0, ntfs55: 0, ntfs98: 0, ntfs137: 0, volmgr: 0, other: 0, total: 0 };
  for (const e of events || []) {
    const p = String(e.ProviderName || e.provider || '').toLowerCase();
    const id = Number(e.Id ?? e.id);
    c.total++;
    if (p === 'disk' && [153, 7, 11, 51].includes(id)) c['disk' + id]++;
    else if (p === 'ntfs' && [55, 98, 137].includes(id)) c['ntfs' + id]++;
    else if (p === 'volmgr') c.volmgr++;
    else c.other++;
  }
  return c;
}

module.exports = { parseDirty, parseChkdsk, parseChkdskProgress, parseChkdskStage, summarizeEvents };
