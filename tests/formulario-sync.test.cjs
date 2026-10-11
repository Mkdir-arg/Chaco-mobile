const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

async function enqueue(runtime, payload = {}, type = 'insert_relevamiento', id = 'case1') {
  await runtime.service.getPendingCount();
  const value = {backend: 'django_becas', _owner_user_id: '7', relevamiento_id: 1,
    client_uuid: '11111111-1111-4111-a111-111111111111', capturado_en: '2026-10-08T12:00:00-03:00', version_capturada: 3,
    datos_identificacion: {dni: '12345678', nombre: 'Ana', apellido: 'Perez'}, ...payload};
  runtime.sql.prepare(`INSERT INTO local_relevamientos (local_id,client_uuid,created_at,updated_at,payload_json)
    VALUES (?,?, '2026-10-08T15:00:00Z','now',?)`).run(id, value.client_uuid, JSON.stringify(value));
  runtime.sql.prepare(`INSERT INTO outbox_relevamientos (local_id,op_id,type,payload_json,created_at,updated_at)
    VALUES (?,?,?,?,'2026-10-08T15:00:00Z','now')`).run(id, id, type, JSON.stringify(value));
  return value;
}
const row = (r, id = 'case1') => r.sql.prepare('SELECT * FROM outbox_relevamientos WHERE local_id=?').get(id);
const attachment = key => ({key, fileName: `${key}.jpg`, uri: `file:///${key}.jpg`, size: 100, scope: 'globales', field_id: key});

test('captura offline conserva fecha y versión, y muestra sincronización tardía al enviar', async () => {
  const r = await setup(); r.setOnline(false);
  const saved = await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3,
    capturado_en: '2026-10-08T12:00:00-03:00', datos_identificacion: {dni: '12345678'}, data: {globales: {}, requisitos: {}}});
  const localId = saved.record.local_id;
  const original = JSON.parse(row(r, localId).payload_json);
  assert.equal(original.version_capturada, 3);
  assert.equal(original.capturado_en, '2026-10-08T12:00:00-03:00');
  let body;
  r.setOnline(true); r.setFetch(async (url, options) => {
    if (options?.method === 'POST') {body = JSON.parse(options.body); return response(201, {id: 99, sincronizado_tarde: true});}
    return response(200, []);
  });
  await r.service.syncPendingOperations();
  assert.equal(body.version_capturada, 3); assert.equal(body.capturado_en, original.capturado_en);
  assert.equal((await r.service.getBecasFormularios(1)).records[0].sincronizado_tarde, true);
});

test('captura online siempre envía fecha ISO y versión sin exigir contacto', async () => {
  const r = await setup(); let body;
  r.setFetch(async (url, options) => {body = JSON.parse(options.body); return response(201, {id: 99});});
  await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 4, datos_identificacion: {dni: '12345678'}});
  assert.equal(body.version_capturada, 4); assert.ok(Number.isFinite(Date.parse(body.capturado_en)));
  assert.equal(body.celular, undefined); assert.equal(body.email_contacto, undefined);
});

for (const payload of [
  {detail: 'El relevamiento cerró hace más de 24 horas y ya no acepta cargas sincronizadas tarde.'},
  {detail: 'Plazo agotado', code: 'GRACIA_VENCIDA'},
]) test('gracia vencida tiene aviso propio y no se reenvía al sincronizar manualmente', async () => {
  const r = await setup(); await enqueue(r); let calls = 0;
  r.setFetch(async () => {calls++; return response(409, payload);});
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'GRACIA_VENCIDA');
  assert.match(row(r).last_error, /Avisá al coordinador/);
  await r.service.retryFailedOperations(); assert.equal(calls, 1);
});

test('CASO_RESUELTO descarta solo ese adjunto, sube los demás y permite finalizar', async () => {
  const r = await setup(); await enqueue(r, {remote_formulario_id: 99, adjuntos_formulario: [attachment('one'), attachment('two')]});
  await enqueue(r, {}, 'finalizar_relevamiento', 'finish'); let uploads = 0; let finished = 0;
  r.setFetch(async url => {
    if (url.endsWith('/adjuntos/')) return ++uploads === 1
      ? response(409, {detail: 'El caso ya fue resuelto', code: 'CASO_RESUELTO'}) : response(201, {id: 2});
    finished++; return response(200, {id: 1, estado: 'FINALIZADO'});
  });
  const result = await r.service.syncPendingOperations();
  assert.equal(uploads, 2); assert.equal(finished, 1); assert.equal(result.synced, 2);
  const value = JSON.parse(row(r).payload_json);
  assert.equal(value.attachment_results.one.status, 'DISCARDED');
  assert.deepEqual(value.uploaded_attachment_keys, ['two']);
  assert.equal(row(r, 'finish').status, 'SYNCED');
});

test('400 de un adjunto conserva el motivo y no impide subir el siguiente', async () => {
  const r = await setup(); await enqueue(r, {remote_formulario_id: 99, adjuntos_formulario: [attachment('one'), attachment('two')]});
  let calls = 0; r.setFetch(async () => ++calls === 1 ? response(400, {archivo: ['Formato inválido']}) : response(201, {id: 2}));
  await r.service.syncPendingOperations();
  assert.equal(calls, 2); assert.equal(row(r).last_error_code, 'ADJUNTOS_RECHAZADOS');
  assert.match(row(r).last_error, /archivo: Formato inválido/);
  const value = JSON.parse(row(r).payload_json);
  assert.equal(value.attachment_results.one.status, 'REJECTED'); assert.deepEqual(value.uploaded_attachment_keys, ['two']);
  await r.service.retryFailedOperations(); assert.equal(calls, 2);
});

for (const payload of [{pausado: true, detail: 'Relevamiento pausado'}, {code: 'CUPO_RELEVAMIENTO_COMPLETO', detail: 'Cupo completo'}]) {
  test(`409 ${payload.code || 'pausa'} conserva el tratamiento anterior`, async () => {
    const r = await setup(); await enqueue(r); r.setFetch(async () => response(409, payload));
    await r.service.syncPendingOperations();
    assert.equal(row(r).status, payload.pausado ? 'PENDING' : 'FAILED_PERMANENT');
    assert.notEqual(row(r).last_error_code, 'GRACIA_VENCIDA');
  });
}

test('alta 400 se corrige conservando UUID, fecha, versión y adjuntos', async () => {
  const r = await setup();
  const field = {id: 'globales:1', original_id: 1, scope: 'globales', tipo: 'ARCHIVO'};
  const original = await enqueue(r, {campos_definicion: [field], data: {globales: {'1': {archivo_adjunto: true}}},
    adjuntos_formulario: [{...attachment('globales:1'), field_id: '1'}]});
  r.setFetch(async () => response(400, {datos_identificacion: {dni: ['DNI imposible']}}));
  await r.service.syncPendingOperations(); assert.equal(row(r).last_error_code, 'ALTA_INVALIDA');
  assert.match(row(r).last_error, /datos_identificacion.dni: DNI imposible/);
  let body; r.setFetch(async (url, options) => {
    if (url.endsWith('/adjuntos/')) return response(201, {id: 1});
    body = JSON.parse(options.body); return response(201, {id: 99});
  });
  await r.service.correctFailedFormulario('case1', {datos_identificacion: {...original.datos_identificacion, dni: '87654321'},
    client_uuid: 'changed', capturado_en: '2099-01-01', version_capturada: 999});
  assert.equal(body.datos_identificacion.dni, '87654321'); assert.equal(body.client_uuid, original.client_uuid);
  assert.equal(body.capturado_en, original.capturado_en); assert.equal(body.version_capturada, 3);
  assert.equal(row(r).status, 'SYNCED');
  assert.equal(JSON.parse(row(r).payload_json).adjuntos_formulario.length, 1);
  assert.equal(r.sql.prepare("SELECT count(*) AS n FROM local_relevamientos WHERE local_id='case1'").get().n, 1);
});

test('exportar conserva la cola; descartar una falla desbloquea finalizar sin borrar datos', async () => {
  const r = await setup(); await enqueue(r); await enqueue(r, {}, 'finalizar_relevamiento', 'finish');
  r.setFetch(async () => response(400, {non_field_errors: ['Fecha imposible']}));
  await r.service.syncPendingOperations(); assert.equal(row(r, 'finish').status, 'PENDING');
  const exported = JSON.parse(await r.service.exportFailedOperation('case1'));
  assert.equal(exported.operation.payload.datos_identificacion.dni, '12345678');
  assert.equal(row(r).status, 'FAILED_PERMANENT');
  r.setFetch(async () => response(200, {id: 1, estado: 'FINALIZADO'}));
  await r.service.discardFailedOperation('case1');
  assert.equal(row(r).status, 'DISCARDED'); assert.equal(row(r, 'finish').status, 'SYNCED');
  assert.ok(r.sql.prepare("SELECT payload_json FROM local_relevamientos WHERE local_id='case1'").get());
});

test('acciones sobre fallidas respetan al dueño de la captura', async () => {
  const r = await setup(); await enqueue(r, {_owner_user_id: '8'});
  r.sql.prepare("UPDATE outbox_relevamientos SET status='FAILED_PERMANENT'").run();
  await assert.rejects(r.service.discardFailedOperation('case1'), /usuario actual/);
  await assert.rejects(r.service.exportFailedOperation('case1'), /usuario actual/);
  await assert.rejects(r.service.correctFailedFormulario('case1', {}), /usuario actual/);
  await r.service.retryFailedOperations(); assert.equal(row(r).status, 'FAILED_PERMANENT');
});

for (const [name, size, expected] of [['photo.jpg', 5 * 1024 * 1024 + 1, /5 MB/], ['document.docx', 100, /JPG/]]) {
  test(`archivo ${name} se rechaza antes de guardar o subir`, async () => {
    const r = await setup(); let calls = 0; r.setFetch(async () => {calls++; return response(200, {});});
    await assert.rejects(r.service.saveBecasFormulario({relevamiento_id: 1,
      campos_definicion: [{tipo: 'ARCHIVO', scope: 'globales', original_id: 1}],
      data: {globales: {'1': {uri: `file:///${name}`, fileName: name, size}}}}), expected);
    assert.equal(calls, 0); assert.equal(r.sql.prepare('SELECT count(*) AS n FROM outbox_relevamientos').get().n, 0);
  });
}

test('los formatos permitidos y el límite exacto de 5 MB son aceptados', async () => {
  const r = await setup(); r.setOnline(false);
  for (const ext of ['jpg', 'JPEG', 'png', 'webp', 'heic', 'heif', 'pdf']) {
    await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 1,
      campos_definicion: [{tipo: 'ARCHIVO', scope: 'globales', original_id: 1}],
      data: {globales: {'1': {uri: `file:///document.${ext}`, fileName: `document.${ext}`, size: 5 * 1024 * 1024}}}});
  }
  assert.equal(r.sql.prepare('SELECT count(*) AS n FROM outbox_relevamientos').get().n, 7);
});

test('una falla transitoria en un adjunto permite intentar los siguientes y conserva reintentos', async () => {
  const r = await setup(); await enqueue(r, {remote_formulario_id: 99, adjuntos_formulario: [attachment('one'), attachment('two')]});
  let calls = 0; r.setFetch(async () => ++calls === 1 ? response(503, {detail: 'Servicio caído'}) : response(201, {id: 2}));
  await r.service.syncPendingOperations();
  assert.equal(calls, 2); assert.equal(row(r).status, 'PENDING');
  assert.deepEqual(JSON.parse(row(r).payload_json).uploaded_attachment_keys, ['two']);
});


test('un relevamiento que desaparece del servidor sigue accesible mientras tenga fallidas', async () => {
  const r = await setup();
  r.setFetch(async () => response(200, {id: 1, nombre: 'Campaña', estado: 'EN_CURSO', definicion_formulario: {version: 3}}));
  await r.service.getRelevamientoDetail(1);
  await enqueue(r);
  r.setFetch(async (url, options) => options?.method === 'POST'
    ? response(409, {detail: 'El relevamiento cerró hace más de 24 horas'}) : response(200, []));
  const list = await r.service.getRelevamientos();
  assert.ok(list.records.some((item) => String(item.id) === '1'));
  r.setOnline(false);
  const detail = await r.service.getRelevamientoDetail(1);
  assert.equal(detail.success, true);
  assert.equal(detail.detail.definicion_formulario.version, 3);
  assert.equal((await r.service.getFailedOperations(1)).length, 1);
});

test('exportación nativa incluye el archivo del caso fallido y conserva su estado', async () => {
  const r = await setup('android');
  await enqueue(r, {adjuntos_formulario: [attachment('one')]});
  r.setFetch(async () => response(400, {non_field_errors: ['Corregí el DNI']}));
  await r.service.syncPendingOperations();
  const exported = JSON.parse(await r.service.exportFailedOperation('case1'));
  assert.equal(exported.attachments[0].content_base64, 'aW1hZ2U=');
  assert.equal(row(r).status, 'FAILED_PERMANENT');
});


test('actualizar casos desde SQLite muestra lo sincronizado sin nuevas peticiones', async () => {
  const r = await setup(); await enqueue(r);
  r.setFetch(async () => response(201, {id: 99, sincronizado_tarde: true}));
  await r.service.syncPendingOperations();
  r.setFetch(async () => {throw new Error('No debe consultar el servidor');});
  const cases = await r.service.getBecasFormularios(1, {refreshFromRemote: false});
  assert.equal(cases.records[0].sincronizado_tarde, true);
  assert.equal(cases.records[0].estado, 'ENVIADO');
});


test('un inicio descartado no retiene indefinidamente las operaciones siguientes', async () => {
  const r = await setup();
  await enqueue(r, {}, 'iniciar_relevamiento', 'start');
  await enqueue(r);
  r.sql.prepare("UPDATE outbox_relevamientos SET status='FAILED_PERMANENT' WHERE local_id='start'").run();
  let calls = 0;
  r.setFetch(async () => {calls++; return response(201, {id: 99});});
  await r.service.discardFailedOperation('start');
  assert.equal(row(r, 'start').status, 'DISCARDED');
  assert.equal(row(r).status, 'SYNCED');
  assert.equal(calls, 1);
});
