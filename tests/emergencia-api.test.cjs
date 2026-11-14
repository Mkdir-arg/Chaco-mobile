// services/emergenciaApi.js contra contrato-app-emergencia (Chaco-Back): rutas, nombres de
// campos exactos, 409 con estado_actual / UUID_EN_USO y el 403 SIN_MODULO por el perfil.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

async function preparar(platform = 'android') {
  const r = await setup(platform);
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'agente', modulos: ['becas', 'emergencia']}));
  await r.api.loginBecas({username: 'agente', password: 'x'});
  return {r, e: r.load('./emergenciaApi')};
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
const campos = (call) => call.init.body.fields.map(([nombre, valor, archivo]) => [nombre, typeof valor === 'string' ? valor : (valor?.uri ? {...valor} : valor), archivo]);

const CASO_COMPLETO = {
  uuid_cliente: '5b1c2f0e-1111-4222-8333-944455556666', relevado_en: '2026-11-14T10:00:00-03:00',
  traslado: 'OTRA', traslado_otro: 'Lancha vecinal', dni: '30111222', nombre: 'Rosa', apellido: 'Benitez',
  fecha_nacimiento: '1984-03-02', telefono: '3624000000', documento_extraviado: false,
  menores_f: 1, menores_m: 0, adultos_f: 1, adultos_m: 1, mayores_f: 0, mayores_m: 0,
  dependientes: 0, mayores_dependientes: 0, lactantes: 1,
  embarazo: true, electrodependiente: false, medicacion_critica: false, mascotas: true,
  direccion: 'Av. 9 de Julio 1200', localidad: 12, latitud: -27.45, longitud: -58.98, precision_m: 12.5,
  observaciones: 'Agua hasta la rodilla',
};

test('enviarCaso: multipart a /casos/ con las claves exactas de §6, en orden y sin total ni prioridad', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(201, {id: 184, numero: '2026-000184', prioridad: 'MEDIA', total_declarado: 3}));
  const res = await e.enviarCaso({...CASO_COMPLETO, total: 3, prioridad: 'ALTA', otra_cosa: 'x'}, {
    foto_vivienda: {uri: 'file:///v.png', fileName: 'IMG_1.PNG'},
    foto_acceso: {uri: 'file:///a.jpg', fileName: 'acceso.jpeg'},
    foto_extra: {uri: 'file:///z.jpg'},
  });
  assert.equal(res.numero, '2026-000184');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/emergencia/casos/');
  assert.equal(calls[0].method, 'POST');
  const enviados = campos(calls[0]);
  // La tabla del §6, escrita acá a mano: no se compara contra la constante del código.
  assert.deepEqual(enviados.map(([n]) => n), [
    'uuid_cliente', 'relevado_en', 'traslado', 'traslado_otro', 'dni', 'nombre', 'apellido',
    'fecha_nacimiento', 'telefono', 'documento_extraviado',
    'menores_f', 'menores_m', 'adultos_f', 'adultos_m', 'mayores_f', 'mayores_m',
    'dependientes', 'mayores_dependientes', 'lactantes',
    'embarazo', 'electrodependiente', 'medicacion_critica', 'mascotas',
    'direccion', 'localidad', 'latitud', 'longitud', 'precision_m', 'observaciones',
    'foto_vivienda', 'foto_acceso',
  ]);
  const valor = Object.fromEntries(enviados.map(([n, v]) => [n, v]));
  assert.equal(valor.embarazo, 'true'); assert.equal(valor.electrodependiente, 'false');
  assert.equal(valor.documento_extraviado, 'false'); assert.equal(valor.menores_m, '0');
  assert.equal(valor.localidad, '12'); assert.equal(valor.latitud, '-27.45');
  assert.deepEqual(valor.foto_vivienda, {uri: 'file:///v.png', name: 'IMG_1.jpg', type: 'image/jpeg'});
  assert.deepEqual(valor.foto_acceso, {uri: 'file:///a.jpg', name: 'acceso.jpeg', type: 'image/jpeg'});
});

test('enviarCaso: sin fotos, vacíos fuera, y latitud sin longitud no se manda', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(200, {id: 184}));
  await e.enviarCaso({uuid_cliente: 'u', traslado: 'BOMBEROS', dni: '30111222', direccion: 'x', telefono: '', latitud: -27.4, adultos_f: 1});
  assert.deepEqual(campos(calls[0]).map(([n]) => n), ['uuid_cliente', 'traslado', 'dni', 'adultos_f', 'direccion']);
});

test('enviarCaso y recibirEntrega exigen uuid_cliente antes de pedir nada', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(201, {}));
  await assert.rejects(e.enviarCaso({dni: '30111222'}), /uuid_cliente/);
  await assert.rejects(e.recibirEntrega(31, {cantidades: {12: 1}}), /uuid_cliente/);
  assert.equal(calls.length, 0);
});

test('enviarCaso en web manda los bytes de aJpeg (file) con nombre .jpg', async () => {
  const {r, e} = await preparar('web');
  const calls = router(r, async () => response(201, {}));
  const file = new File([new Uint8Array([0xff, 0xd8, 0xff])], 'casa.jpg', {type: 'image/jpeg'});
  await e.enviarCaso({uuid_cliente: 'u'}, {foto_vivienda: {uri: 'blob:https://app.test/x', file, fileName: 'casa.jpg'}});
  const [, foto] = campos(calls[0]);
  assert.equal(foto[0], 'foto_vivienda'); assert.equal(foto[1], file); assert.equal(foto[2], 'casa.jpg');
});

test('recibirEntrega: cantidades[<id>] por línea (también 0), remito y observación', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(200, {estado: 'RECIBIDA_CON_DIFERENCIAS', diferencias: [{item: 12, enviada: 10, recibida: 8}]}));
  const res = await e.recibirEntrega(31, {
    uuid_cliente: 'u-2', cantidades: {12: 8, 14: 0}, observacion: 'Faltan dos', remito: {uri: 'file:///r.jpg', fileName: 'remito.jpg'},
  });
  assert.equal(res.estado, 'RECIBIDA_CON_DIFERENCIAS');
  assert.equal(calls[0].url, '/api/emergencia/entregas/31/recibir/');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(campos(calls[0]).map(([n, v]) => [n, v]), [
    ['uuid_cliente', 'u-2'], ['cantidades[12]', '8'], ['cantidades[14]', '0'], ['observacion', 'Faltan dos'],
    ['remito', {uri: 'file:///r.jpg', name: 'remito.jpg', type: 'image/jpeg'}],
  ]);
});

test('lecturas: localidades, mis envíos, mis dispositivos, entregas (pendientes) y una entrega', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(200, []));
  await e.getIndice();
  await e.getLocalidades();
  await e.getMisCasos();
  await e.getMisDispositivos();
  await e.getEntregasDispositivo(7, {pendientes: true});
  await e.getEntregasDispositivo(7);
  await e.getEntrega(31);
  assert.deepEqual(calls.map(({method, url}) => `${method} ${url}`), [
    'GET /api/emergencia/',
    'GET /api/emergencia/localidades/',
    'GET /api/emergencia/casos/mios/',
    'GET /api/emergencia/mis-dispositivos/',
    'GET /api/emergencia/dispositivos/7/entregas/?pendientes=1',
    'GET /api/emergencia/dispositivos/7/entregas/',
    'GET /api/emergencia/entregas/31/',
  ]);
});

test('consultarPersona: ruta de Emergencia, solo dni y sexo, y solo origen personas', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(200, {success: true, origen: 'personas', data: {nombre: 'Rosa', apellido: 'Benitez'}, datos_api: {}}));
  const res = await e.consultarPersona({dni: '30111222', sexo: 'F'});
  assert.equal(res.data.nombre, 'Rosa');
  assert.equal(calls[0].url, '/api/emergencia/personas/consultar/');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), {dni: '30111222', sexo: 'F'});
  router(r, async () => response(200, {success: true, origen: 'padron', data: {}}));
  await assert.rejects(e.consultarPersona({dni: '30111222', sexo: 'F'}), /fuente de identidad/);
});

test('consultarPersona: 404, fallecido y 429 se clasifican con identityFailure como en Becas', async () => {
  const {r, e} = await preparar();
  const identity = r.load('./identityLookup');
  for (const [status, cuerpo, headers, bloqueado] of [
    [404, {success: false, error: 'No figura.'}, {}, false],
    [404, {success: false, fallecido: true, error: 'Fallecida.'}, {}, true],
    [429, {detail: 'Request was throttled.'}, {'Retry-After': '60'}, false],
  ]) {
    router(r, async () => response(status, cuerpo, headers));
    await assert.rejects(e.consultarPersona({dni: '30111222', sexo: 'F'}), (error) => {
      assert.equal(identity.identityFailure(error).blocked, bloqueado);
      if (status === 429) assert.equal(error.retryAfter, 60000);
      return true;
    });
  }
});

test('409 con estado_actual y 409 UUID_EN_USO se distinguen', async () => {
  const {r, e} = await preparar();
  router(r, async () => response(409, {detail: 'Entrega 2026-K-000031 cancelada por la mesa a las 15:02. Ya no se puede recibir.', estado_actual: 'CANCELADA'}));
  const conflicto = await e.recibirEntrega(31, {uuid_cliente: 'u', cantidades: {12: 1}}).catch((error) => error);
  assert.equal(e.esConflictoDeEstado(conflicto), true);
  assert.equal(e.esUuidEnUso(conflicto), false);
  assert.equal(conflicto.message, 'Entrega 2026-K-000031 cancelada por la mesa a las 15:02. Ya no se puede recibir.');

  router(r, async () => response(409, {detail: 'Ese identificador de envío ya se usó en otro caso.', code: 'UUID_EN_USO'}));
  const enUso = await e.enviarCaso({uuid_cliente: 'u'}).catch((error) => error);
  assert.equal(e.esUuidEnUso(enUso), true);
  assert.equal(e.esConflictoDeEstado(enUso), false);

  for (const otro of [
    {status: 400, payload: {estado_actual: 'CANCELADA'}},
    {status: 409, payload: {estado_actual: ''}},
    {status: 409, payload: {estado_actual: 'RECIBIDA'}, unexpectedHtml: true},
    {status: 409, payload: null},
    {status: 403, payload: {code: 'UUID_EN_USO'}},
    null,
  ]) {
    assert.equal(e.esConflictoDeEstado(otro), false);
    assert.equal(e.esUuidEnUso(otro), false);
  }
});

test('403 SIN_MODULO parcial: se vuelve a pedir el perfil y, si da 200, el módulo queda', async () => {
  const {r, e} = await preparar();
  const sin = r.load('./sinModulo');
  const avisos = [];
  sin.subscribeSinModulo((modulo) => avisos.push(modulo));
  const calls = router(r, async ({url}) => (url === '/api/emergencia/perfil/'
    ? response(200, {relevar: false, dispositivo: true})
    : response(403, {detail: 'El usuario no tiene permiso para relevar familias en Emergencia.', code: 'SIN_MODULO'})));
  const error = await e.enviarCaso({uuid_cliente: 'u'}).catch((fallo) => fallo);
  assert.equal(error.status, 403);
  assert.equal(error.verificacionSinModulo, 'actualizado');
  assert.deepEqual(calls.map(({url}) => url), ['/api/emergencia/casos/', '/api/emergencia/perfil/']);
  assert.deepEqual(avisos, []);
});

test('403 SIN_MODULO confirmado por el perfil: la señal común saca el módulo', async () => {
  const {r, e} = await preparar();
  const sin = r.load('./sinModulo');
  const avisos = [];
  sin.subscribeSinModulo((modulo) => avisos.push(modulo));
  router(r, async () => response(403, {detail: 'El usuario no tiene acceso al módulo Emergencia.', code: 'SIN_MODULO'}));
  const error = await e.getMisDispositivos().catch((fallo) => fallo);
  assert.equal(error.verificacionSinModulo, 'quitado');
  assert.deepEqual(avisos, ['emergencia']);
});

test('otro error no pasa por el perfil', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(404, {detail: 'No encontrado.'}));
  const error = await e.getEntrega(99).catch((fallo) => fallo);
  assert.equal(error.status, 404);
  assert.equal(error.verificacionSinModulo, undefined);
  assert.equal(calls.length, 1);
});
