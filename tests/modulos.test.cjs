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

test('quitarModuloLocal saca el modulo del usuario guardado y del modulo activo', async () => {
  const {r} = await login({modulos: ['becas', 'dispositivos']});
  await r.api.setModuloActivo('dispositivos');
  const user = await r.api.quitarModuloLocal('dispositivos', 'nuevo');
  assert.deepEqual([...user.modulos], ['becas']);
  assert.deepEqual([...(await r.api.getStoredBecasUser()).modulos], ['becas']);
  assert.equal(await r.api.getModuloActivo(), null);
  // Quitar el que no era el activo deja el activo como estaba.
  await r.api.setModuloActivo('becas');
  await r.api.quitarModuloLocal('dispositivos', 'nuevo');
  assert.equal(await r.api.getModuloActivo(), 'becas');
  const vacio = await r.api.quitarModuloLocal('becas', 'nuevo');
  assert.deepEqual([...vacio.modulos], []);
});

test('quitarModuloLocal sin sesion no hace nada', async () => {
  const r = await setup();
  r.values.delete('user_data');
  assert.equal(await r.api.quitarModuloLocal('dispositivos', 'old-token'), null);
  assert.equal(r.values.has('user_data'), false);
});

// Un 403 SIN_MODULO de un pedido hecho con la sesion anterior no toca la sesion de quien
// entro despues: antes podia dejar el token nuevo con el usuario de la sesion vieja.
test('quitarModuloLocal con el token de otra sesion no hace nada', async () => {
  const {r} = await login({modulos: ['becas', 'dispositivos']});
  await r.api.setModuloActivo('dispositivos');
  assert.equal(await r.api.quitarModuloLocal('dispositivos', 'old-token'), null);
  assert.deepEqual([...(await r.api.getStoredBecasUser()).modulos], ['becas', 'dispositivos']);
  assert.equal(await r.api.getModuloActivo(), 'dispositivos');
});

test('un 403 SIN_MODULO viejo que llega en medio del login no mezcla las sesiones', async () => {
  const r = await setup();
  r.values.set('user_data', JSON.stringify({id: 7, username: 'ana', modulos: ['becas', 'dispositivos']}));
  r.setFetch(async () => response(200, {token: 'de-beto', user_id: 8, username: 'beto', modulos: ['becas', 'dispositivos']}));
  // El 403 de ana llega justo cuando el login de beto empezó a guardar su sesión.
  let quitado;
  const guardar = r.secure.set.bind(r.secure);
  r.secure.set = (key, value) => {
    if (key === 'becas_auth_token' && !quitado) quitado = r.api.quitarModuloLocal('dispositivos', 'old-token');
    return guardar(key, value);
  };
  await r.api.loginBecas({username: 'beto', password: 'x'});
  assert.equal(await quitado, null, 'el 403 era de la sesion de ana');
  const user = await r.api.getStoredBecasUser();
  assert.equal(await r.api.getBecasToken(), 'de-beto');
  assert.equal(user.id, 8);
  assert.deepEqual([...user.modulos], ['becas', 'dispositivos']);
});

test('un 403 SIN_MODULO que llega durante el logout no revive la sesion', async () => {
  const {r} = await login({modulos: ['becas', 'dispositivos']});
  const salida = r.api.clearBecasSession();
  const quitado = r.api.quitarModuloLocal('dispositivos', 'nuevo');
  await salida;
  assert.equal(await quitado, null);
  assert.equal(await r.api.getStoredBecasUser(), null);
  assert.equal(await r.api.getBecasToken(), null);
});

test('si el 403 deja al usuario sin modulos, se borra la sesion guardada', async () => {
  const {r} = await login({modulos: ['dispositivos']});
  const user = await r.api.quitarModuloLocal('dispositivos', 'nuevo');
  assert.deepEqual([...user.modulos], []);
  assert.equal(await r.api.getStoredBecasUser(), null);
  assert.equal(await r.api.getBecasToken(), null);
});
