'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diagnose, normalizeTo100, recommendations } = require('../src/engine/diagnostic');
const { parseDirty, parseChkdsk, parseChkdskProgress, parseChkdskStage, summarizeEvents } = require('../src/engine/parsers');

const sum = d => d.causes.reduce((a, c) => a + c.pct, 0);
const pctOf = (d, id) => d.causes.find(c => c.id === id).pct;

test('los porcentajes siempre suman 100 y son estimaciones', () => {
  const cases = [
    {},
    { disk: { bus: 'USB' }, events: { disk153: 7, ntfs98: 1 } },
    { disk: { bus: 'SATA' }, events: { disk7: 12, disk11: 3, volmgr: 2 }, dirty: true },
    { chkdsk: { completed: true, errorsFound: true, indexErrors: 5, badSectorsKB: 64 } },
  ];
  for (const c of cases) {
    const d = diagnose(c);
    assert.equal(sum(d), 100);
    assert.equal(d.estimated, true);
    assert.ok(d.causes.every(x => x.estimated === true && Number.isInteger(x.pct) && x.pct >= 0));
    assert.match(d.disclaimer, /ESTIMACIONES/);
  }
});

test('normalizeTo100 reparte el resto sin perder unidades', () => {
  const r = normalizeTo100({ a: 1, b: 1, c: 1 });
  assert.equal(r.a + r.b + r.c, 100);
});

test('caso D: (USB) disk 153 + Ntfs 98 + $I30 => cable y cierre sucio dominan, riesgo no alto', () => {
  const d = diagnose({
    disk: { bus: 'USB', health: 'Healthy' },
    smart: { available: false },
    dirty: true,
    chkdsk: { completed: true, errorsFound: true, indexErrors: 3, badSectorsKB: 0 },
    events: { disk153: 14, ntfs98: 2 },
  });
  const top2 = d.causes.slice(0, 2).map(c => c.id).sort();
  assert.deepEqual(top2, ['cable', 'sucio']);
  assert.ok(pctOf(d, 'desgaste') < pctOf(d, 'cable'));
  assert.ok(d.risk.score < 50, 'riesgo ' + d.risk.score);
  assert.equal(d.smartAvailable, false);
});

test('sectores defectuosos + SMART con errores => desgaste domina y riesgo crítico', () => {
  const d = diagnose({
    disk: { bus: 'SATA', health: 'Warning' },
    smart: { available: true, readErrorsUncorrected: 12, writeErrorsUncorrected: 2, wear: 90 },
    chkdsk: { completed: true, errorsFound: true, indexErrors: 0, badSectorsKB: 128 },
    events: { disk7: 6, disk11: 1 },
  });
  assert.equal(d.topCause, 'desgaste');
  assert.ok(d.risk.score >= 75, 'riesgo ' + d.risk.score);
  assert.equal(d.risk.level, 'critico');
});

test('errores de controladora (disk 11) en USB => controladora sobre desgaste', () => {
  const d = diagnose({ disk: { bus: 'USB' }, events: { disk11: 10, volmgr: 5 } });
  assert.ok(pctOf(d, 'controladora') > pctOf(d, 'desgaste'));
});

test('sin evidencia => "otras" lidera y riesgo bajo', () => {
  const d = diagnose({
    disk: { bus: 'NVMe', health: 'Healthy' },
    smart: { available: true, readErrorsUncorrected: 0, writeErrorsUncorrected: 0, wear: 3 },
    chkdsk: { completed: true, errorsFound: false, indexErrors: 0, badSectorsKB: 0 },
    events: {},
  });
  assert.equal(d.topCause, 'otras');
  assert.equal(d.risk.level, 'bajo');
});

test('el riesgo crece con más evidencia y se mantiene en 0-100', () => {
  const a = diagnose({ events: { disk153: 1 } }).risk.score;
  const b = diagnose({
    events: { disk153: 100, disk7: 50, disk11: 50, disk51: 50, ntfs55: 20 },
    chkdsk: { completed: true, badSectorsKB: 999 },
    smart: { available: true, readErrorsUncorrected: 99, wear: 99 },
    disk: { health: 'Unhealthy' },
  }).risk.score;
  assert.ok(b > a); assert.ok(b <= 100 && a >= 0);
});

test('recomendaciones siempre incluyen respaldo previo', () => {
  const rec = recommendations(diagnose({ events: { disk153: 3 }, disk: { bus: 'USB' } }), { isUSB: true });
  assert.ok(rec.some(r => /copia|Copiar/i.test(r)));
});

test('parseDirty en español e inglés', () => {
  assert.equal(parseDirty('El volumen - D: NO está sucio'), false);
  assert.equal(parseDirty('El volumen - D: está sucio'), true);
  assert.equal(parseDirty('Volume - D: is NOT Dirty'), false);
  assert.equal(parseDirty('Volume - D: is Dirty'), true);
  assert.equal(parseDirty('Error: Acceso denegado.'), 'noperm');
  assert.equal(parseDirty(''), null);
});

test('parseChkdsk detecta $I30, sectores defectuosos y finalización', () => {
  const out = [
    'Etapa 2: comprobando la estructura de nombres de archivo.',
    'Entrada de índice $I30 con error en el directorio 123',
    'Se encontraron problemas en el sistema de archivos.',
    '        0 KB en sectores defectuosos',
  ].join('\r\n');
  const r = parseChkdsk(out);
  assert.ok(r.indexErrors >= 1 && r.errorsFound && r.completed);
  assert.equal(r.badSectorsKB, 0);
  const r2 = parseChkdsk('Windows ha analizado el sistema de archivos y no ha encontrado problemas.\n  64 KB en sectores defectuosos');
  assert.equal(r2.badSectorsKB, 64);
  assert.equal(parseChkdsk('Acceso denegado, privilegios insuficientes').accessDenied, true);
});

test('parseChkdskProgress y etapa', () => {
  assert.equal(parseChkdskProgress('Progreso: 12 por ciento completado\r34 percent completed'), 34);
  assert.equal(parseChkdskProgress('sin numeros'), null);
  assert.deepEqual(parseChkdskStage('Etapa 2 de 3: archivos'), { stage: 2, of: 3 });
});

test('summarizeEvents cuenta por proveedor e id', () => {
  const c = summarizeEvents([
    { ProviderName: 'disk', Id: 153 }, { ProviderName: 'disk', Id: 153 }, { ProviderName: 'disk', Id: 7 },
    { ProviderName: 'Ntfs', Id: 98 }, { ProviderName: 'volmgr', Id: 46 }, { ProviderName: 'foo', Id: 1 },
  ]);
  assert.equal(c.disk153, 2); assert.equal(c.disk7, 1); assert.equal(c.ntfs98, 1); assert.equal(c.volmgr, 1); assert.equal(c.other, 1);
});
