const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

// Contrato back <-> app: cola de sincronización, reloj, login y versión.
const T0 = Date.parse('2026-10-10T12:00:00Z');
const MIN = 60 * 1000;
const UUID = '11111111-1111-4111-a111-111111111111';

async function enqueue(runtime, payload = {}, type = 'insert_relevamiento', id = 'case1') {
  await runtime.service.getPendingCount();
  const value = {backend: 'django_becas', _owner_user_id: '7', relevamiento_id: 1,
    client_uuid: UUID, capturado_en: '2026-10-08T12:00:00-03:00', version_capturada: 3,
    datos_identificacion: {dni: '12345678', nombre: 'Ana', apellido: 'Perez'}, ...payload};
  runtime.sql.prepare(`INSERT INTO local_relevamientos (local_id,client_uuid,created_at,updated_at,payload_json)
    VALUES (?,?, '2026-10-08T15:00:00Z','now',?)`).run(id, value.client_uuid, JSON.stringify(value));
  runtime.sql.prepare(`INSERT INTO outbox_relevamientos (local_id,op_id,type,payload_json,created_at,updated_at)
    VALUES (?,?,?,?,'2026-10-08T15:00:00Z','now')`).run(id, id, type, JSON.stringify(value));
  return value;
}
const row = (r, id = 'case1') => r.sql.prepare('SELECT * FROM outbox_relevamientos WHERE local_id=?').get(id);
const local = (r, id = 'case1') => r.sql.prepare('SELECT * FROM local_relevamientos WHERE local_id=?').get(id);
const payloadOf = (r, id = 'case1') => JSON.parse(row(r, id).payload_json);
const attachment = key => ({key, fileName: `${key}.jpg`, uri: `file:///${key}.jpg`, size: 100, scope: 'globales', field_id: key});
const pasadas = async (r, count, step = 10 * MIN) => {
  for (let i = 0; i < count; i += 1) {
    r.setNow(T0 + i * step);
    await r.service.syncPendingOperations();
  }
};
const proximo = (r, desde = T0, id = 'case1') => Date.parse(row(r, id).next_retry_at) - desde;
const plano = (valor) => JSON.parse(JSON.stringify(valor));

// P4: pausa por code, con y sin back nuevo.
test('409 con code PAUSADO (sin pausado) queda en la cola sin consumir reintentos', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(409, {detail: 'El relevamiento está pausado: obra', code: 'PAUSADO'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 0);
  assert.equal(row(r).last_error_code, 'RELEVAMIENTO_PAUSADO'); assert.equal(proximo(r), 5 * MIN);
});

// Sin «pausad» en el texto: solo el code dice que es una pausa.
test('409 con code PAUSADO y un detail que no dice «pausado» sigue siendo pausa', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(409, {detail: 'El coordinador detuvo la carga.', code: 'PAUSADO'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 0);
  assert.equal(row(r).last_error_code, 'RELEVAMIENTO_PAUSADO'); assert.equal(proximo(r), 5 * MIN);
});

test('400 con pausado:true y sin code es pausa y no ALTA_INVALIDA', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(400, {detail: 'Relevamiento pausado', pausado: true}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).last_error_code, 'RELEVAMIENTO_PAUSADO');
  assert.equal(row(r).retry_count, 0);
});

test('back viejo: 409 con el texto de gracia y sin code sigue siendo GRACIA_VENCIDA', async () => {
  const r = await setup(); await enqueue(r);
  r.setFetch(async () => response(409, {detail: 'El relevamiento cerró hace más de 24 horas y ya no acepta cargas.'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'GRACIA_VENCIDA');
});

// Back viejo (PRD, campo.py evaluar_captura): la pausa y la captura del futuro llegan con
// el mismo 400 que un fuera de período genuino, sin `pausado` ni `code`. Cuerpo real:
const FUERA_DE_PERIODO_VIEJO = {detail: 'La captura se realizó fuera del período asignado.'};
const cache = (r, cambios) => {
  const actual = JSON.parse(r.sql.prepare("SELECT payload_json FROM local_relevamientos WHERE local_id='remote_django_becas_1'").get().payload_json);
  r.sql.prepare("UPDATE local_relevamientos SET payload_json=? WHERE local_id='remote_django_becas_1'").run(JSON.stringify({...actual, ...cambios}));
};

test('back viejo: 400 de fuera de período con la captura dentro del período espera como una pausa', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(400, FUERA_DE_PERIODO_VIEJO));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 0);
  assert.equal(row(r).last_error_code, 'RELEVAMIENTO_PAUSADO'); assert.equal(proximo(r), 5 * MIN);
  assert.match(row(r).last_error, /se reintenta sola/i);
  await pasadas(r, 12, 6 * MIN);
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 0);
  // Reanudado (o el reloj del back alcanzó al del teléfono): entra.
  r.setFetch(async () => response(201, {id: 99}));
  r.setNow(T0 + 2 * 60 * MIN); await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'SYNCED');
});

test('back viejo: 400 de fuera de período con la captura fuera del período es ALTA_INVALIDA', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setPeriod('2026-10-09T00:00:00-03:00', '2099-12-31T23:59:59-03:00');
  r.setFetch(async () => response(400, FUERA_DE_PERIODO_VIEJO));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'ALTA_INVALIDA');
});

test('back viejo: captura posterior al cierre, con la gracia vigente, sigue siendo ALTA_INVALIDA', async () => {
  // Cerró el 2026-10-08 a las 10:00 (-03) y la captura es de las 12:00: la gracia sigue,
  // pero está fuera del período, así que no debe esperar en la cola.
  const r = await setup(); r.setNow('2026-10-08T16:00:00Z'); await enqueue(r);
  r.setPeriod('2026-10-01T00:00:00-03:00', '2026-10-08T10:00:00-03:00');
  r.setFetch(async () => response(400, FUERA_DE_PERIODO_VIEJO));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'ALTA_INVALIDA');
});

test('back viejo: dentro del período espera hasta la gracia; vencida, requiere atención', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  // Gracia hasta 2026-10-10 15:00Z; T0 es 12:00Z.
  r.setPeriod('2026-10-01T00:00:00-03:00', '2026-10-09T12:00:00-03:00');
  r.setFetch(async () => response(400, FUERA_DE_PERIODO_VIEJO));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).last_error_code, 'RELEVAMIENTO_PAUSADO');
  r.setNow(T0 + 4 * 60 * MIN); await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'GRACIA_VENCIDA');
  assert.match(row(r).last_error, /más de 24 horas/);
  // «Reintentar fallidas» no la devuelve a la cola: queda para que decida el coordinador.
  await r.service.retryFailedOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT');
});

test('back viejo: con pausado en caché espera aunque la captura caiga fuera del período', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setPeriod('2026-10-09T00:00:00-03:00', '2099-12-31T23:59:59-03:00'); cache(r, {pausado: true});
  r.setFetch(async () => response(400, FUERA_DE_PERIODO_VIEJO));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).last_error_code, 'RELEVAMIENTO_PAUSADO');
});

test('el mismo texto con code (back nuevo) o sin el relevamiento en caché sigue siendo ALTA_INVALIDA', async () => {
  const conCode = await setup(); conCode.setNow(T0); await enqueue(conCode);
  conCode.setFetch(async () => response(400, {...FUERA_DE_PERIODO_VIEJO, code: 'FUERA_DE_PERIODO'}));
  await conCode.service.syncPendingOperations();
  assert.equal(row(conCode).status, 'FAILED_PERMANENT'); assert.equal(row(conCode).last_error_code, 'ALTA_INVALIDA');
  const sinCache = await setup(); sinCache.setNow(T0); await enqueue(sinCache, {relevamiento_id: 77});
  sinCache.setFetch(async () => response(400, FUERA_DE_PERIODO_VIEJO));
  await sinCache.service.syncPendingOperations();
  assert.equal(row(sinCache).status, 'FAILED_PERMANENT'); assert.equal(row(sinCache).last_error_code, 'ALTA_INVALIDA');
});

test('el code y pausado del back no aparecen en el texto del error', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(400, {dni: ['Ya existe un caso con este DNI.'], code: 'VALIDACION'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).last_error_code, 'ALTA_INVALIDA');
  assert.equal(row(r).last_error, 'dni: Ya existe un caso con este DNI.');
  const {apiErrorMessage} = r.load('./formularioSync');
  assert.equal(apiErrorMessage({campo: ['Inválido'], code: 'X', pausado: false}), 'campo: Inválido');
  assert.equal(apiErrorMessage({code: 'X'}, 'Error de sincronización'), 'Error de sincronización');
});

test('404: «Relevamiento reasignado o inexistente», la carga se conserva y se puede exportar', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(404, {detail: 'No encontrado.'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'RELEVAMIENTO_NO_DISPONIBLE');
  assert.equal(row(r).last_error, 'Relevamiento reasignado o inexistente');
  const exportado = JSON.parse(await r.service.exportFailedOperation('case1'));
  assert.equal(exportado.operation.payload.datos_identificacion.dni, '12345678');
});

test('400 de finalizar con code RELEVAMIENTO_NO_EN_CURSO queda fallida con ese code', async () => {
  const r = await setup(); await enqueue(r, {}, 'finalizar_relevamiento', 'finish');
  r.setFetch(async () => response(400, {detail: 'No está en curso', code: 'RELEVAMIENTO_NO_EN_CURSO'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r, 'finish').status, 'FAILED_PERMANENT'); assert.equal(row(r, 'finish').last_error_code, 'RELEVAMIENTO_NO_EN_CURSO');
});

// P2: 5xx y red durante la gracia.
const fallas = {
  '5xx': async () => response(503, {detail: 'Servicio caído'}),
  'red': async () => { throw new TypeError('Network request failed'); },
};
for (const [nombre, handler] of Object.entries(fallas)) {
  test(`${nombre} x9 dentro de la gracia sigue PENDING, cada 5 min y con el contador topeado`, async () => {
    const r = await setup(); await enqueue(r); r.setFetch(handler);
    await pasadas(r, 9);
    assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 8); assert.equal(proximo(r, T0 + 8 * 10 * MIN), 5 * MIN);
    await pasadas(r, 3, 6 * MIN);
    assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 8);
  });

  test(`${nombre} agotado fuera de la gracia pasa a FAILED_PERMANENT`, async () => {
    const r = await setup(); await enqueue(r); r.setFetch(handler);
    r.setPeriod('2020-01-01T00:00:00-03:00', '2020-01-02T00:00:00-03:00');
    await pasadas(r, 9);
    assert.equal(row(r).status, 'FAILED_PERMANENT');
  });
}

test('sin el relevamiento en caché un 5xx agotado no se pierde', async () => {
  const r = await setup(); await enqueue(r, {relevamiento_id: 77}); r.setFetch(fallas['5xx']);
  await pasadas(r, 9);
  assert.equal(row(r).status, 'PENDING');
});

test('un 5xx de iniciar/finalizar dentro de la gracia tampoco se pierde', async () => {
  const r = await setup(); await enqueue(r, {}, 'finalizar_relevamiento', 'finish'); r.setFetch(fallas['5xx']);
  await pasadas(r, 10);
  assert.equal(row(r, 'finish').status, 'PENDING');
});

// P3: 403 y 429.
test('403 pausa la cola como el 401: SIN_ACCESO, sin reintentos, sin tocar la sesión ni la segunda op', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r); await enqueue(r, {}, 'insert_relevamiento', 'case2');
  let calls = 0; r.setFetch(async () => {calls++; return response(403, {detail: 'No tiene permiso para realizar esta acción.'});});
  const result = await r.service.syncPendingOperations();
  assert.equal(calls, 1);
  const afectada = [row(r), row(r, 'case2')].filter(item => item.last_error_code === 'SIN_ACCESO');
  assert.equal(afectada.length, 1); assert.equal(afectada[0].status, 'PENDING'); assert.equal(afectada[0].retry_count, 0);
  assert.equal(Date.parse(afectada[0].next_retry_at) - T0, 5 * MIN);
  assert.match(afectada[0].last_error, /no tiene acceso a la app de campo/);
  assert.equal(result.errors[0].code, 'SIN_ACCESO');
  assert.equal(r.values.get('becas_auth_token'), 'old-token');
});

test('403 al subir un adjunto no lo marca REJECTED: vuelve a la cola', async () => {
  const r = await setup(); await enqueue(r, {remote_formulario_id: 99, adjuntos_formulario: [attachment('one')]});
  r.setFetch(async () => response(403, {detail: 'No tiene permiso'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).last_error_code, 'SIN_ACCESO');
  assert.deepEqual(plano(payloadOf(r).attachment_results || {}), {});
});

test('429 respeta Retry-After en segundos y no consume reintentos', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(429, {detail: 'Demasiadas solicitudes'}, {'Retry-After': '120'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 0); assert.equal(proximo(r), 120 * 1000);
});

test('429 con Retry-After como fecha HTTP', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(429, {}, {'Retry-After': new Date(T0 + 90 * 1000).toUTCString()}));
  await r.service.syncPendingOperations();
  assert.equal(proximo(r), 90 * 1000);
});

test('429 sin Retry-After reintenta a los 5 minutos', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(429, {detail: 'Demasiadas solicitudes'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 0); assert.equal(proximo(r), 5 * MIN);
});

// P4: CLIENT_UUID_EN_USO.
test('CLIENT_UUID_EN_USO genera un uuid nuevo, lo guarda en outbox y local y reintenta enseguida', async () => {
  const r = await setup(); await enqueue(r); const bodies = [];
  r.setFetch(async (url, options) => {
    bodies.push(JSON.parse(options.body).client_uuid);
    return bodies.length === 1 ? response(409, {detail: 'El identificador de la carga ya está en uso.', code: 'CLIENT_UUID_EN_USO'})
      : response(201, {id: 99});
  });
  await r.service.syncPendingOperations();
  assert.equal(bodies.length, 2); assert.equal(bodies[0], UUID); assert.notEqual(bodies[1], UUID);
  const value = payloadOf(r);
  assert.equal(value.client_uuid, bodies[1]); assert.equal(value.client_uid, bodies[1]); assert.equal(value.uuid_regenerado, true);
  assert.equal(local(r).client_uuid, bodies[1]); assert.equal(JSON.parse(local(r).payload_json).client_uuid, bodies[1]);
  assert.equal(row(r).status, 'SYNCED'); assert.equal(row(r).retry_count, 0);
});

test('CLIENT_UUID_EN_USO por segunda vez es FAILED_PERMANENT; el reintento manual da otra regeneración', async () => {
  const r = await setup(); await enqueue(r); let calls = 0;
  r.setFetch(async () => {calls++; return response(409, {detail: 'En uso', code: 'CLIENT_UUID_EN_USO'});});
  await r.service.syncPendingOperations();
  assert.equal(calls, 2); assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'CLIENT_UUID_EN_USO');
  await r.service.retryFailedOperations();
  assert.equal(calls, 4); assert.equal(row(r).status, 'FAILED_PERMANENT');
});

// P11: uuid de baja entropía de la migración.
test('P11 regenera solo la carga migrada que nunca se intentó enviar', async () => {
  const r = await setup();
  const derivar = (seed) => {
    let hex = '';
    for (let i = 0; i < seed.length; i += 1) hex += (seed.charCodeAt(i) % 16).toString(16);
    const p = (hex + '0123456789abcdef0123456789abcdef').slice(0, 32);
    return `${p.slice(0, 8)}-${p.slice(8, 12)}-4${p.slice(13, 16)}-a${p.slice(17, 20)}-${p.slice(20, 32)}`;
  };
  for (const id of ['mig_nueva', 'mig_reintento', 'mig_error', 'mig_remota']) {
    await enqueue(r, {client_uuid: derivar(id), ...(id === 'mig_remota' ? {remote_formulario_id: 5} : {})}, 'insert_relevamiento', id);
  }
  await enqueue(r, {client_uuid: UUID}, 'insert_relevamiento', 'propia');
  r.sql.prepare("UPDATE outbox_relevamientos SET retry_count=2 WHERE local_id='mig_reintento'").run();
  r.sql.prepare("UPDATE outbox_relevamientos SET last_error='x' WHERE local_id='mig_error'").run();
  r.sql.prepare("DELETE FROM sync_metadata WHERE key LIKE 'client_uuid_baja%'").run();
  const db = {
    getAllAsync: async (q, ...a) => r.sql.prepare(q).all(...a), getFirstAsync: async (q, ...a) => r.sql.prepare(q).get(...a),
    runAsync: async (q, ...a) => r.sql.prepare(q).run(...a),
    withTransactionAsync: async (task) => { r.sql.exec('BEGIN'); try { await task(db); r.sql.exec('COMMIT'); } catch (e) { r.sql.exec('ROLLBACK'); throw e; } },
  };
  const regenerar = r.load('./relevamientoService').regenerarUuidsMigradosNuncaEnviados;
  assert.equal(await regenerar(db), 1);
  const nuevo = payloadOf(r, 'mig_nueva').client_uuid;
  assert.notEqual(nuevo, derivar('mig_nueva')); assert.equal(payloadOf(r, 'mig_nueva').client_uid, nuevo);
  assert.equal(local(r, 'mig_nueva').client_uuid, nuevo); assert.equal(JSON.parse(local(r, 'mig_nueva').payload_json).client_uuid, nuevo);
  for (const id of ['mig_reintento', 'mig_error', 'mig_remota']) assert.equal(payloadOf(r, id).client_uuid, derivar(id));
  assert.equal(payloadOf(r, 'propia').client_uuid, UUID);
  assert.equal(await regenerar(db), 0);
});

// P14 y P1.
test('restaurar una captura descartada la devuelve a la cola y la sincroniza', async () => {
  const r = await setup(); await enqueue(r);
  r.sql.prepare("UPDATE outbox_relevamientos SET status='DISCARDED', retry_count=3, last_error='x', last_error_code='ALTA_INVALIDA'").run();
  r.sql.prepare("UPDATE local_relevamientos SET sync_estado='DESCARTADO' WHERE local_id='case1'").run();
  assert.equal((await r.service.getDiscardedOperations(1)).length, 1);
  assert.equal((await r.service.getDiscardedOperations(2)).length, 0);
  r.setFetch(async () => response(201, {id: 99}));
  const result = await r.service.restoreDiscardedOperation('case1');
  assert.equal(result.restored, 'case1'); assert.equal(row(r).status, 'SYNCED'); assert.equal(row(r).retry_count, 0);
  assert.equal(local(r).sync_estado, 'SINCRONIZADO');
  await assert.rejects(r.service.restoreDiscardedOperation('case1'), /descartada/);
});

test('un relevamiento vencido que sale del listado con descartadas conserva su caché y sigue visible', async () => {
  const r = await setup(); await enqueue(r);
  r.setPeriod('2020-01-01T00:00:00-03:00', '2020-01-02T00:00:00-03:00');
  r.sql.prepare("UPDATE outbox_relevamientos SET status='DISCARDED'").run();
  r.setFetch(async () => response(200, {results: []}));
  const result = await r.service.getRelevamientos();
  assert.ok(r.sql.prepare("SELECT 1 FROM local_relevamientos WHERE local_id='remote_django_becas_1'").get());
  const retenido = result.records.find(item => String(item.id) === '1');
  assert.ok(retenido);
  // Una descartada no es un envío pendiente, pero deja el relevamiento en la lista.
  assert.equal(retenido.has_pending_operations, false);
  assert.equal(retenido.has_discarded_operations, true);
  assert.equal(r.dates.isAssignmentVisible(retenido), true);
  assert.equal((await r.service.getDiscardedOperations(1)).length, 1);
});

test('un relevamiento vencido que el back sigue listando se ve solo mientras tenga descartadas', async () => {
  const r = await setup(); await enqueue(r);
  r.setPeriod('2020-01-01T00:00:00-03:00', '2020-01-02T00:00:00-03:00');
  r.sql.prepare("UPDATE outbox_relevamientos SET status='DISCARDED'").run();
  const remoto = {id: 1, nombre: 'Uno', estado: 'finalizado', fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2020-01-02T00:00:00-03:00'};
  r.setFetch(async url => response(200, /\/relevamientos\/(\?|$)/.test(String(url)) ? {results: [remoto]} : remoto));
  const conDescartadas = (await r.service.getRelevamientos()).records.find(item => String(item.id) === '1');
  assert.equal(conDescartadas.has_discarded_operations, true);
  assert.equal(r.dates.isAssignmentVisible(conDescartadas), true);
  r.sql.prepare('DELETE FROM outbox_relevamientos').run();
  const sinDescartadas = (await r.service.getRelevamientos()).records.find(item => String(item.id) === '1');
  assert.equal(sinDescartadas.has_discarded_operations, false);
  assert.equal(r.dates.isAssignmentVisible(sinDescartadas), false);
});

test('restaurar respeta al dueño de la captura', async () => {
  const r = await setup(); await enqueue(r, {_owner_user_id: '8'});
  r.sql.prepare("UPDATE outbox_relevamientos SET status='DISCARDED'").run();
  assert.equal((await r.service.getDiscardedOperations()).length, 0);
  await assert.rejects(r.service.restoreDiscardedOperation('case1'), /usuario actual/);
});

test('reemplazar un adjunto rechazado sube el archivo nuevo y deja el caso SYNCED', async () => {
  const r = await setup(); await enqueue(r, {remote_formulario_id: 99, adjuntos_formulario: [attachment('one'), attachment('two')]});
  const subidos = [];
  r.setFetch(async (url, options) => {
    const archivo = options.body.fields.find(([campo]) => campo === 'archivo')?.[1];
    subidos.push(archivo?.name);
    return subidos.length === 1 ? response(400, {archivo: ['Formato inválido']}) : response(201, {id: 2});
  });
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'FAILED_PERMANENT'); assert.equal(row(r).last_error_code, 'ADJUNTOS_RECHAZADOS');
  await assert.rejects(r.service.replaceRejectedAttachment('case1', 'two', {uri: 'file:///x.jpg', fileName: 'x.jpg', size: 100}), /rechazado/);
  await assert.rejects(r.service.replaceRejectedAttachment('case1', 'one', {uri: 'file:///x.docx', fileName: 'x.docx', size: 100}), /JPG/);
  const result = await r.service.replaceRejectedAttachment('case1', 'one', {uri: 'file:///nuevo.jpg', fileName: 'nuevo.jpg', mimeType: 'image/jpeg', size: 100});
  assert.equal(result.success, true); assert.equal(row(r).status, 'SYNCED');
  assert.equal(subidos.length, 3); assert.match(subidos[2], /nuevo\.jpg$/);
  const value = payloadOf(r);
  assert.equal(value.remote_formulario_id, 99); assert.deepEqual(plano(value.attachment_results), {});
  assert.deepEqual(plano(value.uploaded_attachment_keys).sort(), ['one', 'two']);
  assert.equal(value.adjuntos_formulario[0].key, 'one'); assert.equal(value.adjuntos_formulario[0].field_id, 'one');
  assert.equal(local(r).sync_estado, 'SINCRONIZADO');
});

// P6, P13, P5.
test('iniciar/finalizar/reabrir usan el estado del 200, con el forzado de siempre como respaldo', async () => {
  const r = await setup();
  const fila = (extra) => ({id: 1, fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-12-31T23:59:59-03:00', ...extra});
  r.setFetch(async () => response(200, fila({estado: 'EN_REVISION'})));
  assert.equal((await r.service.reabrirRelevamiento(1)).estado, 'EN_REVISION');
  r.setFetch(async () => response(200, fila({estado: 'TERMINADO'})));
  assert.equal((await r.service.finalizarRelevamiento(1)).estado, 'TERMINADO');
  r.setFetch(async () => response(200, fila({estado: 'RARO'})));
  assert.equal((await r.service.reabrirRelevamiento(1)).estado, 'EN_CURSO');
  assert.equal((await r.service.finalizarRelevamiento(1)).estado, 'FINALIZADO');
  r.setFetch(async () => response(200, fila({})));
  assert.equal((await r.service.iniciarRelevamiento(1)).estado, 'EN_CURSO');
});

test('un FINALIZANDO del back sin finalizar en cola se entrega como FINALIZADO', async () => {
  const r = await setup();
  r.setFetch(async () => response(200, {id: 1, nombre: 'C', estado: 'FINALIZANDO', definicion_formulario: {version: 3}}));
  assert.equal((await r.service.getRelevamientoDetail(1)).detail.estado, 'FINALIZADO');
  r.setFetch(async (url) => response(200, url.endsWith('/1/') ? {id: 1, nombre: 'C', estado: 'FINALIZANDO', definicion_formulario: {version: 3}}
    : [{id: 1, nombre: 'C', estado: 'FINALIZANDO'}]));
  assert.equal((await r.service.getRelevamientos()).records.find(item => item.id === 1).estado, 'FINALIZADO');
  await enqueue(r, {}, 'finalizar_relevamiento', 'finish');
  r.setOnline(false);
  assert.equal((await r.service.getRelevamientoDetail(1)).detail.estado, 'FINALIZANDO');
  const {normalizarEstadoRelevamiento} = r.load('./relevamientoService');
  assert.equal(normalizarEstadoRelevamiento({id: 1, estado: 'FINALIZANDO'}, new Set(['1'])).estado, 'FINALIZANDO');
  assert.equal(normalizarEstadoRelevamiento({id: 1, estado: 'FINALIZANDO'}).estado, 'FINALIZADO');
  assert.equal(normalizarEstadoRelevamiento({id: 1, estado: 'EN_CURSO'}).estado, 'EN_CURSO');
});

test('el cupo es null cuando el back viejo no lo informa', async () => {
  const r = await setup();
  r.setFetch(async () => response(200, {id: 1, nombre: 'C', estado: 'EN_CURSO', definicion_formulario: {version: 3}}));
  const viejo = (await r.service.getRelevamientoDetail(1)).detail;
  assert.equal(viejo.cupo_disponible, null); assert.equal(viejo.cupo_completo, null);
  r.setFetch(async () => response(200, {id: 1, nombre: 'C', estado: 'EN_CURSO', cupo_disponible: 0, cupo_completo: true, definicion_formulario: {version: 3}}));
  const nuevo = (await r.service.getRelevamientoDetail(1)).detail;
  assert.equal(nuevo.cupo_disponible, 0); assert.equal(nuevo.cupo_completo, true);
});

test('el cupo informado descuenta las cargas locales sin enviar', async () => {
  const r = await setup(); r.setOnline(false);
  const base = {relevamiento_id: 1, datos_identificacion: {dni: '1'}};
  await enqueue(r, {}, 'insert_relevamiento', 'sin_enviar');
  await enqueue(r, {remote_formulario_id: 5}, 'insert_relevamiento', 'ya_en_servidor');
  assert.equal(await r.service.countUnsentFormularios(1), 1);
  assert.equal(await r.service.countUnsentFormularios(1, 'sin_enviar'), 0);
  await assert.rejects(r.service.saveBecasFormulario({...base, _cupo_maximo: 5, _cupo_disponible: 1}), /cupo/);
  await assert.rejects(r.service.saveBecasFormulario({...base, _cupo_completo: true}), /cupo/);
  assert.equal((await r.service.saveBecasFormulario({...base, _cupo_maximo: 5, _cupo_disponible: 2})).success, true);
  await assert.rejects(r.service.saveBecasFormulario({...base, _cupo_maximo: 5, _cupo_disponible: 2}), /cupo/);
});

test('sin datos de cupo del servidor vale el cálculo local de siempre', async () => {
  const r = await setup(); r.setOnline(false);
  const base = {relevamiento_id: 1, _cupo_maximo: 1, datos_identificacion: {dni: '1'}};
  await r.service.saveBecasFormulario(base);
  await assert.rejects(r.service.saveBecasFormulario(base), /cupo/);
});

test('evaluarDniDuplicado: bloquea con locales y ENVIADO/APROBADO, avisa con RECHAZADO/BAJA', async () => {
  const r = await setup();
  const casos = (...estados) => estados.map(([dni, estado], i) => ({id: 10 + i, ciudadano_dni: dni, estado}));
  const evaluar = async (remotos, dni, exclude) => {
    r.setFetch(async () => response(200, remotos));
    return r.service.evaluarDniDuplicado(1, dni, exclude);
  };
  assert.deepEqual(plano(await evaluar(casos(['111', 'APROBADO']), '111')), {bloquear: true, avisar: false, estado: 'APROBADO'});
  assert.equal((await evaluar(casos(['111', 'ENVIADO']), '111')).bloquear, true);
  assert.deepEqual(plano(await evaluar(casos(['111', 'RECHAZADO']), '111')), {bloquear: false, avisar: true, estado: 'RECHAZADO'});
  assert.equal((await evaluar(casos(['111', 'BAJA']), '111')).avisar, true);
  assert.equal((await evaluar(casos(['111', 'BAJA'], ['111', 'ENVIADO']), '111')).bloquear, true);
  assert.equal((await evaluar(casos(['111', 'RARO']), '111')).bloquear, true);
  assert.equal((await evaluar(casos(['111', null]), '111')).bloquear, true);
  assert.deepEqual(plano(await evaluar(casos(['222', 'APROBADO']), '111')), {bloquear: false, avisar: false, estado: null});
  await enqueue(r, {datos_identificacion: {dni: '333'}});
  assert.equal((await evaluar([], '333')).bloquear, true);
  assert.equal((await evaluar([], '333', 'case1')).bloquear, false);
  r.sql.prepare("UPDATE local_relevamientos SET sync_estado='DESCARTADO' WHERE local_id='case1'").run();
  assert.equal((await evaluar([], '333')).bloquear, false);
  assert.equal(await r.service.dniYaRelevado(1, '111'), false);
});

// P16: reloj.
test('un header Date adelantado corrige el reloj y la hora de las acciones encoladas', async () => {
  const r = await setup(); r.setNow(T0); r.setOnline(false);
  const reloj = r.load('./reloj');
  assert.equal(reloj.desfaseMs(), 0);
  r.setOnline(true);
  r.setFetch(async () => response(200, [], {Date: new Date(T0 + 10 * MIN).toUTCString()}));
  await r.api.becasRequest('/api/becas/relevamientos/');
  assert.equal(reloj.desfaseMs(), 10 * MIN); assert.equal(reloj.ahoraCorregido().getTime(), T0 + 10 * MIN);
  assert.equal(r.values.get('reloj_desfase_ms'), String(10 * MIN));
  r.setOnline(false);
  await r.service.iniciarRelevamiento(1);
  assert.equal(payloadOf(r, 'action_iniciar_relevamiento_1').capturado_en, new Date(T0 + 10 * MIN).toISOString());
});

test('también se registra la hora en respuestas de error y de subida', async () => {
  const r = await setup(); r.setNow(T0); const reloj = r.load('./reloj');
  r.setFetch(async () => response(500, {detail: 'x'}, {Date: new Date(T0 - 5 * MIN).toUTCString()}));
  await assert.rejects(r.api.becasRequest('/api/becas/relevamientos/'));
  assert.equal(reloj.desfaseMs(), -5 * MIN);
  r.setFetch(async () => response(201, {}, {Date: new Date(T0 + 3 * MIN).toUTCString()}));
  await r.api.becasUploadFile('/api/becas/formularios/1/adjuntos/', {fileUri: 'file:///a.jpg'});
  assert.equal(reloj.desfaseMs(), 3 * MIN);
});

test('sin header Date, con header inválido o con desfase chico no hay corrección', async () => {
  const r = await setup(); r.setNow(T0); const reloj = r.load('./reloj');
  for (const headers of [{}, {Date: 'no es una fecha'}, {Date: new Date(T0 + 30 * 1000).toUTCString()}]) {
    r.setFetch(async () => response(200, [], headers));
    await r.api.becasRequest('/api/becas/relevamientos/');
    assert.equal(reloj.desfaseMs(), 0);
  }
  r.setOnline(false);
  await r.service.iniciarRelevamiento(1);
  assert.equal(payloadOf(r, 'action_iniciar_relevamiento_1').capturado_en, new Date(T0).toISOString());
});

// P15: login y versión.
const login = (r, payload) => {
  r.setFetch(async (url) => url.endsWith('/auth/token/') ? response(200, {token: 'nuevo', user_id: 9, username: 'ana', ...payload}) : response(200, {}));
  return r.api.loginBecas({username: 'ana', password: 'x'});
};

test('login con módulos sin becas se rechaza y no guarda token ni usuario', async () => {
  const r = await setup();
  await assert.rejects(login(r, {modulos: ['dispositivos']}), (error) => error.code === 'SIN_MODULO_BECAS'
    && error.message === 'Tu usuario no tiene acceso a Becas en la app.');
  assert.equal(r.values.get('becas_auth_token'), 'old-token'); assert.equal(r.values.get('user_data'), JSON.stringify({id: 7}));
  await assert.rejects(login(r, {modulos: []}), (error) => error.code === 'SIN_MODULO_BECAS');
});

test('login sin módulos (back viejo) o con becas entra y guarda módulos y versión mínima', async () => {
  const r = await setup();
  const viejo = await login(r, {});
  assert.equal(viejo.modulos, null); assert.equal(viejo.version_minima, null); assert.equal(r.values.get('becas_auth_token'), 'nuevo');
  const nuevo = await login(r, {modulos: ['becas', 'dispositivos'], app: {version_minima: '1.2.0'}});
  assert.deepEqual(plano(nuevo.modulos), ['becas', 'dispositivos']); assert.equal(nuevo.version_minima, '1.2.0');
  assert.equal(JSON.parse(r.values.get('user_data')).version_minima, '1.2.0');
});

test('requiereActualizacionGuardada compara la versión mínima guardada con la de la app', async () => {
  const r = await setup(); const version = r.load('./versionApp');
  assert.equal(await version.requiereActualizacionGuardada(), false);
  await login(r, {modulos: ['becas'], app: {version_minima: '9.0.0'}});
  assert.equal(version.versionActual(), '1.1.2');
  assert.equal(await version.requiereActualizacionGuardada(), true);
  r.setAppVersion('9.0.0'); assert.equal(await version.requiereActualizacionGuardada(), false);
  r.setAppVersion('10.0.1'); assert.equal(await version.requiereActualizacionGuardada(), false);
});

test('compararVersiones tolera partes faltantes y sufijos; una versión mínima inválida no bloquea', async () => {
  const r = await setup(); const version = r.load('./versionApp');
  assert.equal(version.compararVersiones('1.2.3', '1.10.0'), -1);
  assert.equal(version.compararVersiones('2.0.0', '1.99.99'), 1);
  assert.equal(version.compararVersiones('1.2', '1.2.0'), 0);
  assert.equal(version.compararVersiones('1.2.3-beta.1', '1.2.3'), 0);
  assert.equal(version.compararVersiones('v1.2.4+7', '1.2.3'), 1);
  for (const invalida of [null, undefined, '', 'basura']) assert.equal(version.requiereActualizacion(invalida), false);
  assert.equal(version.requiereActualizacion('1.1.3'), true); assert.equal(version.requiereActualizacion('1.1.2'), false);
});

// Revisión: errores de red de Safari/iOS, cupo viejo, 403 del WAF, descartadas y reemplazo.
for (const msg of ['Load failed', 'The Internet connection appears to be offline.']) {
  test(`Safari/iOS "${msg}" en el alta queda PENDING y dentro de la gracia no pasa a FAILED_PERMANENT`, async () => {
    const r = await setup('web'); await enqueue(r);
    r.setFetch(async () => { throw new TypeError(msg); });
    r.setNow(T0); await r.service.syncPendingOperations();
    assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 1);
    await pasadas(r, 12);
    assert.equal(row(r).status, 'PENDING');
  });

  test(`Safari/iOS "${msg}" al subir un adjunto vuelve a la cola`, async () => {
    const r = await setup(); await enqueue(r, {remote_formulario_id: 99, adjuntos_formulario: [attachment('one')]});
    r.setFetch(async () => { throw new TypeError(msg); });
    r.setNow(T0); await r.service.syncPendingOperations();
    assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).last_error_code, 'ERROR_ATTACHMENTS_UPLOAD');
    await pasadas(r, 12);
    assert.equal(row(r).status, 'PENDING');
    assert.deepEqual(plano(payloadOf(r).attachment_results || {}), {});
  });
}

test('403 con la página HTML del WAF no es SIN_ACCESO: espera 5 min sin consumir reintentos', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r);
  r.setFetch(async () => response(403, {detail: '<!DOCTYPE html><html>Blocked</html>'}, {'content-type': 'text/html'}));
  await r.service.syncPendingOperations();
  assert.equal(row(r).status, 'PENDING'); assert.equal(row(r).retry_count, 0);
  assert.notEqual(row(r).last_error_code, 'SIN_ACCESO'); assert.equal(proximo(r), 5 * MIN);
});

test('cupo: el disponible viejo del detalle no deja cargar de más si la alta ya está SYNCED', async () => {
  const r = await setup(); r.setOnline(false);
  await enqueue(r, {remote_formulario_id: 99}, 'insert_relevamiento', 'A');
  r.sql.prepare("UPDATE outbox_relevamientos SET status='SYNCED' WHERE local_id='A'").run();
  const base = {relevamiento_id: 1, datos_identificacion: {dni: '2'}, _cupo_maximo: 1};
  await assert.rejects(r.service.saveBecasFormulario({...base, _cupo_disponible: 1, _cupo_completo: false}), /cupo/);
  const detalle = {cupo_maximo: 1, cupo_disponible: 1, cupo_completo: false};
  assert.equal(r.definition.cupoCompleto(detalle, 1, 0), true);
  assert.equal(r.definition.cupoCompleto(detalle, 0, 0), false);
});

test('cupo: un detalle de la versión anterior (disponible 0, completo false) usa el cálculo viejo', async () => {
  const r = await setup(); r.setOnline(false);
  const viejo = {cupo_maximo: 2, cupo_disponible: 0, cupo_completo: false};
  assert.equal(r.definition.cupoDisponibleConfiable(viejo), null);
  assert.equal(r.definition.cupoCompleto(viejo, 1, 0), false);
  assert.equal(r.definition.cupoCompleto(viejo, 2, 0), true);
  assert.equal(r.definition.cupoCompleto({...viejo, cupo_completo: true}, 0, 0), true);
  assert.equal(r.definition.cupoDisponibleConfiable({cupo_disponible: 3, cupo_completo: false}), 3);
  const res = await r.service.saveBecasFormulario({relevamiento_id: 1, datos_identificacion: {dni: '2'}, _cupo_maximo: 2, _cupo_disponible: 0, _cupo_completo: false});
  assert.equal(res.success, true);
});

test('descartadas: solo altas; restaurar rechaza otros tipos', async () => {
  const r = await setup(); await enqueue(r, {}, 'finalizar_relevamiento', 'finish');
  r.sql.prepare("UPDATE outbox_relevamientos SET status='DISCARDED'").run();
  assert.equal((await r.service.getDiscardedOperations(1)).length, 0);
  await assert.rejects(r.service.restoreDiscardedOperation('finish'), /descartada/);
  assert.equal(row(r, 'finish').status, 'DISCARDED');
});

test('reemplazar un adjunto de una operación que ya no está fallida falla sin tocar la tabla local', async () => {
  const r = await setup(); await enqueue(r, {remote_formulario_id: 99, adjuntos_formulario: [attachment('one')],
    attachment_results: {one: {status: 'REJECTED', code: 'x', message: 'm'}}});
  r.sql.prepare("UPDATE outbox_relevamientos SET status='FAILED_PERMANENT'").run();
  const antes = local(r).payload_json;
  // Otro camino la toma entre la lectura y el UPDATE: el outbox ya no cumple status = FAILED_PERMANENT.
  const original = r.service.getFailedOperation;
  r.service.getFailedOperation = async (id) => { const op = await original.call(r.service, id);
    r.sql.prepare("UPDATE outbox_relevamientos SET status='PENDING'").run(); return op; };
  await assert.rejects(r.service.replaceRejectedAttachment('case1', 'one', {uri: 'file:///n.jpg', fileName: 'n.jpg', mimeType: 'image/jpeg', size: 100}), /ya no está fallida/);
  assert.equal(local(r).payload_json, antes); assert.equal(row(r).status, 'PENDING');
});

// Sincronización manual: forzar la subida salta el backoff; la automática lo respeta.
const enEspera = (r, id = 'case1', minutos = 5) => r.sql.prepare('UPDATE outbox_relevamientos SET next_retry_at=? WHERE local_id=?')
  .run(new Date(T0 + minutos * MIN).toISOString(), id);
const contador = (r) => { const c = {n: 0}; r.setFetch(async () => { c.n++; return response(200, {id: 55}); }); return c; };

test('manual: una carga en backoff no sale con la automática y sí con retryFailedOperations', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r); enEspera(r);
  const c = contador(r);
  await r.service.syncPendingOperations();
  assert.equal(c.n, 0); assert.equal(row(r).status, 'PENDING');
  const result = await r.service.retryFailedOperations();
  assert.equal(c.n, 1); assert.equal(result.synced, 1);
  assert.notEqual(row(r)?.status, 'PENDING');
});

test('manual: si el back vuelve a pausar, la carga queda otra vez en espera tras un solo intento', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r); enEspera(r);
  let calls = 0; r.setFetch(async () => { calls++; return response(409, {detail: 'pausado', code: 'PAUSADO'}); });
  await r.service.retryFailedOperations();
  assert.equal(calls, 1); assert.equal(row(r).status, 'PENDING'); assert.equal(proximo(r), 5 * MIN);
});

test('manual: una carga de otro usuario en backoff no se toca', async () => {
  const r = await setup(); r.setNow(T0);
  await enqueue(r, {_owner_user_id: '999'}, 'insert_relevamiento', 'ajena'); enEspera(r, 'ajena');
  const antes = row(r, 'ajena').next_retry_at;
  const c = contador(r);
  await r.service.retryFailedOperations();
  assert.equal(c.n, 0); assert.equal(row(r, 'ajena').next_retry_at, antes);
});

test('manual: una carga IN_FLIGHT no se toca y una needsDecision no se reenvía', async () => {
  const r = await setup(); r.setNow(T0);
  await enqueue(r, {}, 'insert_relevamiento', 'vuelo'); enEspera(r, 'vuelo');
  r.sql.prepare("UPDATE outbox_relevamientos SET status='IN_FLIGHT', started_at=? WHERE local_id='vuelo'").run(new Date(T0).toISOString());
  await enqueue(r, {}, 'insert_relevamiento', 'invalida');
  r.sql.prepare("UPDATE outbox_relevamientos SET status='FAILED_PERMANENT', last_error_code='ALTA_INVALIDA', last_error='x' WHERE local_id='invalida'").run();
  const c = contador(r);
  await r.service.retryFailedOperations();
  assert.equal(row(r, 'invalida').status, 'FAILED_PERMANENT'); assert.equal(row(r, 'invalida').last_error_code, 'ALTA_INVALIDA');
  assert.ok(row(r, 'vuelo').next_retry_at);
  assert.equal(c.n, 0);
});

test('manual: si el back vuelve a pausar, waiting cuenta la carga y da el motivo de pausa', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r); enEspera(r);
  r.setFetch(async () => response(409, {detail: 'pausado', code: 'PAUSADO'}));
  const result = await r.service.retryFailedOperations();
  assert.equal(result.waiting, 1); assert.equal(result.waitingReason, 'el relevamiento está pausado');
});

test('manual: 429 da el motivo de espera del servidor', async () => {
  const r = await setup(); r.setNow(T0); await enqueue(r); enEspera(r);
  r.setFetch(async () => response(429, {detail: 'Demasiadas solicitudes'}));
  const result = await r.service.retryFailedOperations();
  assert.equal(result.waiting, 1); assert.equal(result.waitingReason, 'el servidor pidió esperar');
});

test('manual: con la cola vacía waiting es 0 y sin motivo; la carga de otro usuario no cuenta', async () => {
  const r = await setup(); r.setNow(T0);
  let result = await r.service.retryFailedOperations();
  assert.equal(result.waiting, 0); assert.equal(result.waitingReason, null);
  await enqueue(r, {_owner_user_id: '999'}, 'insert_relevamiento', 'ajena'); enEspera(r, 'ajena');
  r.sql.prepare("UPDATE outbox_relevamientos SET last_error='x', last_error_code='RELEVAMIENTO_PAUSADO' WHERE local_id='ajena'").run();
  result = await r.service.retryFailedOperations();
  assert.equal(result.waiting, 0); assert.equal(result.waitingReason, null);
});
