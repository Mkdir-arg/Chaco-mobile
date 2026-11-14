// uploadMultipart (varios archivos en un multipart) y becasUploadFile, que delega en él sin
// cambiar su contrato: Becas y Dispositivos la siguen usando igual.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const capturar = (r, responder = () => response(201, {id: 1})) => {
  const pedidos = [];
  r.setFetch(async (url, init = {}) => {
    pedidos.push({url: String(url).replace('https://example.test', ''), init});
    return responder(url, init);
  });
  return pedidos;
};
const campos = (init) => init.body.fields.map((entrada) => [...entrada]);

test('dos archivos y campos en un solo multipart: nombres exactos, booleanos como texto, sin campos de más', async () => {
  const r = await setup();
  const pedidos = capturar(r);
  const payload = await r.api.uploadMultipart('/api/emergencia/casos/', {
    fields: {uuid_cliente: 'u-1', embarazo: true, mascotas: false, menores_f: 0, telefono: null, apellido: undefined},
    files: [
      {campo: 'foto_vivienda', uri: 'file:///v.jpg', nombre: 'v.jpg', tipo: 'image/jpeg'},
      null,
      {campo: 'foto_acceso', uri: 'file:///a.jpg', nombre: 'a.jpg'},
    ],
  });
  assert.deepEqual({...payload}, {id: 1});
  assert.equal(pedidos.length, 1);
  const {url, init} = pedidos[0];
  assert.equal(url, '/api/emergencia/casos/');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Token old-token');
  assert.equal(init.headers['Content-Type'], undefined);
  assert.equal(init.signal, undefined);
  assert.deepEqual(campos(init).map(([nombre]) => nombre),
    ['uuid_cliente', 'embarazo', 'mascotas', 'menores_f', 'foto_vivienda', 'foto_acceso']);
  assert.deepEqual(campos(init).slice(0, 4), [['uuid_cliente', 'u-1'], ['embarazo', 'true'], ['mascotas', 'false'], ['menores_f', '0']]);
  assert.deepEqual({...campos(init)[4][1]}, {uri: 'file:///v.jpg', name: 'v.jpg', type: 'image/jpeg'});
  assert.deepEqual({...campos(init)[5][1]}, {uri: 'file:///a.jpg', name: 'a.jpg', type: 'image/jpeg'});
});

test('el método se puede cambiar', async () => {
  const r = await setup();
  const pedidos = capturar(r, () => response(200, {}));
  await r.api.uploadMultipart('/x/', {method: 'PATCH', fields: {a: 1}});
  assert.equal(pedidos[0].init.method, 'PATCH');
});

test('web: usa webData si viene y, si no, lee la URI sin fetch', async () => {
  const r = await setup('web');
  const pedidos = capturar(r);
  const propio = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1])], {type: 'image/jpeg'});
  await r.api.uploadMultipart('/x/', {files: [
    {campo: 'foto_vivienda', uri: 'blob:https://app.test/no-registrada', nombre: 'v.jpg', webData: propio},
    {campo: 'foto_acceso', uri: 'data:image/jpeg;base64,aW1hZ2U=', nombre: 'a.jpg'},
  ]});
  const [vivienda, acceso] = campos(pedidos[0].init);
  assert.equal(vivienda[0], 'foto_vivienda'); assert.equal(vivienda[1], propio); assert.equal(vivienda[2], 'v.jpg');
  assert.equal(acceso[0], 'foto_acceso'); assert.ok(acceso[1] instanceof Blob); assert.equal(acceso[2], 'a.jpg');
  assert.equal(await acceso[1].text(), 'image');
});

for (const [status, cuerpo, headers, chequear] of [
  [400, {direccion: ['Escribí la dirección.'], detail: 'Escribí la dirección.', non_field_errors: ['Escribí la dirección.'], code: 'VALIDACION'}, {},
    (e) => { assert.equal(e.payload.code, 'VALIDACION'); assert.deepEqual([...e.payload.direccion], ['Escribí la dirección.']); }],
  [409, {detail: 'Entrega cancelada.', estado_actual: 'CANCELADA'}, {},
    (e) => assert.equal(e.payload.estado_actual, 'CANCELADA')],
  [409, {detail: 'Ese identificador de envío ya se usó en otro caso.', code: 'UUID_EN_USO'}, {},
    (e) => assert.equal(e.payload.code, 'UUID_EN_USO')],
  [429, {detail: 'Request was throttled.'}, {'Retry-After': '30'},
    (e) => assert.equal(e.retryAfter, 30000)],
]) {
  test(`error ${status} ${cuerpo.code || cuerpo.estado_actual || ''}: status, payload y retryAfter como becasRequest`, async () => {
    const r = await setup();
    capturar(r, () => response(status, cuerpo, headers));
    await assert.rejects(r.api.uploadMultipart('/x/', {fields: {a: 1}}), (error) => {
      assert.equal(error.status, status);
      assert.equal(error.unexpectedHtml, false);
      assert.equal(error.requestToken, 'old-token');
      assert.equal(Object.keys(error).includes('requestToken'), false);
      chequear(error);
      return true;
    });
    assert.equal(r.values.get('becas_auth_token'), 'old-token');
  });
}

test('sin red: el error sale marcado como network', async () => {
  const r = await setup();
  r.setFetch(async () => { throw new TypeError('Load failed'); });
  await assert.rejects(r.api.uploadMultipart('/x/', {}), (error) => error.network === true && !error.status);
});

test('una página HTML de un intermediario sale como unexpectedHtml, sin payload', async () => {
  const r = await setup();
  r.setFetch(async () => ({status: 403, ok: false, headers: {get: (n) => (n.toLowerCase() === 'content-type' ? 'text/html' : null)}, text: async () => '<html>WAF</html>'}));
  await assert.rejects(r.api.uploadMultipart('/x/', {}), (error) => error.unexpectedHtml === true && error.payload === null);
});

test('401 invalida la sesión, igual que becasRequest', async () => {
  const r = await setup();
  capturar(r, () => response(401, {detail: 'Invalid token.'}));
  await assert.rejects(r.api.uploadMultipart('/x/', {}), (error) => error.status === 401);
  assert.equal(r.values.has('becas_auth_token'), false);
});

test('timeoutMs aborta el pedido y sale como timeout de red; sin timeoutMs no hay señal', async () => {
  const r = await setup();
  let señal;
  r.setFetch((url, init) => { señal = init.signal; return new Promise(() => {}); });
  const inicio = Date.now();
  await assert.rejects(r.api.uploadMultipart('/x/', {timeoutMs: 30}), (error) => error.timeout === true && error.network === true);
  assert.ok(Date.now() - inicio < 2000);
  assert.equal(señal.aborted, true);

  const pedidos = capturar(r, () => response(201, {}));
  await r.api.uploadMultipart('/x/', {});
  await r.api.becasUploadFile('/x/', {fileUri: 'file:///a.jpg'});
  assert.equal(pedidos[0].init.signal, undefined);
  assert.equal(pedidos[1].init.signal, undefined);
});

test('timeoutMs no corta un pedido que contesta a tiempo', async () => {
  const r = await setup();
  capturar(r, () => response(201, {ok: 1}));
  assert.equal((await r.api.uploadMultipart('/x/', {timeoutMs: 5000})).ok, 1);
});

test('becasUploadFile mantiene su contrato: campos, archivo por defecto y POST', async () => {
  const r = await setup();
  const pedidos = capturar(r);
  await r.api.becasUploadFile('/api/becas/formularios/1/adjuntos/', {fileUri: 'file:///a.jpg', fields: {campo: 5, obligatorio: false, vacio: null}});
  await r.api.becasUploadFile('/api/dispositivos/x/', {fileUri: 'file:///b.pdf', fileField: 'documento', fileName: 'b.pdf', mimeType: 'application/pdf'});
  const [uno, dos] = pedidos;
  assert.equal(uno.init.method, 'POST');
  assert.deepEqual(campos(uno.init).map(([n, v]) => [n, typeof v === 'string' ? v : {...v}]),
    [['campo', '5'], ['obligatorio', 'false'], ['archivo', {uri: 'file:///a.jpg', name: 'archivo.jpg', type: 'image/jpeg'}]]);
  assert.deepEqual(campos(dos.init).map(([n, v]) => [n, {...v}]),
    [['documento', {uri: 'file:///b.pdf', name: 'b.pdf', type: 'application/pdf'}]]);
  assert.equal(uno.init.headers.Authorization, 'Token old-token');
  assert.equal(uno.init.headers['Content-Type'], undefined);
});
