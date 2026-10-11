const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');
const start = '2026-10-10T08:00:00-03:00';
const end = '2026-10-10T14:00:00-03:00';

for (const online of [true, false]) {
  for (const [now, allowed] of [
    ['2026-10-10T07:59:59-03:00', false], ['2026-10-10T08:00:00-03:00', true],
    ['2026-10-10T14:00:00-03:00', true], ['2026-10-10T14:00:00.001-03:00', false],
  ]) {
    test(`inicio ${online ? 'online' : 'offline'} a ${now} respeta la franja`, async () => {
      const r = await setup(); r.setPeriod(start, end); r.setNow(now); r.setOnline(online);
      let calls = 0; r.setFetch(async () => {calls++; return response(200, {id: 1, estado: 'EN_CURSO'});});
      const result = await r.service.iniciarRelevamiento(1);
      assert.equal(result.success, allowed);
      assert.equal(calls, online && allowed ? 1 : 0);
      const queued = r.sql.prepare("SELECT count(*) AS n FROM outbox_relevamientos WHERE type='iniciar_relevamiento'").get().n;
      assert.equal(queued, !online && allowed ? 1 : 0);
    });
  }
}

for (const now of ['2026-10-10T07:59:59-03:00', '2026-10-10T14:00:00.001-03:00']) {
  test(`una nueva captura fuera de la franja (${now}) no se guarda ni envía`, async () => {
    const r = await setup(); r.setPeriod(start, end); r.setNow(now); let calls = 0;
    r.setFetch(async () => {calls++; return response(201, {id: 99});});
    await assert.rejects(r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3,
      capturado_en: '2026-10-10T12:00:00-03:00', datos_identificacion: {dni: '12345678'}}), /fecha y hora asignadas/);
    assert.equal(calls, 0);
    assert.equal(r.sql.prepare('SELECT count(*) AS n FROM outbox_relevamientos').get().n, 0);
  });
}

test('casos offline siguen accesibles después del cierre y se sincronizan con la captura original', async () => {
  const r = await setup(); r.setPeriod(start, end); r.setNow('2026-10-10T12:00:00-03:00'); r.setOnline(false);
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3, datos_identificacion: {dni: '12345678'}});
  const original = saved.record.payload.capturado_en;
  r.setNow('2026-10-10T16:00:00-03:00');
  const list = await r.service.getRelevamientos();
  assert.equal(list.records.length, 1); assert.equal(list.records[0].has_pending_operations, true);
  assert.equal(r.dates.isAssignmentVisible(list.records[0]), true);
  assert.equal(r.sql.prepare('SELECT status FROM outbox_relevamientos').get().status, 'PENDING');
  r.setOnline(true); r.setNow('2026-10-11T09:00:00-03:00'); let body;
  r.setFetch(async (url, options) => {body = JSON.parse(options.body); return response(201, {id: 99, sincronizado_tarde: true});});
  const result = await r.service.syncPendingOperations();
  assert.equal(result.synced, 1); assert.equal(body.capturado_en, original); assert.equal(body.version_capturada, 3);
});

test('corregir una captura existente después del cierre conserva su fecha en lugar de crear otra', async () => {
  const r = await setup(); r.setPeriod(start, end); r.setNow('2026-10-10T12:00:00-03:00');
  r.setFetch(async () => response(400, {non_field_errors: ['DNI inválido']}));
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3, datos_identificacion: {dni: '12345678'}});
  r.setNow('2026-10-10T16:00:00-03:00'); let body;
  r.setFetch(async (url, options) => {body = JSON.parse(options.body); return response(201, {id: 99, sincronizado_tarde: true});});
  await r.service.correctFailedFormulario(saved.record.local_id, {datos_identificacion: {dni: '87654321'}});
  assert.equal(body.capturado_en, '2026-10-10T15:00:00.000Z');
  assert.equal(r.sql.prepare('SELECT count(*) AS n FROM outbox_relevamientos').get().n, 1);
});

test('franjas compactas distinguen horas, días completos y cambio de año', async () => {
  const {dates} = await setup();
  assert.equal(dates.formatDateTimeRange(start, end), '10/10 08:00 a 14:00');
  assert.equal(dates.formatDateTimeRange(start, '2026-10-12T14:00:00-03:00'), '10/10 08:00 a 12/10 14:00');
  assert.equal(dates.formatDateTimeRange('2026-10-10T00:00:00-03:00', '2026-10-12T23:59:59-03:00'), '10/10 a 12/10');
  assert.equal(dates.formatDateTimeRange('2026-10-10', '2026-10-10'), '10/10');
  assert.equal(dates.formatDateTimeRange('2026-12-31', '2027-01-02'), '31/12/2026 a 02/01/2027');
});

test('fechas sin hora mantienen días completos; ISO sin zona se interpreta en Argentina', async () => {
  const {dates} = await setup();
  assert.equal(dates.isDateTimeActive('2026-10-10', '2026-10-10', new Date('2026-10-10T23:59:59-03:00')), true);
  assert.equal(dates.isDateTimeActive('2026-10-10', '2026-10-10', new Date('2026-10-11T00:00:00-03:00')), false);
  assert.equal(dates.parseAssignmentDate('2026-10-10T08:00:00').toISOString(), '2026-10-10T11:00:00.000Z');
});

test('zona del teléfono no altera las horas ni los días del relevamiento', async () => {
  const {dates} = await setup(); const original = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = timezone;
      assert.equal(dates.formatDateTimeRange(start, end), '10/10 08:00 a 14:00');
      assert.equal(dates.dateKey('2026-10-11T02:00:00Z'), '2026-10-10');
      assert.equal(dates.formatDate('2026-10-10T11:00:00Z', {includeTime: true}), '10/10/2026 08:00');
      assert.equal(dates.isDateTimeActive(start, end, new Date('2026-10-10T10:59:59Z')), false);
    }
  } finally {
    if (original == null) delete process.env.TZ; else process.env.TZ = original;
  }
});

test('el aviso aparece a menos de dos horas y se retira al cerrar', async () => {
  const {dates} = await setup();
  assert.equal(dates.closingSoonLabel(start, end, new Date('2026-10-10T12:00:00-03:00')), '');
  assert.equal(dates.closingSoonLabel(start, end, new Date('2026-10-10T12:00:00.001-03:00')), 'Cierra a las 14:00');
  assert.equal(dates.closingSoonLabel(start, end, new Date('2026-10-10T14:00:00-03:00')), '');
  assert.equal(dates.closingSoonLabel(start, end, new Date('2026-10-10T07:00:00-03:00')), '');
});

test('el reloj actualiza la UI en apertura, cierre y entrada al aviso', async () => {
  const {dates} = await setup(); const assignments = [{fecha_asignada: start, fecha_hasta: end}];
  assert.equal(dates.nextAssignmentRefreshMs(assignments, new Date('2026-10-10T07:59:59-03:00')), 1000);
  assert.equal(dates.nextAssignmentRefreshMs(assignments, new Date('2026-10-10T13:59:59-03:00')), 1001);
  assert.equal(dates.nextAssignmentRefreshMs(assignments, new Date('2026-10-10T12:00:00-03:00')), 1);
});

test('fechas inválidas o franja invertida no habilitan la carga', async () => {
  const {dates} = await setup();
  assert.equal(dates.isDateTimeActive(null, end), false);
  assert.equal(dates.isDateTimeActive('invalid', end), false);
  assert.equal(dates.isDateTimeActive(end, start, new Date('2026-10-10T12:00:00-03:00')), false);
  assert.equal(dates.parseAssignmentDate('2026-02-30'), null);
  assert.equal(dates.formatDateTimeRange(end, start), 'Sin período válido');
});

test('listado oculta vencidos sin pendientes y conserva los que requieren sincronizar', async () => {
  const {dates} = await setup(); const now = new Date('2026-10-10T16:00:00-03:00');
  const item = {fecha_asignada: start, fecha_hasta: end};
  assert.equal(dates.isAssignmentVisible(item, now), false);
  assert.equal(dates.isAssignmentVisible({...item, has_pending_operations: true}, now), true);
});
