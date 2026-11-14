const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');
for (const origin of ['padron', 'personas']) {
  test(`Consulta conserva ${origin} y envía el relevamiento sin depender de datos_api`, async () => {
    const {identity, setFetch} = await setup();
    setFetch(async (url, options) => {
      assert.ok(url.endsWith('/api/becas/personas/consultar/'));
      assert.deepEqual(JSON.parse(options.body), {dni:'30111222', sexo:'F', relevamiento:1});
      return response(200, {success:true, origen:origin, data:{nombre:'Ana', apellido:'Perez'}, datos_api:{}});
    });
    const result = await identity.consultarIdentidad({dni:'30111222', sexo:'F', relevamiento:1});
    assert.equal(result.origen, origin);
    assert.equal(identity.isValidatedIdentity(result.origen), true);
  });
}
for (const [status, body, blocked, message] of [
  [404, {fallecido:true, error:'Falleció'}, true, 'La persona figura como fallecida en la Base de Personas'],
  [404, {error:'No encontrado'}, false, 'No encontrado'],
  [502, {error:'Servicio caído'}, false, 'Servicio caído'],
  [429, {detail:'Request throttled.'}, false, 'Alcanzaste el tope de consultas de identidad por hora; seguí con carga manual'],
]) {
  test(`Respuesta ${status}, fallecido=${body.fallecido || false}: clasificación real del API`, async () => {
    const {identity, setFetch} = await setup();
    setFetch(async () => response(status, body));
    await assert.rejects(identity.consultarIdentidad({dni:'30111222', sexo:'F', relevamiento:1}), error => {
      const failure = identity.identityFailure(error);
      assert.equal(failure.blocked, blocked);
      assert.equal(failure.message, message);
      return true;
    });
  });
}
test('Una fuente desconocida no se transforma silenciosamente en personas', async () => {
  const {identity, setFetch} = await setup();
  setFetch(async () => response(200, {success:true, data:{}, origen:'desconocido'}));
  await assert.rejects(identity.consultarIdentidad({dni:'30111222', sexo:'F', relevamiento:1}));
  assert.equal(identity.isValidatedIdentity('scan'), true);
  assert.equal(identity.isValidatedIdentity('manual'), false);
  assert.equal(identity.identityKey('30.111.222', 'f'), identity.identityKey('30111222', 'F'));
});
test('Con ruta y orígenes propios (Emergencia) consulta esa ruta y valida contra esos orígenes', async () => {
  const {identity, setFetch} = await setup();
  let pedido;
  setFetch(async (url, options) => {
    pedido = {url, body: JSON.parse(options.body)};
    return response(200, {success:true, origen:'personas', data:{nombre:'Rosa'}, datos_api:{}});
  });
  const opciones = {ruta:'/api/emergencia/personas/consultar/', origenes:['personas']};
  const result = await identity.consultarIdentidad({dni:'30111222', sexo:'F'}, opciones);
  assert.equal(result.origen, 'personas');
  assert.equal(pedido.url, 'https://example.test/api/emergencia/personas/consultar/');
  assert.deepEqual(pedido.body, {dni:'30111222', sexo:'F'});
  setFetch(async () => response(200, {success:true, origen:'padron', data:{}}));
  await assert.rejects(identity.consultarIdentidad({dni:'30111222', sexo:'F'}, opciones));
  // Sin opciones sigue siendo Becas, con padrón válido.
  setFetch(async (url) => { pedido = {url}; return response(200, {success:true, origen:'padron', data:{}}); });
  assert.equal((await identity.consultarIdentidad({dni:'30111222', sexo:'F', relevamiento:1})).origen, 'padron');
  assert.equal(pedido.url, 'https://example.test/api/becas/personas/consultar/');
});
