// services/emergenciaKits.js (M3 · Recepción de kits) contra contrato-app-emergencia §9 a §12:
// normalización, cantidades y diferencias, el multipart exacto de §12, la idempotencia del reintento
// con el mismo uuid_cliente, la recepción abierta que sobrevive a cerrar la app y cada error.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

// Los objetos vienen de otro realm (vm): se comparan como datos.
const igual = (actual, esperado, mensaje) => assert.deepEqual(JSON.parse(JSON.stringify(actual ?? null)), esperado, mensaje);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTREGA = {id: 31, numero: '2026-K-000031', estado: 'EN_CAMINO', despachada_en: '2026-11-12T10:00:00-03:00',
  recibida_en: null, observacion_mesa: 'Entregar a la directora.', observacion_dispositivo: '',
  lineas: [{item: 12, nombre: 'Colchón', unidad: 'unidad', enviada: 10, recibida: null},
    {item: 14, nombre: 'Kit alimentario', unidad: 'kit', enviada: 3, recibida: null}]};
const REMITO = {uri: 'file:///cache/remito.jpg', fileName: 'remito.jpg', mimeType: 'image/jpeg', fileSize: 2048};

async function preparar() {
  const r = await setup();
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'guardia', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'guardia', password: 'x'});
  const k = r.load('./emergenciaKits');
  return {r, k, entrega: k.normalizarEntrega(ENTREGA)};
}
const router = (r, handler) => {
  const calls = [];
  r.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET', init};
    calls.push(call);
    return handler(call, calls);
  });
  return calls;
};
const campos = (call) => call.init.body.fields.map(([nombre, valor]) => [nombre, typeof valor === 'string' ? valor : {...valor}]);
const uuidDe = (call) => call.init.body.fields.find(([nombre]) => nombre === 'uuid_cliente')[1];
const recibirOk = () => response(200, {estado: 'RECIBIDA_CON_DIFERENCIAS', diferencias: [{item: 12, enviada: 10, recibida: 8}, {item: 14, enviada: 3, recibida: 0}]});
const fallaDeRed = () => Promise.reject(new TypeError('Load failed'));
const enviar = (k, entrega, recepcion, extra = {}) => k.enviarRecepcion({entrega, recepcion, cantidades: {12: '8', 14: '0'},
  remito: REMITO, observacion: '  Faltan dos  ', ...extra});

// ---- Lógica pura ----

test('mis dispositivos: solo los que reciben kits, con sus pendientes', async () => {
  const {k} = await preparar();
  igual(k.dispositivosConKits([
    {id: 7, nombre: 'Club Sarmiento', admite: true, recibe_kits: true, entregas_pendientes: 2},
    {id: 9, nombre: 'Escuela 12', admite: true, recibe_kits: false, entregas_pendientes: 0},
    {id: 11, nombre: 'Parroquia', admite: false, recibe_kits: true},
    {nombre: 'sin id', recibe_kits: true}, null,
  ]), [{id: 7, nombre: 'Club Sarmiento', entregas_pendientes: 2}, {id: 11, nombre: 'Parroquia', entregas_pendientes: 0}]);
  igual(k.dispositivosConKits(null), []);
  igual(k.dispositivosConKits({detail: 'x'}), []);
});

test('entregas: normaliza §10, resume ítems y nombra estados', async () => {
  const {k, entrega} = await preparar();
  igual(entrega, {id: 31, numero: '2026-K-000031', estado: 'EN_CAMINO', despachada_en: '2026-11-12T10:00:00-03:00',
    observacion_mesa: 'Entregar a la directora.', lineas: [
      {item: 12, nombre: 'Colchón', unidad: 'unidad', enviada: 10, recibida: null}, {item: 14, nombre: 'Kit alimentario', unidad: 'kit', enviada: 3, recibida: null}]});
  assert.equal(k.resumenDeItems(entrega), '10 × Colchón · 3 × Kit alimentario');
  assert.equal(k.resumenDeItems({lineas: []}), 'Sin ítems');
  const preparada = k.normalizarEntrega({id: 32, estado: 'PREPARADA', lineas: [{item: 1, enviada: '4'}, {nombre: 'sin item'}]});
  assert.equal(preparada.numero, '32');
  assert.equal(preparada.despachada_en, null);
  igual(preparada.lineas, [{item: 1, nombre: 'Ítem 1', unidad: '', enviada: 4, recibida: null}]);
  igual(k.normalizarEntrega({...ENTREGA, lineas: [{item: 12, enviada: 10, recibida: '8'}]}).lineas[0].recibida, 8, '§11 trae lo recibido');
  igual(k.normalizarEntregas([ENTREGA, null, {numero: 'sin id'}]).map((e) => e.id), [31]);
  igual(k.estadoDeEntrega('EN_CAMINO'), {titulo: 'En camino', tono: 'info'});
  igual(k.estadoDeEntrega('PREPARADA'), {titulo: 'Preparada', tono: 'gray'});
  igual(k.estadoDeEntrega('OTRO_ESTADO'), {titulo: 'otro estado', tono: 'gray'});
});

test('cantidades: precarga lo enviado, valida enteros ≥ 0 y arma una por línea, también las 0', async () => {
  const {k, entrega} = await preparar();
  igual(k.cantidadesIniciales(entrega), {12: '10', 14: '3'});
  assert.equal(k.errorDeCantidad('0'), null);
  assert.equal(k.errorDeCantidad(' 12 '), null);
  assert.equal(k.errorDeCantidad(''), k.FALTA_CANTIDAD);
  assert.equal(k.errorDeCantidad(undefined), k.FALTA_CANTIDAD);
  for (const malo of ['-1', '2.5', '1e3', 'abc', '1 2', '1234567']) assert.equal(k.errorDeCantidad(malo), k.CANTIDAD_INVALIDA, malo);
  igual(k.armarCantidades(entrega, {12: '8', 14: '0'}), {12: 8, 14: 0});
  assert.throws(() => k.armarCantidades(entrega, {12: '8'}), /Kit alimentario/);
});

test('diferencias: faltantes y sobrantes (llegar de más también es diferencia); lo inválido no cuenta', async () => {
  const {k, entrega} = await preparar();
  igual(k.diferenciasDe(entrega, {12: '10', 14: '3'}), []);
  const difs = k.diferenciasDe(entrega, {12: '8', 14: '5'});
  igual(difs.map(({item, recibida, diferencia}) => [item, recibida, diferencia]), [[12, 8, -2], [14, 5, 2]]);
  igual(difs.map(k.textoDeDiferencia), ['Colchón: llegaron 8 de 10 (faltan 2)', 'Kit alimentario: llegaron 5 de 3 (sobran 2)']);
  igual(k.diferenciasDe(entrega, {12: '', 14: '0'}).map((d) => d.item), [14]);
});

test('validarRecepcion: una cantidad por línea y la foto del remito', async () => {
  const {k, entrega} = await preparar();
  igual(k.validarRecepcion({entrega, cantidades: {12: '10', 14: '0'}, remito: REMITO}), {});
  igual(k.validarRecepcion({entrega, cantidades: {12: '', 14: '-1'}}), {
    lineas: {12: [k.FALTA_CANTIDAD], 14: [k.CANTIDAD_INVALIDA]}, remito: [k.FALTA_REMITO]});
  igual(k.validarRecepcion({entrega, cantidades: {12: '1', 14: '1'}, remito: {file: {}}}), {}, 'en web vale el File');
});

test('400 VALIDACION: errores por línea, por campo y generales', async () => {
  const {k} = await preparar();
  igual(k.erroresDeRecepcion({cantidades: ['Falta la cantidad de Colchón.'], remito: ['Falta la foto del remito.'],
    'cantidades[14]': ['No es un entero.'], uuid_cliente: ['No es un UUID.'], detail: 'x', non_field_errors: ['x'], code: 'VALIDACION'}), {
    cantidades: ['Falta la cantidad de Colchón.'], remito: ['Falta la foto del remito.'], lineas: {14: ['No es un entero.']},
    generales: ['No es un UUID.']});
  igual(k.erroresDeRecepcion({detail: 'Algo', non_field_errors: ['Algo'], code: 'VALIDACION'}), {generales: ['Algo']});
});

test('clasificarErrorRecepcion: cada respuesta del contrato, por status y code', async () => {
  const {k} = await preparar();
  const c = (error) => k.clasificarErrorRecepcion(error);
  assert.equal(c({network: true}).tipo, 'reintentable');
  assert.equal(c({network: true, timeout: true}).tipo, 'reintentable');
  assert.equal(c({status: 500, payload: {}}).tipo, 'reintentable');
  assert.equal(c({status: 502, unexpectedHtml: true, payload: null}).tipo, 'reintentable');
  assert.equal(c({status: 404, unexpectedHtml: true, payload: null}).tipo, 'reintentable', 'HTML del WAF no es el 404 del back');
  igual(c({status: 429, retryAfter: 30000, payload: {}}), {tipo: 'reintentable', mensaje: k.TEXTO_ESPERAR, espera: 30000});
  igual(c({status: 503, payload: {}}), {tipo: 'reintentable', mensaje: k.TEXTO_REINTENTAR, espera: null});
  igual(c({status: 409, payload: {detail: 'Entrega 2026-K-000031 cancelada por la mesa a las 15:02. Ya no se puede recibir.', estado_actual: 'CANCELADA'}}),
    {tipo: 'conflicto', mensaje: 'Entrega 2026-K-000031 cancelada por la mesa a las 15:02. Ya no se puede recibir.', estadoActual: 'CANCELADA'});
  assert.equal(c({status: 409, payload: {detail: 'Ese identificador de envío ya se usó en otra recepción.', code: 'UUID_EN_USO'}}).tipo, 'uuid_en_uso');
  assert.equal(c({status: 409, payload: {detail: 'x'}}).tipo, 'rechazo', '409 sin estado_actual ni code');
  assert.equal(c({status: 404, payload: {detail: 'No encontrado.'}}).tipo, 'no_encontrada');
  igual(c({status: 403, payload: {detail: 'No recibe kits.', code: 'SIN_MODULO'}, verificacionSinModulo: 'actualizado'}),
    {tipo: 'sin_modulo', mensaje: 'No recibe kits.', verificacion: 'actualizado'});
  igual(c({status: 400, payload: {remito: ['No es JPEG.'], detail: 'No es JPEG.', code: 'VALIDACION'}}).errores, {remito: ['No es JPEG.']});
  igual(c({status: 413, payload: null, unexpectedHtml: true}), {tipo: 'pesada', mensaje: k.TEXTO_REMITO_PESADO, errores: {remito: [k.TEXTO_REMITO_PESADO]}});
  assert.equal(c({status: 401, payload: {}}).tipo, 'sesion');
  igual(c({status: 418, payload: {detail: 'Tetera.'}}), {tipo: 'rechazo', mensaje: 'Tetera.'});
});

// ---- Recepción abierta ----

test('abrirRecepcion: el uuid nace al abrir, se guarda y se conserva al volver a abrir; lo tipeado también', async () => {
  const {r, k, entrega} = await preparar();
  const primera = await k.abrirRecepcion(entrega, 7);
  assert.match(primera.uuid_cliente, UUID);
  igual(primera.cantidades, {12: '10', 14: '3'});
  assert.equal(primera.recuperada, false);
  assert.equal(primera.owner, '7');
  assert.equal(primera.token, 'tok');
  await k.guardarRecepcion(primera.owner, 31, {cantidades: {12: '9', 14: '3'}, observacion: 'Llovía'});
  // Otra instancia del módulo (la app se cerró y volvió a abrir).
  const k2 = r.reload('./emergenciaKits');
  const segunda = await k2.abrirRecepcion(entrega, 7);
  assert.equal(segunda.uuid_cliente, primera.uuid_cliente);
  igual(segunda.cantidades, {12: '9', 14: '3'});
  assert.equal(segunda.observacion, 'Llovía');
  assert.equal(segunda.recuperada, true);
  const otra = await k2.abrirRecepcion(k2.normalizarEntrega({...ENTREGA, id: 32}), 7);
  assert.notEqual(otra.uuid_cliente, primera.uuid_cliente, 'cada entrega su uuid');
  assert.ok(!JSON.stringify([...r.values.entries()]).includes('remito'), 'la foto no se guarda');
});

test('abrirRecepcion: es por usuario; sin sesión no abre', async () => {
  const {r, k, entrega} = await preparar();
  const de7 = await k.abrirRecepcion(entrega, 7);
  r.setFetch(async () => response(200, {token: 'tok2', user_id: 8, username: 'otra', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'otra', password: 'x'});
  const de8 = await k.abrirRecepcion(entrega, 7);
  assert.notEqual(de8.uuid_cliente, de7.uuid_cliente);
  assert.equal(de8.token, 'tok2');
  await r.api.clearBecasSession();
  await assert.rejects(k.abrirRecepcion(entrega, 7), (error) => error.code === 'SIN_SESION');
});

test('recepcionesAbiertas: olvida las del dispositivo que ya no están pendientes y no toca las de otro', async () => {
  const {k, entrega} = await preparar();
  await k.abrirRecepcion(entrega, 7);
  await k.abrirRecepcion(k.normalizarEntrega({...ENTREGA, id: 40}), 7);
  await k.abrirRecepcion(k.normalizarEntrega({...ENTREGA, id: 50}), 9);
  igual(await k.recepcionesAbiertas(7, [31, 33]), {abiertas: ['31'], avisos: []});
  const de40 = await k.abrirRecepcion(k.normalizarEntrega({...ENTREGA, id: 40}), 7);
  assert.equal(de40.recuperada, false, 'la de 40 se olvidó');
  igual(await k.recepcionesAbiertas(9, [50]), {abiertas: ['50'], avisos: []});
});

// ---- Envío (§12) ----

test('enviarRecepcion: multipart exacto de §12 con el uuid y el token de la recepción; 200 la cierra', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  // Otro token guardado después de abrir: el pedido sale con el de la recepción.
  r.values.set('becas_auth_token', 'otro-token');
  const calls = router(r, async () => recibirOk());
  const res = await enviar(k, entrega, recepcion);
  igual(res, {estado: 'RECIBIDA_CON_DIFERENCIAS', diferencias: [{item: 12, nombre: 'Colchón', unidad: 'unidad', enviada: 10, recibida: 8},
    {item: 14, nombre: 'Kit alimentario', unidad: 'kit', enviada: 3, recibida: 0}], distintas: []});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/emergencia/entregas/31/recibir/');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Token tok');
  assert.equal(calls[0].init.headers['Content-Type'], undefined, 'el boundary lo pone fetch');
  igual(campos(calls[0]), [
    ['uuid_cliente', recepcion.uuid_cliente], ['cantidades[12]', '8'], ['cantidades[14]', '0'], ['observacion', 'Faltan dos'],
    ['remito', {uri: 'file:///cache/remito.jpg', name: 'remito.jpg', type: 'image/jpeg'}],
  ]);
  const despues = await k.abrirRecepcion(entrega, 7);
  assert.notEqual(despues.uuid_cliente, recepcion.uuid_cliente, 'cerrada: la próxima es otra recepción');
});

test('enviarRecepcion: 201 también es éxito; sin observación no se manda el campo; RECIBIDA sin diferencias', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const calls = router(r, async () => response(201, {estado: 'RECIBIDA', diferencias: []}));
  const res = await enviar(k, entrega, recepcion, {cantidades: {12: '10', 14: '3'}, observacion: '   '});
  igual(res, {estado: 'RECIBIDA', diferencias: [], distintas: []});
  igual(campos(calls[0]).map(([n]) => n), ['uuid_cliente', 'cantidades[12]', 'cantidades[14]', 'remito']);
});

test('enviarRecepcion: sin red no manda nada ni bloquea; con datos inválidos tampoco', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const calls = router(r, async () => recibirOk());
  r.setOnline(false);
  await assert.rejects(enviar(k, entrega, recepcion), (error) => error.code === 'SIN_RED' && error.clasificacion.tipo === 'sin_red');
  assert.equal(calls.length, 0);
  assert.equal((await k.abrirRecepcion(entrega, 7)).incierto, false);
  r.setOnline(true);
  await assert.rejects(enviar(k, entrega, recepcion, {remito: null}),
    (error) => error.code === 'VALIDACION_LOCAL' && error.clasificacion.errores.remito[0] === k.FALTA_REMITO);
  await assert.rejects(enviar(k, entrega, recepcion, {cantidades: {12: '8'}}),
    (error) => error.clasificacion.errores.lineas[14][0] === k.FALTA_CANTIDAD);
  assert.equal(calls.length, 0);
});

test('idempotencia: tras red caída, timeout, 5xx o 429 el reintento sale con el MISMO uuid, también tras cerrar la app', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const respuestas = [fallaDeRed, () => response(502, {detail: 'Bad gateway'}),
    () => response(429, {detail: 'Despacio'}, {'Retry-After': '30'}), recibirOk];
  const calls = router(r, async (call, todas) => respuestas[todas.length - 1]());
  const e1 = await enviar(k, entrega, recepcion).catch((e) => e);
  assert.equal(e1.clasificacion.tipo, 'reintentable');
  // La app se cerró: al volver a abrir, la recepción sigue con ese uuid, bloqueada y con lo enviado.
  const k2 = r.reload('./emergenciaKits');
  const reabierta = await k2.abrirRecepcion(entrega, 7);
  assert.equal(reabierta.uuid_cliente, recepcion.uuid_cliente);
  assert.equal(reabierta.incierto, true);
  igual(reabierta.cantidades, {12: '8', 14: '0'});
  assert.equal(reabierta.observacion, '  Faltan dos  ');
  assert.equal(await k2.guardarRecepcion(reabierta.owner, 31, {cantidades: {12: '1', 14: '1'}}), false, 'bloqueada: no se cambia');
  const e2 = await enviar(k2, entrega, reabierta).catch((e) => e);
  assert.equal(e2.clasificacion.tipo, 'reintentable');
  const e3 = await enviar(k2, entrega, reabierta).catch((e) => e);
  igual(e3.clasificacion, {tipo: 'reintentable', mensaje: k2.TEXTO_ESPERAR, espera: 30000});
  const ok = await enviar(k2, entrega, reabierta);
  assert.equal(ok.estado, 'RECIBIDA_CON_DIFERENCIAS');
  igual(calls.map(uuidDe), Array(4).fill(recepcion.uuid_cliente));
});

test('el multipart sale con tiempo máximo (timeoutDelEnvio de la cola): un corte queda para reintentar', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  let señal = null;
  r.setFetch(async (url, init) => { señal = init.signal; throw new TypeError('aborted'); });
  const error = await enviar(k, entrega, recepcion).catch((e) => e);
  assert.ok(señal, 'con timeoutMs el pedido lleva AbortSignal');
  assert.equal(error.clasificacion.tipo, 'reintentable');
  assert.equal((await k.abrirRecepcion(entrega, 7)).incierto, true);
});

test('409 con estado_actual: no se reintenta y la recepción se cierra', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  router(r, async () => response(409, {detail: 'Entrega 2026-K-000031 cancelada por la mesa a las 15:02. Ya no se puede recibir.', estado_actual: 'CANCELADA'}));
  const error = await enviar(k, entrega, recepcion).catch((e) => e);
  assert.equal(error.clasificacion.tipo, 'conflicto');
  assert.equal(error.clasificacion.estadoActual, 'CANCELADA');
  assert.equal((await k.abrirRecepcion(entrega, 7)).recuperada, false);
});

test('404: la recepción se cierra', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  router(r, async () => response(404, {detail: 'No encontrado.'}));
  assert.equal((await enviar(k, entrega, recepcion).catch((e) => e)).clasificacion.tipo, 'no_encontrada');
  assert.equal((await k.abrirRecepcion(entrega, 7)).recuperada, false);
});

test('400 y 413: el back no escribió nada; se desbloquea y se corrige con el MISMO uuid', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const respuestas = [() => response(400, {remito: ['No es JPEG.'], detail: 'No es JPEG.', non_field_errors: ['No es JPEG.'], code: 'VALIDACION'}),
    () => response(413, {detail: 'Too large'}), recibirOk];
  const calls = router(r, async (call, todas) => respuestas[todas.length - 1]());
  const e400 = await enviar(k, entrega, recepcion).catch((e) => e);
  igual(e400.clasificacion.errores, {remito: ['No es JPEG.']});
  let abierta = await k.abrirRecepcion(entrega, 7);
  assert.equal(abierta.incierto, false);
  assert.equal(await k.guardarRecepcion(abierta.owner, 31, {cantidades: {12: '9', 14: '0'}}), true);
  const e413 = await enviar(k, entrega, abierta, {cantidades: {12: '9', 14: '0'}}).catch((e) => e);
  assert.equal(e413.clasificacion.tipo, 'pesada');
  abierta = await k.abrirRecepcion(entrega, 7);
  assert.equal(abierta.incierto, false);
  await enviar(k, entrega, abierta, {cantidades: {12: '9', 14: '0'}});
  igual(calls.map(uuidDe), Array(3).fill(recepcion.uuid_cliente));
  assert.equal(campos(calls[2])[1][1], '9');
});

test('409 UUID_EN_USO: queda bloqueada; solo descartando el intento sale con un uuid nuevo', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const respuestas = [() => response(409, {detail: 'Ese identificador de envío ya se usó en otra recepción.', code: 'UUID_EN_USO'}), recibirOk];
  const calls = router(r, async (call, todas) => respuestas[todas.length - 1]());
  assert.equal((await enviar(k, entrega, recepcion).catch((e) => e)).clasificacion.tipo, 'uuid_en_uso');
  const tras409 = await k.abrirRecepcion(entrega, 7);
  assert.equal(tras409.uuidEnUso, true);
  assert.equal(tras409.incierto, false);
  assert.equal(await k.guardarRecepcion(tras409.owner, 31, {cantidades: {12: '1', 14: '1'}}), false, 'con uuid en uso no se edita');
  await assert.rejects(enviar(k, entrega, tras409), (error) => error.code === 'UUID_EN_USO');
  assert.equal(calls.length, 1, 'con ese uuid no se vuelve a mandar');
  const nuevo = await k.descartarIntento(recepcion, 31);
  assert.match(nuevo, UUID);
  assert.notEqual(nuevo, recepcion.uuid_cliente);
  const abierta = await k.abrirRecepcion(entrega, 7);
  assert.equal(abierta.uuid_cliente, nuevo);
  assert.equal(abierta.incierto, false);
  assert.equal(abierta.uuidEnUso, false);
  assert.equal(abierta.descartado, true);
  igual(abierta.cantidades, {12: '8', 14: '0'}, 'lo cargado se conserva');
  await enviar(k, entrega, abierta);
  igual(calls.map(uuidDe), [recepcion.uuid_cliente, nuevo]);
});

test('403 SIN_MODULO: pasa por el perfil (verificarSinModulo) y no queda bloqueada', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const calls = router(r, async (call) => (call.url.endsWith('/perfil/')
    ? response(200, {relevar: true, llegadas: false, kits: false, dispositivo: false})
    : response(403, {detail: 'El usuario no recibe kits en ningún dispositivo.', code: 'SIN_MODULO'})));
  const error = await enviar(k, entrega, recepcion).catch((e) => e);
  igual(error.clasificacion, {tipo: 'sin_modulo', mensaje: 'El usuario no recibe kits en ningún dispositivo.', verificacion: 'actualizado'});
  igual(calls.map((c) => c.url), ['/api/emergencia/entregas/31/recibir/', '/api/emergencia/perfil/']);
  assert.equal((await k.abrirRecepcion(entrega, 7)).incierto, false);
});

test('hayConexion: en web manda navigator.onLine, en nativo NetInfo', async () => {
  const {r, k} = await preparar();
  r.setOnline(false);
  assert.equal(await k.hayConexion(), false);
  r.setOnline(true);
  assert.equal(await k.hayConexion(), true);
  const web = await setup('web');
  const kw = web.load('./emergenciaKits');
  web.setOnline(true);
  web.setNavigator({onLine: false});
  assert.equal(await kw.hayConexion(), false, 'en web, navigator manda aunque NetInfo diga que hay red');
  web.setNavigator({onLine: true});
  web.setOnline(false);
  assert.equal(await kw.hayConexion(), true);
  const handlers = new Map();
  web.setGlobal('window', {addEventListener: (t, fn) => handlers.set(t, fn), removeEventListener: (t) => handlers.delete(t)});
  const vistos = [];
  const dejar = kw.escucharRed((hay) => vistos.push(hay));
  handlers.get('offline')();
  handlers.get('online')();
  dejar();
  igual(vistos, [false, true]);
  assert.equal(handlers.size, 0);
});

// ---- Revisión: intento incierto, recepciones huérfanas, escrituras ----

test('incierto: 413 y 403 no lo destraban (no prueban nada del pedido anterior); 400 sí', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const respuestas = [fallaDeRed, () => response(413, {detail: 'Too large'}),
    () => response(403, {detail: 'No.', code: 'SIN_MODULO'}), () => response(400, {cantidades: ['Mal.'], code: 'VALIDACION'})];
  let n = 0;
  router(r, async (call) => (call.url.endsWith('/perfil/') ? response(200, {kits: true}) : respuestas[n++]()));
  await enviar(k, entrega, recepcion).catch(() => {});
  const e413 = await enviar(k, entrega, recepcion).catch((e) => e);
  assert.equal(e413.clasificacion.tipo, 'pesada');
  assert.equal(e413.recepcion.incierto, true);
  assert.equal((await k.abrirRecepcion(entrega, 7)).incierto, true);
  const e403 = await enviar(k, entrega, recepcion).catch((e) => e);
  assert.equal(e403.recepcion.incierto, true);
  assert.equal((await k.abrirRecepcion(entrega, 7)).incierto, true);
  const e400 = await enviar(k, entrega, recepcion).catch((e) => e);
  assert.equal(e400.recepcion.incierto, false, 'el back respondió y no escribió nada con este uuid');
  assert.equal((await k.abrirRecepcion(entrega, 7)).incierto, false);
});

test('incierto: el reintento puede salir sin remito; sin ser incierto, no', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  await assert.rejects(enviar(k, entrega, recepcion, {remito: null}), (error) => error.code === 'VALIDACION_LOCAL');
  const respuestas = [fallaDeRed, recibirOk];
  const calls = router(r, async (call, todas) => respuestas[todas.length - 1]());
  await enviar(k, entrega, recepcion).catch(() => {});
  await enviar(k, entrega, recepcion, {remito: null});
  igual(campos(calls[1]).map(([n]) => n), ['uuid_cliente', 'cantidades[12]', 'cantidades[14]', 'observacion']);
  assert.equal(uuidDe(calls[1]), uuidDe(calls[0]));
});

test('incierto: no se puede descartar el intento (solo tras UUID_EN_USO)', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  router(r, async () => fallaDeRed());
  await enviar(k, entrega, recepcion).catch(() => {});
  assert.equal(await k.descartarIntento(recepcion, 31), null);
  assert.equal((await k.abrirRecepcion(entrega, 7)).uuid_cliente, recepcion.uuid_cliente);
});

const RECIBIDA_GET = () => response(200, {...ENTREGA, estado: 'RECIBIDA_CON_DIFERENCIAS', recibida_en: '2026-11-12T15:02:00-03:00',
  lineas: ENTREGA.lineas.map((l) => ({...l, recibida: l.item === 12 ? 8 : 0}))});
const CONFLICTO = () => response(409, {detail: 'Entrega 2026-K-000031 ya la recibió alguien a las 15:02.', estado_actual: 'RECIBIDA_CON_DIFERENCIAS'});

test('409 RECIBIDA tras un intento incierto: consulta §11 y dice qué quedó registrado', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const respuestas = [fallaDeRed, CONFLICTO];
  let n = 0;
  const calls = router(r, async (call) => (call.method === 'GET' ? RECIBIDA_GET() : respuestas[n++]()));
  await enviar(k, entrega, recepcion).catch(() => {});
  const error = await enviar(k, entrega, recepcion).catch((e) => e);
  assert.equal(error.clasificacion.tipo, 'conflicto');
  assert.equal(calls.at(-1).url, '/api/emergencia/entregas/31/');
  assert.match(error.clasificacion.mensaje, /^La recepción de esta entrega ya figura registrada\./);
  assert.match(error.clasificacion.mensaje, /Colchón: 8 de 10\nKit alimentario: 0 de 3$/);
  igual(error.clasificacion.registrada.lineas.map((l) => l.recibida), [8, 0]);
});

test('409 RECIBIDA tras descartar un intento también consulta §11; sin incierto ni descarte, no', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  const respuestas = [() => response(409, {detail: 'x', code: 'UUID_EN_USO'}), CONFLICTO];
  let n = 0;
  const calls = router(r, async (call) => (call.method === 'GET' ? RECIBIDA_GET() : respuestas[n++]()));
  await enviar(k, entrega, recepcion).catch(() => {});
  const uuid = await k.descartarIntento(recepcion, 31);
  const error = await enviar(k, entrega, {...recepcion, uuid_cliente: uuid}).catch((e) => e);
  assert.ok(error.clasificacion.registrada);
  assert.ok(calls.some((c) => c.method === 'GET'));
  const otro = await preparar();
  const rec2 = await otro.k.abrirRecepcion(otro.entrega, 7);
  const calls2 = router(otro.r, async (call) => (call.method === 'GET' ? RECIBIDA_GET() : CONFLICTO()));
  const e2 = await enviar(otro.k, otro.entrega, rec2).catch((e) => e);
  assert.equal(e2.clasificacion.registrada, undefined);
  assert.equal(e2.clasificacion.mensaje, 'Entrega 2026-K-000031 ya la recibió alguien a las 15:02.');
  assert.ok(!calls2.some((c) => c.method === 'GET'));
});

test('200 con otras cantidades que las mandadas (el back devolvió el primer envío): `distintas` lo dice', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  router(r, async () => response(200, {estado: 'RECIBIDA_CON_DIFERENCIAS', diferencias: [{item: 12, enviada: 10, recibida: 5}]}));
  const res = await enviar(k, entrega, recepcion);
  igual(res.distintas, [{item: 12, nombre: 'Colchón', mandada: 8, registrada: 5}, {item: 14, nombre: 'Kit alimentario', mandada: 0, registrada: 3}]);
  assert.equal(k.textoDeDistinta(res.distintas[0]), 'Colchón: mandaste 8, quedó 5');
});

test('recepcionesAbiertas: una incierta que ya no está pendiente se consulta y se avisa (registrada, cancelada, sin confirmar); sin red se conserva', async () => {
  const {r, k, entrega} = await preparar();
  const abrirIncierta = async (id, numero) => {
    const e = k.normalizarEntrega({...ENTREGA, id, numero});
    const rec = await k.abrirRecepcion(e, 7);
    r.setFetch(fallaDeRed);
    await enviar(k, e, rec).catch(() => {});
  };
  await abrirIncierta(31, 'K-31');
  await abrirIncierta(32, 'K-32');
  await abrirIncierta(33, 'K-33');
  await abrirIncierta(34, 'K-34');
  await k.abrirRecepcion(k.normalizarEntrega({...ENTREGA, id: 35}), 7);
  router(r, async (call) => {
    if (call.url.endsWith('/31/')) return RECIBIDA_GET();
    if (call.url.endsWith('/32/')) return response(200, {...ENTREGA, id: 32, estado: 'CANCELADA'});
    if (call.url.endsWith('/33/')) return response(404, {detail: 'No encontrado.'});
    return fallaDeRed();
  });
  const res = await k.recepcionesAbiertas(7, []);
  igual(res.abiertas, []);
  assert.equal(res.avisos.length, 3);
  assert.match(res.avisos[0], /^Entrega K-31: La recepción de esta entrega ya figura registrada\.\nColchón: 8 de 10/);
  assert.match(res.avisos[1], /^Entrega K-32: la mesa la canceló/);
  assert.equal(res.avisos[2], `Entrega K-33: ${k.TEXTO_SIN_CONFIRMAR}`);
  assert.equal((await k.abrirRecepcion(entrega, 7)).recuperada, false, 'la registrada se olvida');
  const k34 = await k.abrirRecepcion(k.normalizarEntrega({...ENTREGA, id: 34}), 7);
  assert.equal(k34.incierto, true, 'sin red no se pudo consultar: se conserva');
  assert.equal((await k.abrirRecepcion(k.normalizarEntrega({...ENTREGA, id: 35}), 7)).recuperada, false, 'la no incierta se olvida sin consultar');
});

test('una recepción olvidada no vuelve como huérfana: guardar no la recrea; enviar y descartar la recrean con su dispositivo', async () => {
  const {r, k, entrega} = await preparar();
  const recepcion = await k.abrirRecepcion(entrega, 7);
  await k.recepcionesAbiertas(7, []);
  assert.equal(await k.guardarRecepcion(recepcion.owner, 31, {cantidades: {12: '1', 14: '1'}}), false);
  assert.equal(recepcion.dispositivo, 7);
  router(r, async () => fallaDeRed());
  await enviar(k, entrega, recepcion).catch(() => {});
  assert.equal((await k.abrirRecepcion(entrega, null)).dispositivo, 7, 'vuelve con su dispositivo');
  igual(await k.recepcionesAbiertas(7, [31]), {abiertas: ['31'], avisos: []});
  const otra = k.normalizarEntrega({...ENTREGA, id: 40});
  const rec40 = await k.abrirRecepcion(otra, 7);
  await k.recepcionesAbiertas(7, [31]);
  await k.descartarIntento(rec40, 40);
  assert.equal((await k.abrirRecepcion(otra, null)).dispositivo, 7, 'descartar la recrea con su dispositivo');
  igual(await k.recepcionesAbiertas(7, [31, 40]), {abiertas: ['31', '40'], avisos: []});
});

test('no escribe si nada cambió (otra pestaña no pisa lo que escribió esta)', async () => {
  const escrituras = [];
  const mapa = new Map();
  const storage = {
    getItem: async (key) => mapa.get(key) ?? null,
    setItem: async (key, value) => { escrituras.push(key); mapa.set(key, value); },
    removeItem: async (key) => { escrituras.push(key); mapa.delete(key); },
  };
  const r = await setup('android', {mocks: {'@react-native-async-storage/async-storage': {default: storage}}});
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'g', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'g', password: 'x'});
  const k = r.load('./emergenciaKits');
  const entrega = k.normalizarEntrega(ENTREGA);
  const rec = await k.abrirRecepcion(entrega, 7);
  const propias = () => escrituras.filter((key) => key.startsWith('emergencia_kits_recepciones')).length;
  assert.equal(propias(), 1);
  await k.abrirRecepcion(entrega, 7);
  await k.guardarRecepcion(rec.owner, 31, {cantidades: {12: '10', 14: '3'}, observacion: ''});
  await k.guardarRecepcion(rec.owner, 99, {cantidades: {}});
  await k.recepcionesAbiertas(7, [31]);
  assert.equal(propias(), 1, 'reabrir, guardar lo mismo, guardar una que no existe y podar sin cambios no escriben');
  await k.guardarRecepcion(rec.owner, 31, {cantidades: {12: '9', 14: '3'}});
  assert.equal(propias(), 2);
});
