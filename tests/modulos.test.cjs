const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

const login = async (payload) => {
  const r = await setup();
  r.setFetch(async () => response(200, {token: 'nuevo', user_id: 7, username: 'tecnico', ...payload}));
  const user = await r.api.loginBecas({username: 'tecnico', password: 'secreta'});
  return {r, user};
};

test('el login guarda los modulos que devuelve el back', async () => {
  const {r, user} = await login({modulos: ['dispositivos', 'becas']});
  assert.deepEqual([...user.modulos], ['becas', 'dispositivos']);
  assert.deepEqual([...(await r.api.getStoredBecasUser()).modulos], ['becas', 'dispositivos']);
});

test('un modulo que la app no conoce no se ofrece', async () => {
  const {user} = await login({modulos: ['dispositivos', 'otro']});
  assert.deepEqual([...user.modulos], ['dispositivos']);
});

test('sin modulos de campo el login falla', async () => {
  const r = await setup();
  r.setFetch(async () => response(200, {token: 'nuevo', user_id: 7, username: 'tecnico', modulos: []}));
  await assert.rejects(r.api.loginBecas({username: 'tecnico', password: 'secreta'}), /no tiene acceso/);
  assert.equal(r.values.get('becas_auth_token'), 'old-token', 'no deja guardada una sesion sin modulos');
});

test('una sesion guardada antes de los modulos es de Becas', async () => {
  const r = await setup();
  assert.deepEqual([...(await r.api.getStoredBecasUser()).modulos], ['becas']);
  const {user} = await login({});
  assert.deepEqual([...user.modulos], ['becas']);
});

test('con un solo modulo entra directo; con dos, recuerda el elegido o pide elegir', async () => {
  const r = await setup();
  const {moduloInicial} = r.modulos;
  assert.equal(moduloInicial(['dispositivos'], null), 'dispositivos');
  assert.equal(moduloInicial(['dispositivos'], 'becas'), 'dispositivos', 'un modulo perdido no se recuerda');
  assert.equal(moduloInicial(['becas', 'dispositivos'], null), null);
  assert.equal(moduloInicial(['becas', 'dispositivos'], 'dispositivos'), 'dispositivos');
  assert.equal(moduloInicial([], null), null);
});

test('el modulo elegido se guarda y cerrar sesion lo borra', async () => {
  const r = await setup();
  await r.api.setModuloActivo('dispositivos');
  assert.equal(await r.api.getModuloActivo(), 'dispositivos');
  await r.api.clearBecasSession();
  assert.equal(await r.api.getModuloActivo(), null);
});
