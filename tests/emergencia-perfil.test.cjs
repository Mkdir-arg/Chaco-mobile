// Módulo Emergencia: perfil (§3 de contrato-app-emergencia), caché sin red y el 403 SIN_MODULO,
// que en Emergencia también significa «falta un permiso parcial».
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const renderer = require('react-test-renderer');
const {transformSync} = require('@babel/core');
const {setup, response} = require('./helpers/mobile-runtime.cjs');
global.IS_REACT_ACT_ENVIRONMENT = true;

const PERFIL = '/api/emergencia/perfil/';
const SIN_MODULO = {detail: 'El usuario no tiene acceso al módulo Emergencia.', code: 'SIN_MODULO'};
const SIN_AGENTE = {detail: 'El usuario no tiene permiso para relevar familias en Emergencia.', code: 'SIN_MODULO'};

const router = (r, handler) => {
  const calls = [];
  r.setFetch(async (url, init = {}) => {
    const call = {url: String(url).replace('https://example.test', ''), method: init.method || 'GET'};
    calls.push(call);
    return handler(call, calls);
  });
  return calls;
};

// Sesión de un agente con los módulos dados y token `tok`.
async function preparar(modulos = ['becas', 'emergencia']) {
  const r = await setup();
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'agente', modulos}));
  await r.api.loginBecas({username: 'agente', password: 'x'});
  const e = r.load('./emergenciaPerfil');
  const sin = r.load('./sinModulo');
  return {r, e, sin};
}
const claves = (e, perfil) => [...e.accesosDelPerfil(perfil)].map(({clave}) => clave);
const titulos = (e, perfil) => [...e.accesosDelPerfil(perfil)].map(({titulo}) => titulo);
const modulosGuardados = async (r) => [...((await r.api.getStoredBecasUser())?.modulos || [])];
// Lo mismo que hace AuthContext con la señal común.
const escucharComoAuth = (r, sin) => sin.subscribeSinModulo((modulo, token) => r.api.quitarModuloLocal(modulo, token));
const esperar = () => new Promise((resolve) => setTimeout(resolve, 0));

test('el perfil con relevar, llegadas y kits muestra los tres accesos en orden', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(200, {relevar: true, dispositivo: true, llegadas: true, kits: true}));
  const {perfil, desdeCache} = await e.cargarPerfil();
  assert.equal(calls[0].url, PERFIL);
  assert.equal(desdeCache, false);
  assert.deepEqual(titulos(e, perfil), ['Ingreso de familias', 'Llegada de familias', 'Recepción de kits']);
});

test('cada bandera del perfil habilita solo su acceso', async () => {
  const {e} = await preparar();
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: true, dispositivo: false})), ['relevar']);
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: false, dispositivo: true, llegadas: true, kits: false})), ['llegadas']);
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: false, dispositivo: true, llegadas: false, kits: true})), ['kits']);
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: false, dispositivo: false})), []);
  assert.deepEqual(claves(e, e.normalizarPerfil({})), []);
  assert.deepEqual(claves(e, e.normalizarPerfil(null)), []);
});

test('sin llegadas ni kits en la respuesta, dispositivo habilita los dos', async () => {
  const {e} = await preparar();
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: false, dispositivo: true})), ['llegadas', 'kits']);
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: true, dispositivo: true})), ['relevar', 'llegadas', 'kits']);
  // Si vienen, mandan ellos aunque `dispositivo` diga otra cosa.
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: false, dispositivo: true, llegadas: false, kits: false})), []);
  assert.deepEqual(claves(e, e.normalizarPerfil({relevar: false, dispositivo: true, kits: false})), ['llegadas']);
});

test('sin red arranca con el perfil guardado; sin nada guardado, el error sale', async () => {
  const {r, e} = await preparar();
  router(r, async () => { throw new TypeError('Load failed'); });
  await assert.rejects(e.cargarPerfil(), (error) => error.network === true);

  router(r, async () => response(200, {relevar: true, dispositivo: false}));
  await e.cargarPerfil();
  router(r, async () => { throw new TypeError('Load failed'); });
  const {perfil, desdeCache} = await e.cargarPerfil();
  assert.equal(desdeCache, true);
  assert.deepEqual(claves(e, perfil), ['relevar']);
  // Un 5xx o el WAF tampoco borran lo guardado.
  router(r, async () => response(503, {detail: 'caido'}));
  assert.equal((await e.cargarPerfil()).desdeCache, true);
  router(r, async () => response(403, {detail: 'Forbidden'}));
  assert.equal((await e.cargarPerfil()).desdeCache, true);
});

test('el perfil guardado es del usuario con sesion, no del anterior', async () => {
  const {r, e} = await preparar();
  router(r, async () => response(200, {relevar: true, dispositivo: true}));
  await e.cargarPerfil();
  r.setFetch(async () => response(200, {token: 'otro', user_id: 9, username: 'otra', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'otra', password: 'x'});
  assert.equal(await e.getPerfilGuardado(), null);
  router(r, async () => { throw new TypeError('Load failed'); });
  await assert.rejects(e.cargarPerfil());
});

test('un 401 al pedir el perfil invalida la sesion y no usa lo guardado', async () => {
  const {r, e} = await preparar();
  router(r, async () => response(200, {relevar: true, dispositivo: false}));
  await e.cargarPerfil();
  router(r, async () => response(401, {detail: 'Invalid token.'}));
  await assert.rejects(e.cargarPerfil(), (error) => error.status === 401);
  assert.equal(await r.api.getBecasToken(), null);
});

test('un 403 SIN_MODULO parcial con perfil 200 NO saca el modulo y actualiza los accesos', async () => {
  const {r, e, sin} = await preparar();
  escucharComoAuth(r, sin);
  const avisos = [];
  sin.subscribeSinModulo((modulo) => avisos.push(modulo));
  const perfiles = [];
  e.subscribePerfil((perfil) => perfiles.push(claves(e, perfil)));
  const calls = router(r, async (call) => call.url === PERFIL
    ? response(200, {relevar: false, dispositivo: true, llegadas: true, kits: true})
    : response(403, SIN_AGENTE));
  const rechazo = await r.api.becasRequest('/api/emergencia/casos/mios/').catch((x) => x);
  assert.equal(await e.verificarSinModulo(rechazo), 'actualizado');
  await esperar();
  assert.deepEqual(avisos, []);
  assert.deepEqual(await modulosGuardados(r), ['becas', 'emergencia']);
  assert.deepEqual(perfiles, [['llegadas', 'kits']]);
  assert.deepEqual(calls.map(({url}) => url), ['/api/emergencia/casos/mios/', PERFIL]);
});

test('un 403 SIN_MODULO con perfil tambien 403 SIN_MODULO saca Emergencia', async () => {
  const {r, e, sin} = await preparar();
  escucharComoAuth(r, sin);
  const avisos = [];
  sin.subscribeSinModulo((modulo, token) => avisos.push([modulo, token]));
  router(r, async () => response(200, {relevar: true, dispositivo: false}));
  await e.cargarPerfil();
  const calls = router(r, async () => response(403, SIN_MODULO));
  const rechazo = await r.api.becasRequest('/api/emergencia/casos/mios/').catch((x) => x);
  assert.equal(await e.verificarSinModulo(rechazo), 'quitado');
  await esperar();
  assert.deepEqual(calls.map(({url}) => url), ['/api/emergencia/casos/mios/', PERFIL]);
  assert.deepEqual(avisos, [['emergencia', 'tok']]);
  assert.deepEqual(await modulosGuardados(r), ['becas']);
  assert.equal(await e.getPerfilGuardado(), null, 'se borra el perfil guardado');
});

test('el perfil que responde 403 SIN_MODULO al entrar saca el modulo; si era el unico, cierra la sesion', async () => {
  const {r, e, sin} = await preparar(['emergencia']);
  escucharComoAuth(r, sin);
  router(r, async () => response(403, SIN_MODULO));
  await assert.rejects(e.cargarPerfil(), (error) => error.sinModulo === true && /no tiene acceso/.test(error.message));
  await esperar();
  assert.equal(await r.api.getStoredBecasUser(), null);
  assert.equal(await r.api.getBecasToken(), null);
});

test('un 403 sin code (WAF) o una pagina HTML no se toma como SIN_MODULO', async () => {
  const {r, e, sin} = await preparar();
  const avisos = [];
  sin.subscribeSinModulo((modulo) => avisos.push(modulo));
  router(r, async () => response(403, {detail: 'Forbidden'}));
  const waf = await r.api.becasRequest('/api/emergencia/casos/mios/').catch((x) => x);
  assert.equal(await e.verificarSinModulo(waf), null);
  router(r, async () => response(403, '<!DOCTYPE html><html></html>', {'content-type': 'text/html'}));
  await assert.rejects(e.cargarPerfil());
  assert.deepEqual(avisos, []);
  assert.deepEqual(await modulosGuardados(r), ['becas', 'emergencia']);
});

test('sin red al re-pedir el perfil no se saca el modulo', async () => {
  const {r, e, sin} = await preparar();
  escucharComoAuth(r, sin);
  router(r, async () => response(403, SIN_AGENTE));
  const rechazo = await r.api.becasRequest('/api/emergencia/casos/mios/').catch((x) => x);
  router(r, async () => { throw new TypeError('Load failed'); });
  assert.equal(await e.verificarSinModulo(rechazo), 'sin_verificar');
  await esperar();
  assert.deepEqual(await modulosGuardados(r), ['becas', 'emergencia']);
});

test('pedidos simultaneos del perfil comparten la respuesta', async () => {
  const {r, e} = await preparar();
  const calls = router(r, async () => response(200, {relevar: true, dispositivo: true}));
  const [a, b] = await Promise.all([e.cargarPerfil(), e.cargarPerfil()]);
  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  await e.cargarPerfil();
  assert.equal(calls.length, 2, 'terminado el pedido, el siguiente vuelve a la red');
});

test('Dispositivos sigue sacando su modulo ante su SIN_MODULO, por la señal comun', async () => {
  const {r, sin} = await preparar(['dispositivos', 'emergencia']);
  escucharComoAuth(r, sin);
  const d = r.load('./dispositivosService');
  assert.equal(d.subscribeSinModulo, sin.subscribeSinModulo, 'la misma señal');
  router(r, async () => response(403, {detail: 'sin acceso', code: 'SIN_MODULO'}));
  await d.getInspecciones({refreshFromRemote: true}).catch(() => {});
  await esperar();
  assert.deepEqual(await modulosGuardados(r), ['emergencia']);
});

// ---- AuthContext con la señal común (el componente real, con becasApi del runtime) ----

function loadModule(relative, mocks) {
  const filename = path.join(__dirname, '..', relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, Date});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(
    (name) => { assert.ok(mocks[name], 'Missing mock ' + name); return mocks[name]; }, module, module.exports);
  return module.exports;
}

async function montarAuth(modulos) {
  const {r, e, sin} = await preparar(modulos);
  await r.api.setModuloActivo('emergencia');
  const auth = loadModule('src/context/AuthContext.js', {
    react: React, '../services/becasApi': r.api, '../services/sinModulo': sin, '../services/modulos': r.modulos,
  });
  let actual;
  const Espia = () => { actual = auth.useAuth(); return null; };
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(auth.AuthProvider, null, React.createElement(Espia)));
  });
  return {r, e, sin, auth: () => actual, close: () => renderer.act(async () => tree.unmount())};
}

test('AuthContext: un 403 parcial con perfil 200 deja Emergencia activo; con perfil 403 lo saca', async () => {
  const ui = await montarAuth(['becas', 'emergencia']);
  try {
    assert.equal(ui.auth().moduloActivo, 'emergencia');
    router(ui.r, async (call) => call.url === PERFIL ? response(200, {relevar: true, dispositivo: false}) : response(403, SIN_AGENTE));
    const parcial = await ui.r.api.becasRequest('/api/emergencia/dispositivos/1/entregas/').catch((x) => x);
    await renderer.act(async () => { await ui.e.verificarSinModulo(parcial); await esperar(); });
    assert.deepEqual([...ui.auth().modulos], ['becas', 'emergencia']);
    assert.equal(ui.auth().moduloActivo, 'emergencia');

    router(ui.r, async () => response(403, SIN_MODULO));
    const total = await ui.r.api.becasRequest('/api/emergencia/casos/mios/').catch((x) => x);
    await renderer.act(async () => { await ui.e.verificarSinModulo(total); await esperar(); await esperar(); });
    assert.deepEqual([...ui.auth().modulos], ['becas']);
    assert.equal(ui.auth().moduloActivo, 'becas', 'con un solo modulo entra directo');
  } finally { await ui.close(); }
});

test('AuthContext: Dispositivos sigue saliendo de la sesion ante su SIN_MODULO', async () => {
  const ui = await montarAuth(['dispositivos']);
  try {
    const d = ui.r.load('./dispositivosService');
    router(ui.r, async () => response(403, {detail: 'sin acceso', code: 'SIN_MODULO'}));
    await renderer.act(async () => {
      await d.getInspecciones({refreshFromRemote: true}).catch(() => {});
      await esperar(); await esperar();
    });
    assert.equal(ui.auth().isAuthenticated, false);
    assert.equal(await ui.r.api.getBecasToken(), null);
  } finally { await ui.close(); }
});
