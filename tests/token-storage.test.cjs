const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

// En nativo la sesión va a SecureStore. Si SecureStore falla al guardar, queda en AsyncStorage
// como respaldo (`respaldo_<clave>`). Antes ese respaldo solo se leía si SecureStore tiraba
// error al leer: si devolvía null, la sesión se perdía al reiniciar y el token quedaba sin
// cifrar tras el logout. Con `secureStoreSeparado`, el helper siembra la sesión del usuario 7
// en AsyncStorage con la clave sin prefijo: es el respaldo que dejaban las versiones anteriores.

const login = (r) => {
  r.setFetch(async (url) => url.endsWith('/auth/token/') ? response(200, {token: 'nuevo', user_id: 9, username: 'ana'}) : response(200, {}));
  return r.api.loginBecas({username: 'ana', password: 'x'});
};

test('si SecureStore falla, el login guarda en el respaldo y la sesión sigue al reiniciar', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  r.setSecureFalla(true);
  await login(r);
  assert.equal(r.legacy.get('respaldo_becas_auth_token'), 'nuevo');
  assert.equal(await r.api.getBecasToken(), 'nuevo');
  // SecureStore vuelve a andar pero está vacío: se sigue leyendo el respaldo.
  r.setSecureFalla(false);
  assert.equal(await r.api.getBecasToken(), 'nuevo');
  assert.equal((await r.api.getStoredBecasUser()).username, 'ana');
});

test('el respaldo viejo de otro relevador no revive con SecureStore vacío', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  assert.equal(await r.api.getBecasToken(), null);
  assert.equal(await r.api.getStoredBecasUser(), null);
});

test('si SecureStore tira error al leer, se lee el respaldo viejo como antes', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  r.setSecureFalla(true);
  assert.equal(await r.api.getBecasToken(), 'old-token');
  assert.equal((await r.api.getStoredBecasUser()).id, 7);
});

test('el login con SecureStore sano guarda cifrado y limpia los dos respaldos', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  r.legacy.set('respaldo_becas_auth_token', 'intermedio');
  await login(r);
  assert.equal(r.secure.get('becas_auth_token'), 'nuevo');
  assert.equal(r.legacy.has('becas_auth_token'), false);
  assert.equal(r.legacy.has('respaldo_becas_auth_token'), false);
  assert.equal(r.legacy.has('user_data'), false);
  assert.equal(await r.api.getBecasToken(), 'nuevo');
});

test('si SecureStore falla al guardar, un valor cifrado anterior no le gana al respaldo', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  r.secure.set('becas_auth_token', 'cifrado-viejo');
  let falla = 0;
  const original = r.secure.set.bind(r.secure);
  r.secure.set = (key, value) => { if (key === 'becas_auth_token' && !falla++) throw new Error('Keystore no disponible'); return original(key, value); };
  await login(r);
  assert.equal(r.secure.has('becas_auth_token'), false);
  assert.equal(await r.api.getBecasToken(), 'nuevo');
});

test('el logout borra la sesión cifrada y los dos respaldos', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  r.secure.set('becas_auth_token', 'cifrado');
  r.legacy.set('respaldo_becas_auth_token', 'respaldo');
  await r.api.clearBecasSession();
  assert.equal(r.secure.has('becas_auth_token'), false);
  assert.equal(r.legacy.has('respaldo_becas_auth_token'), false);
  assert.equal(r.legacy.has('becas_auth_token'), false);
  assert.equal(r.legacy.has('user_data'), false);
});

test('el logout limpia los respaldos aunque SecureStore falle', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  r.legacy.set('respaldo_becas_auth_token', 'respaldo');
  r.setSecureFalla(true);
  await r.api.clearBecasSession();
  assert.equal(r.legacy.has('respaldo_becas_auth_token'), false);
  assert.equal(r.legacy.has('becas_auth_token'), false);
  assert.equal(await r.api.getBecasToken(), null);
});

test('un 401 invalida la sesión que estaba en el respaldo', async () => {
  const r = await setup('android', {secureStoreSeparado: true});
  r.legacy.set('respaldo_becas_auth_token', 'respaldo');
  r.setFetch(async () => response(401, {detail: 'Invalid token.'}));
  await assert.rejects(r.api.becasRequest('api/becas/relevamientos/'));
  assert.equal(r.legacy.has('respaldo_becas_auth_token'), false);
  assert.equal(await r.api.getBecasToken(), null);
});

test('en web la sesión sigue en AsyncStorage sin prefijo y no toca SecureStore', async () => {
  const r = await setup('web', {secureStoreSeparado: true});
  r.setSecureFalla(true);
  await login(r);
  assert.equal(r.legacy.get('becas_auth_token'), 'nuevo');
  assert.equal(r.secure.size, 0);
});
