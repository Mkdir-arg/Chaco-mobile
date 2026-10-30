const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

// Mandar cookies desde el navegador hacia el backend hace que DRF autentique con
// SessionAuthentication si el usuario tiene sesion abierta en el backoffice del mismo
// dominio, y entonces exige CSRF en los POST: todo se cae con 403 "CSRF Failed" antes de
// mirar las credenciales. Paso en QA y no se notaba en incognito, que es justo donde no
// hay sesion previa.

const loginCapturando = async (plataforma) => {
  const r = await setup(plataforma);
  const pedidos = [];
  r.setFetch(async (url, options = {}) => {
    pedidos.push({url: String(url), options});
    return response(200, {token: 'nuevo', user_id: 7, username: 'tecnico'});
  });
  await r.api.loginBecas({username: 'tecnico', password: 'secreta'});
  return pedidos;
};

test('en web el login no manda cookies', async () => {
  const pedidos = await loginCapturando('web');
  assert.equal(pedidos.length, 1, 'en web no se calienta la sesion del WAF: ese GET va a / y el CORS del backend solo cubre /api/');
  assert.match(pedidos[0].url, /\/api\/becas\/auth\/token\/$/);
  assert.equal(pedidos[0].options.credentials, 'omit');
});

test('en nativo el login conserva las cookies de la sesion del WAF', async () => {
  const pedidos = await loginCapturando('android');
  assert.equal(pedidos.length, 2, 'en nativo si se pide primero la cookie de FortiWeb');
  assert.equal(pedidos[0].options.credentials, 'include');
  assert.equal(pedidos[1].options.credentials, 'include');
});

test('las demas llamadas de la API tampoco mandan cookies en web', async () => {
  const r = await setup('web');
  const credenciales = [];
  r.setFetch(async (url, options = {}) => {
    credenciales.push(options.credentials);
    return response(200, {ok: true});
  });
  await r.api.becasRequest('/api/becas/relevamientos/', {method: 'POST', body: {a: 1}});
  await r.api.becasUploadFile('/api/becas/adjuntos/', {fileUri: 'data:image/jpeg;base64,aW1hZ2U=', fileName: 'dni.jpg'});
  assert.deepEqual(credenciales, ['omit', 'omit']);
});

test('clave provisoria: el 403 con codigo no guarda token y muestra el detail del back', async () => {
  const r = await setup('web');
  r.setFetch(async () => response(403, {token: 'no-debe-guardarse', user_id: 9, username: 'tecnico', modulos: ['becas'], codigo: 'debe_cambiar_contrasena', detail: 'Cambiá tu clave provisoria desde la web.'}));
  await assert.rejects(r.api.loginBecas({username: 'tecnico', password: 'provisoria'}),
    (e) => e.message === 'Cambiá tu clave provisoria desde la web.' && e.code === 'DEBE_CAMBIAR_CONTRASENA');
  assert.equal(await r.api.getBecasToken(), 'old-token', 'no se guardó un token nuevo');
});

test('un 403 sin codigo (sin acceso) y un 400 de credenciales siguen igual', async () => {
  const r = await setup('web');
  r.setFetch(async () => response(403, {detail: 'El usuario no tiene acceso a la app de campo.'}));
  await assert.rejects(r.api.loginBecas({username: 'tecnico', password: 'x'}),
    (e) => e.message === 'El usuario no tiene acceso a la app de campo.' && !e.code);
  r.setFetch(async () => response(400, {non_field_errors: ['No puede iniciar sesión.']}));
  await assert.rejects(r.api.loginBecas({username: 'tecnico', password: 'x'}), /No puede iniciar sesión/);
  assert.equal(await r.api.getBecasToken(), 'old-token', 'no se guardó un token nuevo');
});
