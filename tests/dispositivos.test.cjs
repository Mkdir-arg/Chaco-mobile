const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

// Módulo Dispositivos: caché de inspecciones y cola de envíos (contrato-app-dispositivos).
const T0 = Date.parse('2026-10-10T12:00:00Z');
const MIN = 60 * 1000;
const BASE = '/api/dispositivos/inspecciones/';

const FORMULARIO = {version: 10, definicion: {version: 10, items: [{tipo: 'grupo', clave: 'g1', items: [
  {tipo_item: 'campo', clave: 'cp-techo', tipo: 'SELECTOR', opciones: ['Bueno', 'Malo'], obligatorio: true},
  {tipo_item: 'campo', clave: 'cp-plano', tipo: 'ARCHIVO', opciones: [], obligatorio: true},
]}]}};
const detalle = (extra = {}) => ({id: 5, estado: 'ASIGNADA', formulario_version: 10, formulario: FORMULARIO, edificio: {id: 1}, fotos: [], ...extra});
const archivo = (nombre) => ({uri: `file:///cache/${nombre}`, fileName: nombre, mimeType: 'image/jpeg', size: 100});

// Registra cada pedido; `handler(call, calls)` contesta.
const router = (r, handler) => {
  const calls = [];
  r.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body};
    calls.push(call);
    return handler(call, calls);
  });
  return calls;
};
const campos = (call) => Object.fromEntries(call.body.fields.filter(([, valor]) => typeof valor === 'string'));
const archivoDe = (call) => call.body.fields.find(([clave]) => clave === 'archivo');
const escritos = (calls) => calls.filter((call) => call.method === 'POST');
const sufijo = (call) => call.url.replace(BASE, '').replace(/^\d+\//, '');

async function preparar({respuestas = {'cp-techo': 'Bueno'}, archivos = {'cp-plano': archivo('plano.pdf')},
  fotos = [{...archivo('fachada.jpg'), descripcion: 'Fachada'}], detalleCache = detalle()} = {}) {
  const r = await setup();
  r.setNow(T0);
  const d = r.load('./dispositivosService');
  router(r, async () => response(200, detalleCache));
  await d.getInspeccion(5);
  const enviar = (extra = {}) => d.enviarResultado(5, {criticidad: 'MEDIA', observaciones: 'Humedad', respuestas, archivos, fotos, ...extra}, {sincronizar: false});
  return {r, d, enviar};
}
const operacion = (r) => r.sql.prepare('SELECT * FROM outbox_dispositivos ORDER BY rowid DESC').get();
const payloadOf = (r) => JSON.parse(operacion(r).payload_json);
const OK_RESULTADO = (call) => response(200, detalle({estado: 'REALIZADA'}));
const OK_ARCHIVO = (call) => response(call.url.endsWith('fotos/') ? 201 : 201, {id: 1});

test('encola y envia en orden resultado, adjuntos y fotos con los bodies del contrato', async () => {
  const {r, d, enviar} = await preparar();
  const {envio} = await enviar();
  assert.equal(envio.estado, 'pendiente');
  assert.equal(await d.getPendingCount(), 1);
  const calls = router(r, async (call) => (sufijo(call) === 'resultado/' ? OK_RESULTADO(call) : OK_ARCHIVO(call)));
  const resultado = await d.syncPendientes();
  assert.equal(resultado.synced, 1);
  assert.deepEqual(escritos(calls).map(sufijo), ['resultado/', 'adjuntos/', 'fotos/']);
  const [res, adj, foto] = escritos(calls);
  const op = payloadOf(r);
  assert.deepEqual(JSON.parse(JSON.stringify(res.body)), {criticidad: 'MEDIA', observaciones: 'Humedad', uuid_cliente: op.uuid_cliente,
    version_capturada: 10, respuestas: {'cp-techo': 'Bueno', 'cp-plano': {archivo_adjunto: true, nombre: 'plano.pdf'}}});
  assert.deepEqual(campos(adj), {clave: 'cp-plano', uuid_cliente: op.archivos[0].uuid_cliente});
  assert.deepEqual(campos(foto), {uuid_cliente: op.fotos[0].uuid_cliente, descripcion: 'Fachada'});
  assert.equal(archivoDe(adj)[1].uri, op.archivos[0].uri);
  assert.ok(op.archivos[0].uri.startsWith('file:///test/attachments/dispositivos/'));
  assert.equal(new Set([op.uuid_cliente, op.archivos[0].uuid_cliente, op.fotos[0].uuid_cliente]).size, 3);
  assert.equal(op.modulo, 'dispositivos'); assert.equal(op._owner_user_id, '7');
  assert.equal(operacion(r).status, 'DONE');
  assert.equal(await d.getPendingCount(), 0);
  assert.equal((await d.getEstadoEnvio(5)).estado, 'enviado');
});

test('enviarResultado sincroniza solo si no se pide lo contrario', async () => {
  const {r, d} = await preparar();
  const calls = router(r, async (call) => (sufijo(call) === 'resultado/' ? OK_RESULTADO(call) : OK_ARCHIVO(call)));
  const {envio} = await d.enviarResultado(5, {criticidad: 'ALTA', respuestas: {'cp-techo': 'Malo'}});
  assert.equal(envio.estado, 'enviado');
  assert.deepEqual(escritos(calls).map(sufijo), ['resultado/']);
});

test('valida la criticidad antes de encolar', async () => {
  const {r, d} = await preparar();
  await assert.rejects(d.enviarResultado(5, {criticidad: 'CRITICA'}, {sincronizar: false}), (e) => e.code === 'CRITICIDAD_INVALIDA');
  await assert.rejects(d.enviarResultado(5, {}, {sincronizar: false}), (e) => e.code === 'CRITICIDAD_INVALIDA');
  assert.equal(await d.getPendingCount(), 0);
});

test('tras una falla de red no repite los pasos confirmados y reusa el mismo uuid', async () => {
  const {r, d, enviar} = await preparar();
  await enviar();
  let fallaAdjunto = true;
  const calls = router(r, async (call) => {
    if (sufijo(call) === 'resultado/') return OK_RESULTADO(call);
    if (sufijo(call) === 'adjuntos/' && fallaAdjunto) throw new TypeError('Failed to fetch');
    return OK_ARCHIVO(call);
  });
  const primero = await d.syncPendientes();
  assert.equal(primero.failed, 1);
  assert.equal(operacion(r).status, 'PENDING'); assert.equal(operacion(r).retry_count, 1);
  assert.ok(Date.parse(operacion(r).next_retry_at) > T0);
  assert.deepEqual(payloadOf(r).hecho, {resultado: true, archivos: [], fotos: []});
  const uuidAdjunto = campos(escritos(calls)[1]).uuid_cliente;

  r.setNow(T0 + 10 * MIN); fallaAdjunto = false; calls.length = 0;
  assert.equal((await d.syncPendientes()).synced, 1);
  assert.deepEqual(escritos(calls).map(sufijo), ['adjuntos/', 'fotos/']);
  assert.equal(campos(escritos(calls)[0]).uuid_cliente, uuidAdjunto);
  assert.equal(operacion(r).status, 'DONE');
});

test('un reintento programado en el futuro no se envia antes de tiempo', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  const calls = router(r, async () => response(503, {detail: 'caido'}));
  await d.syncPendientes();
  assert.equal(calls.length, 1);
  await d.syncPendientes();
  assert.equal(calls.length, 1, 'espera al backoff');
});

test('400 es permanente, no se reintenta y guarda claves y detail', async () => {
  const {r, d, enviar} = await preparar();
  await enviar();
  const calls = router(r, async () => response(400, {detail: '«Estado del techo»: elegí una opción.', respuestas: ['x'],
    claves: {'cp-techo': '«Estado del techo»: elegí una opción.'}}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'FAILED_PERMANENT');
  const envio = await d.getEstadoEnvio(5);
  assert.equal(envio.estado, 'error'); assert.equal(envio.permanente, true);
  assert.equal(envio.detail, '«Estado del techo»: elegí una opción.');
  assert.deepEqual(JSON.parse(JSON.stringify(envio.claves)), {'cp-techo': '«Estado del techo»: elegí una opción.'});
  await d.syncPendientes();
  assert.equal(calls.length, 1);
  assert.equal(await d.getPendingCount(), 1, 'sigue contando: hay datos sin entregar');
});

test('reintentarFallidas devuelve la fallida a la cola con el contador en cero', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  router(r, async () => response(400, {detail: 'mal', claves: {}}));
  await d.syncPendientes();
  const calls = router(r, async (call) => OK_RESULTADO(call));
  const resultado = await d.reintentarFallidas();
  assert.equal(resultado.synced, 1);
  assert.equal(calls.length, 1);
  assert.equal(operacion(r).status, 'DONE');
});

for (const code of ['YA_REALIZADA', 'CANCELADA', 'REASIGNADA', 'ESTADO_NO_ADMITE']) {
  test(`409 ${code} se descarta sin reintento y conserva el code`, async () => {
    const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
    await enviar();
    const calls = router(r, async () => response(409, {detail: 'texto que no se mira', code, estado: 'X'}));
    await d.syncPendientes();
    assert.equal(operacion(r).status, 'DISCARDED');
    assert.equal(operacion(r).last_error_code, code);
    assert.equal((await d.getEstadoEnvio(5)).code, code);
    await d.syncPendientes();
    assert.equal(calls.length, 1);
  });
}

test('409 sin un code conocido es permanente y no mira el texto', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  router(r, async () => response(409, {detail: 'El relevamiento ya tiene un resultado registrado.'}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'FAILED_PERMANENT'); assert.equal(operacion(r).last_error_code, 'CONFLICTO');
});

test('UUID_EN_USO regenera el uuid una sola vez y reintenta', async () => {
  const {r, d, enviar} = await preparar({archivos: {}});
  await enviar();
  const uuidOriginal = payloadOf(r).fotos[0].uuid_cliente;
  let primera = true;
  const calls = router(r, async (call) => {
    if (sufijo(call) === 'resultado/') return OK_RESULTADO(call);
    if (primera) { primera = false; return response(409, {detail: 'foto', code: 'UUID_EN_USO'}); }
    return response(201, {id: 1});
  });
  assert.equal((await d.syncPendientes()).synced, 1);
  const fotos = escritos(calls).filter((call) => sufijo(call) === 'fotos/');
  assert.equal(fotos.length, 2);
  assert.equal(campos(fotos[0]).uuid_cliente, uuidOriginal);
  assert.notEqual(campos(fotos[1]).uuid_cliente, uuidOriginal);
  assert.equal(payloadOf(r).fotos[0].uuid_cliente, campos(fotos[1]).uuid_cliente);
});

test('si UUID_EN_USO vuelve despues de regenerar, es permanente', async () => {
  const {r, d, enviar} = await preparar({archivos: {}});
  await enviar();
  const calls = router(r, async (call) => (sufijo(call) === 'resultado/' ? OK_RESULTADO(call)
    : response(409, {detail: 'foto', code: 'UUID_EN_USO'})));
  await d.syncPendientes();
  assert.equal(escritos(calls).filter((call) => sufijo(call) === 'fotos/').length, 2);
  assert.equal(operacion(r).status, 'FAILED_PERMANENT'); assert.equal(operacion(r).last_error_code, 'UUID_EN_USO');
});

test('404 descarta: el relevamiento es ajeno o no existe', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  router(r, async () => response(404, {detail: 'No encontrado.'}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'DISCARDED'); assert.equal(operacion(r).last_error_code, 'NO_ENCONTRADA');
});

test('403 SIN_MODULO notifica, deja la operacion pendiente y no la descarta', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  const avisos = [];
  const baja = d.subscribeSinModulo((modulo) => avisos.push(modulo));
  const calls = router(r, async () => response(403, {detail: 'sin acceso', code: 'SIN_MODULO'}));
  await d.syncPendientes();
  assert.deepEqual(avisos, ['dispositivos']);
  assert.equal(operacion(r).status, 'PENDING'); assert.equal(operacion(r).retry_count, 0);
  assert.ok(Date.parse(operacion(r).next_retry_at) > T0);
  await d.syncPendientes();
  assert.equal(calls.length, 1, 'no insiste hasta que pase la espera');
  baja();
  r.setNow(T0 + 6 * MIN);
  await d.syncPendientes();
  assert.deepEqual(avisos, ['dispositivos'], 'el listener dado de baja no se llama');
});

test('403 con la pagina HTML del WAF o sin code reintenta con backoff', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  const avisos = [];
  d.subscribeSinModulo((modulo) => avisos.push(modulo));
  router(r, async () => response(403, '<!DOCTYPE html><html></html>', {'content-type': 'text/html'}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'PENDING'); assert.equal(operacion(r).retry_count, 1);
  r.setNow(T0 + 10 * MIN);
  router(r, async () => response(403, {detail: 'Forbidden'}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'PENDING'); assert.equal(operacion(r).retry_count, 2);
  assert.deepEqual(avisos, []);
});

test('429 respeta Retry-After y no consume reintentos', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  router(r, async () => response(429, {detail: 'lento'}, {'Retry-After': '120'}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'PENDING'); assert.equal(operacion(r).retry_count, 0);
  assert.equal(Date.parse(operacion(r).next_retry_at) - T0, 2 * MIN);
});

test('401 deja la operacion pendiente (becasApi expira la sesion)', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  router(r, async () => response(401, {detail: 'Invalid token.'}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'PENDING'); assert.equal(operacion(r).last_error_code, 'AUTH_REQUIRED');
  assert.equal(operacion(r).retry_count, 0);
});

test('sin conexion no pega al servidor y deja todo en la cola', async () => {
  const {r, d, enviar} = await preparar();
  await enviar();
  const calls = router(r, async () => response(200, {}));
  r.setOnline(false);
  const resultado = await d.syncPendientes();
  assert.equal(resultado.offline, true); assert.equal(calls.length, 0);
  assert.equal(operacion(r).status, 'PENDING');
});

test('lo de otro usuario no se lista, no se cuenta ni se envia', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  router(r, async () => response(200, [{id: 5, estado: 'ASIGNADA', formulario_version: 10}]));
  await d.getInspecciones();
  await enviar();
  r.values.set('user_data', JSON.stringify({id: 8}));
  const calls = router(r, async (call) => OK_RESULTADO(call));
  r.setOnline(false);
  assert.deepEqual(await d.getInspecciones({refreshFromRemote: false}), []);
  assert.equal(await d.getInspeccion(5, {refreshFromRemote: false}), null);
  assert.equal(await d.getPendingCount(), 0);
  assert.equal(await d.getEstadoEnvio(5), null);
  r.setOnline(true);
  assert.equal((await d.syncPendientes()).synced, 0);
  assert.equal(calls.length, 0);
  assert.equal(operacion(r).status, 'PENDING');
  r.values.set('user_data', JSON.stringify({id: 7}));
  assert.equal(await d.getPendingCount(), 1);
  assert.equal((await d.syncPendientes()).synced, 1);
});

test('con formulario null no se mandan respuestas ni adjuntos, pero si las fotos', async () => {
  const {r, d, enviar} = await preparar({detalleCache: detalle({formulario: null, formulario_version: null})});
  await enviar();
  const calls = router(r, async (call) => (sufijo(call) === 'resultado/' ? OK_RESULTADO(call) : OK_ARCHIVO(call)));
  await d.syncPendientes();
  assert.deepEqual(escritos(calls).map(sufijo), ['resultado/', 'fotos/']);
  assert.deepEqual(Object.keys(escritos(calls)[0].body).sort(), ['criticidad', 'observaciones', 'uuid_cliente']);
});

test('no se encolan dos envios activos ni se reenvia uno ya confirmado', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  await assert.rejects(enviar(), (e) => e.code === 'YA_EN_COLA');
  router(r, async (call) => OK_RESULTADO(call));
  await d.syncPendientes();
  await assert.rejects(enviar(), (e) => e.code === 'YA_ENVIADO');
});

test('un envio nuevo reemplaza al que quedo en error', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  router(r, async () => response(400, {detail: 'mal', claves: {}}));
  await d.syncPendientes();
  await enviar();
  const filas = r.sql.prepare('SELECT status FROM outbox_dispositivos ORDER BY rowid').all().map((f) => f.status);
  assert.deepEqual(filas, ['DISCARDED', 'PENDING']);
  assert.equal((await d.getEstadoEnvio(5)).estado, 'pendiente');
});

test('dos syncs a la vez comparten una sola pasada', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  let liberar;
  const gate = new Promise((resolve) => { liberar = resolve; });
  const calls = router(r, async (call) => { await gate; return OK_RESULTADO(call); });
  const a = d.syncPendientes();
  const b = d.syncPendientes();
  await new Promise((resolve) => setTimeout(resolve, 20));
  liberar();
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(calls.length, 1);
  assert.equal(ra, rb);
});

test('una IN_FLIGHT abandonada se recupera con el timeout; una reciente no se toca', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  const calls = router(r, async (call) => OK_RESULTADO(call));
  const reciente = new Date(T0 - 5 * 1000).toISOString();
  r.sql.prepare("UPDATE outbox_dispositivos SET status='IN_FLIGHT', started_at=?").run(reciente);
  assert.equal((await d.syncPendientes()).synced, 0);
  assert.equal(calls.length, 0);
  assert.equal(operacion(r).status, 'IN_FLIGHT');
  r.setNow(T0 + MIN);
  assert.equal((await d.syncPendientes()).synced, 1);
  assert.equal(operacion(r).status, 'DONE');
});

test('lectura: listado y detalle van a la cache y sin red se usa la cache con el estado de envio', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  const calls = router(r, async (call) => (call.url === BASE ? response(200, [{id: 5, estado: 'ASIGNADA', formulario_version: 10}])
    : response(200, detalle())));
  const lista = await d.getInspecciones();
  assert.equal(lista.length, 1); assert.equal(lista[0].envio, null);
  assert.ok(calls.every((call) => call.url.startsWith(BASE)));
  await enviar();
  r.setOnline(false);
  const offline = await d.getInspecciones();
  assert.equal(offline[0].envio.estado, 'pendiente');
  assert.equal((await d.getInspeccion(5)).envio.estado, 'pendiente');
  // Una falla de red con la conexion "disponible" tambien cae a la cache.
  r.setOnline(true);
  router(r, async () => { throw new TypeError('Failed to fetch'); });
  assert.equal((await d.getInspecciones()).length, 1);
  assert.equal((await d.getInspeccion(5)).id, 5);
});

test('si cambia la formulario_version del listado se vuelve a pedir el detalle', async () => {
  const {r, d} = await preparar();
  const calls = router(r, async (call) => (call.url === BASE ? response(200, [{id: 5, estado: 'ASIGNADA', formulario_version: 11}])
    : response(200, detalle({formulario_version: 11, formulario: {...FORMULARIO, version: 11}}))));
  await d.getInspecciones();
  assert.deepEqual(calls.map((call) => call.url), [BASE, `${BASE}5/`], 'el listado trae el detalle que cambio');
  calls.length = 0;
  await d.getInspeccion(5, {refreshFromRemote: false});
  assert.equal(calls.length, 0, 'la version coincide: alcanza la cache');
  router(r, async () => response(200, detalle({formulario_version: 12})));
  r.sql.prepare("UPDATE cache_inspecciones_listado SET data_json = json_set(data_json, '$.formulario_version', 12)").run();
  const nuevo = await d.getInspeccion(5, {refreshFromRemote: false});
  assert.equal(nuevo.formulario_version, 12);
});

test('un 403 SIN_MODULO al leer tambien avisa', async () => {
  const {r, d} = await preparar();
  const avisos = [];
  const tokens = [];
  d.subscribeSinModulo((modulo, token) => { avisos.push(modulo); tokens.push(token); });
  router(r, async () => response(403, {detail: 'sin acceso', code: 'SIN_MODULO'}));
  await d.getInspecciones();
  assert.deepEqual(avisos, ['dispositivos']);
  // Va el token del pedido rechazado, para no tocar una sesion que entro despues.
  assert.deepEqual(tokens, [await r.api.getBecasToken()]);
});

test('aislamiento: el servicio solo pega a /api/dispositivos/inspecciones/ y las fuentes no se cruzan', async () => {
  const {r, d, enviar} = await preparar();
  await enviar();
  const calls = router(r, async (call) => (call.url === BASE ? response(200, [{id: 5, formulario_version: 10}])
    : sufijo(call) === 'resultado/' ? OK_RESULTADO(call) : call.method === 'GET' ? response(200, detalle()) : OK_ARCHIVO(call)));
  await d.getInspecciones();
  await d.syncPendientes();
  assert.ok(calls.length >= 4);
  assert.ok(calls.every((call) => call.url.startsWith(BASE) && !call.url.includes('/api/becas/')), JSON.stringify(calls.map((c) => c.url)));
  const src = (nombre) => fs.readFileSync(path.join(__dirname, '../src/services', nombre), 'utf8');
  assert.ok(!src('dispositivosService.js').includes('/api/becas/'));
  assert.ok(!src('dispositivosService.js').includes('relevamientos_offline'));
  assert.ok(!src('relevamientoService.js').includes('/api/dispositivos/'));
  assert.ok(!src('relevamientoService.js').includes('dispositivos_offline'));
  const tablas = r.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%dispositivos%' OR name LIKE 'cache_inspecciones%'").all();
  assert.ok(tablas.length >= 3);
});

// ---- Errores de envío: lo cargado no se pierde y el motivo es veraz ----

test('C-01: un 409 CANCELADA queda visible fuera del listado, con motivo, y se descarta a pedido', async () => {
  const {r, d, enviar} = await preparar();
  await enviar();
  router(r, async () => response(409, {detail: 'El relevamiento fue cancelado: obra suspendida', code: 'CANCELADA', estado: 'CANCELADA'}));
  await d.syncPendientes();
  assert.equal(operacion(r).status, 'DISCARDED');
  // El back ya no lo lista: el item sigue en la lista local porque tiene algo sin entregar.
  router(r, async (call) => (call.url === BASE ? response(200, []) : response(404, {detail: 'No encontrado.'})));
  const lista = await d.getInspecciones();
  assert.deepEqual(lista.map((item) => item.id), [5]);
  assert.equal(lista[0].envio.code, 'CANCELADA'); assert.equal(lista[0].envio.descartada, true);
  // El detalle tampoco falla con 404: muestra lo guardado.
  const abierto = await d.getInspeccion(5);
  assert.equal(abierto.envio.detail, 'El relevamiento fue cancelado: obra suspendida');
  // Los archivos siguen en el teléfono hasta que el agente decide.
  assert.ok(payloadOf(r).archivos[0].uri.startsWith('file:///test/attachments/dispositivos/'));
  assert.equal(await d.descartarEnvio(5), true);
  assert.equal(r.sql.prepare('SELECT COUNT(*) AS n FROM outbox_dispositivos').get().n, 0);
  assert.deepEqual(await d.getInspecciones({refreshFromRemote: false}), []);
});

test('C-02: un 400 con el formulario cambiado conserva lo respondido y lo reabre', async () => {
  const {r, d, enviar} = await preparar();
  await enviar();
  router(r, async () => response(400, {detail: '«Extintores» es obligatorio.', claves: {'cp-nuevo': '«Extintores» es obligatorio.'}}));
  await d.syncPendientes();
  const envio = await d.getEstadoEnvio(5);
  assert.equal(envio.version_capturada, 10);
  const previa = await d.getCargaRechazada(5);
  assert.equal(previa.criticidad, 'MEDIA'); assert.equal(previa.observaciones, 'Humedad');
  assert.deepEqual(JSON.parse(JSON.stringify(previa.respuestas)), {'cp-techo': 'Bueno'});
  assert.equal(previa.archivos['cp-plano'].fileName, 'plano.pdf');
  assert.equal(previa.fotos.length, 1); assert.equal(previa.fotos[0].descripcion, 'Fachada');
  // Reenviar reemplaza al rechazado y no pierde los archivos.
  const nuevo = await d.enviarResultado(5, {criticidad: 'MEDIA', respuestas: previa.respuestas,
    archivos: previa.archivos, fotos: previa.fotos}, {sincronizar: false});
  assert.equal(nuevo.envio.estado, 'pendiente');
  assert.equal(await d.getCargaRechazada(5), null);
});

test('C-03: el 401 deja el envío en espera con code AUTH_REQUIRED para no culpar a la conexión', async () => {
  const {r, d, enviar} = await preparar({archivos: {}, fotos: []});
  await enviar();
  router(r, async () => response(401, {detail: 'Invalid token.'}));
  await d.syncPendientes();
  r.values.set('user_data', JSON.stringify({id: 7})); // el 401 cerró la sesión; el agente vuelve a entrar
  const envio = await d.getEstadoEnvio(5);
  assert.equal(envio.estado, 'pendiente'); assert.equal(envio.code, 'AUTH_REQUIRED');
});

test('C-01/C-02/C-03: textos de describirEnvio y textoEnEspera', async () => {
  const fs2 = require('node:fs'); const vm = require('node:vm');
  const codigo = fs2.readFileSync(path.join(__dirname, '..', 'src/utils/dispositivos.js'), 'utf8')
    .replace(/export const /g, 'exports.').replace(/^import .*$/gm, '');
  const exports = {}; vm.runInNewContext(codigo, {exports, String, Object, Number, Array});
  const {describirEnvio, textoEnEspera} = exports;
  const cancelada = describirEnvio({estado: 'error', code: 'CANCELADA', descartada: true, detail: 'El relevamiento fue cancelado: obra'});
  assert.match(cancelada.titulo, /fue cancelado/); assert.equal(cancelada.sinReintento, true);
  assert.equal(cancelada.detalle, 'El relevamiento fue cancelado: obra');
  assert.match(describirEnvio({estado: 'error', code: 'REASIGNADA', descartada: true}).titulo, /reasignado a otra persona/);
  const cambio = describirEnvio({estado: 'error', code: 'DATOS_INVALIDOS', claves: {a: '«Extintores» es obligatorio.'}},
    {a: 'Extintores'}, {formularioCambio: true});
  assert.equal(cambio.titulo, 'El formulario cambió: completá los campos nuevos.');
  assert.equal(cambio.sinReintento, true);
  assert.equal(cambio.claves[0].texto, '«Extintores» es obligatorio.', 'sin repetir la etiqueta');
  const otra = describirEnvio({estado: 'error', code: 'DATOS_INVALIDOS', claves: {a: 'debe ser número'}}, {a: 'Metros'});
  assert.equal(otra.claves[0].texto, 'Metros: debe ser número');
  assert.match(textoEnEspera({code: 'AUTH_REQUIRED'}), /sesión venció/);
  assert.match(textoEnEspera({code: null}), /apenas haya conexión/);
});
