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

// Una respuesta que se puede soltar cuando el test quiera.
const diferida = () => {
  let soltar;
  const promesa = new Promise((resolve) => { soltar = resolve; });
  return {promesa, soltar};
};
const pedidoDe = (init) => String(init?.headers?.Authorization || '').replace('Token ', '');
// Lo que dice el AsyncStorage del runtime sobre el caché del perfil, por clave.
const cachePerfil = (r) => Object.fromEntries([...r.legacy.entries()]
  .filter(([clave]) => clave.startsWith('emergencia_perfil')).map(([clave, valor]) => [clave, JSON.parse(valor)]));

test('M1: el perfil de A colgado no queda a nombre de B que entra despues en el mismo telefono', async () => {
  const {r, e} = await preparar(['emergencia']);
  const deA = diferida();
  const pedidos = [];
  r.setFetch(async (url, init = {}) => {
    const ruta = String(url).replace('https://example.test', '');
    if (ruta === PERFIL) {
      pedidos.push(pedidoDe(init));
      return pedidoDe(init) === 'tok' ? deA.promesa : response(200, {relevar: false, dispositivo: true});
    }
    return response(200, {token: 'otro', user_id: 9, username: 'otra', modulos: ['emergencia']});
  });
  const avisados = [];
  e.subscribePerfil((perfil) => avisados.push(claves(e, perfil)));

  const deAgenteA = e.cargarPerfil();
  deAgenteA.catch(() => {});
  await esperar(); await esperar();
  assert.deepEqual(pedidos, ['tok'], 'A pidio su perfil y quedo colgado');
  await r.api.clearBecasSession();
  await r.api.loginBecas({username: 'otra', password: 'x'});

  const deAgenteB = e.cargarPerfil();
  deA.soltar(response(200, {relevar: true, dispositivo: false}));
  const {perfil, desdeCache} = await deAgenteB;
  assert.deepEqual(pedidos, ['tok', 'otro'], 'B no comparte el pedido de A');
  assert.equal(desdeCache, false);
  assert.deepEqual(claves(e, perfil), ['llegadas', 'kits']);
  await assert.rejects(deAgenteA, (error) => error.obsoleto === true);
  await esperar();
  assert.deepEqual(avisados, [['llegadas', 'kits']], 'a B nunca se le avisa el perfil de A');
  assert.deepEqual(claves(e, await e.getPerfilGuardado()), ['llegadas', 'kits']);
  assert.deepEqual(Object.keys(cachePerfil(r)), ['emergencia_perfil:9']);
});

test('M1: si la respuesta de A llega con B ya adentro, no se guarda para B', async () => {
  const {r, e} = await preparar(['emergencia']);
  const deA = diferida();
  r.setFetch(async (url, init = {}) => (String(url).endsWith(PERFIL) ? deA.promesa
    : response(200, {token: 'otro', user_id: 9, username: 'otra', modulos: ['emergencia']})));
  const avisados = [];
  e.subscribePerfil((perfil) => avisados.push(claves(e, perfil)));
  const deAgenteA = e.cargarPerfil();
  deAgenteA.catch(() => {});
  await esperar(); await esperar();
  await r.api.clearBecasSession();
  await r.api.loginBecas({username: 'otra', password: 'x'});
  deA.soltar(response(200, {relevar: true, dispositivo: false}));
  await assert.rejects(deAgenteA, (error) => error.obsoleto === true);
  assert.deepEqual(avisados, []);
  assert.equal(await e.getPerfilGuardado(), null);
  assert.deepEqual(cachePerfil(r), {});
});

test('el perfil se guarda por usuario y la clave vieja sin usuario no se lee y se borra', async () => {
  const {r, e} = await preparar();
  r.legacy.set('emergencia_perfil', JSON.stringify({owner_user_id: '7', perfil: {relevar: true}}));
  assert.equal(await e.getPerfilGuardado(), null, 'la clave vieja no se lee');
  router(r, async () => response(200, {relevar: false, dispositivo: true}));
  await e.cargarPerfil();
  assert.deepEqual(Object.keys(cachePerfil(r)), ['emergencia_perfil:7']);
  assert.equal(cachePerfil(r)['emergencia_perfil:7'].owner_user_id, '7');
  await e.olvidarPerfilGuardado(7);
  assert.deepEqual(cachePerfil(r), {});
});

test('m1: un pedido de perfil colgado se corta por tiempo, usa lo guardado y libera el siguiente', {timeout: 5000}, async () => {
  const {r, e} = await preparar();
  const original = e.LIMITES.perfilMs;
  e.LIMITES.perfilMs = 30;
  try {
    const senales = [];
    // Un fetch que no contesta nunca ni respeta la señal: el corte no depende del fetch.
    let colgar = true;
    const calls = [];
    r.setFetch(async (url, init = {}) => {
      calls.push(String(url));
      senales.push(init.signal);
      return colgar ? new Promise(() => {}) : response(200, {relevar: true, dispositivo: false});
    });
    await assert.rejects(e.cargarPerfil(), (error) => error.timeout === true && error.network === true);
    assert.equal(senales[0]?.aborted, true, 'se aborta el fetch');
    colgar = false;
    await e.cargarPerfil();
    assert.equal(calls.length, 2, 'el reintento vuelve a la red');
    colgar = true;
    const {perfil, desdeCache, sinRed} = await e.cargarPerfil();
    assert.equal(desdeCache, true);
    assert.equal(sinRed, false, 'tiempo agotado no es «sin conexión»');
    assert.deepEqual(claves(e, perfil), ['relevar']);
  } finally { e.LIMITES.perfilMs = original; }
});

test('m4: lo guardado sale marcado sinRed solo cuando fallo la red', async () => {
  const {r, e} = await preparar();
  router(r, async () => response(200, {relevar: true, dispositivo: false}));
  await e.cargarPerfil();
  router(r, async () => { throw new TypeError('Load failed'); });
  assert.equal((await e.cargarPerfil()).sinRed, true);
  router(r, async () => response(503, {detail: 'caido'}));
  assert.equal((await e.cargarPerfil()).sinRed, false);
});

test('m5: la señal SIN_MODULO lleva el detail del back, de Emergencia y de Dispositivos', async () => {
  const {r, e, sin} = await preparar(['dispositivos', 'emergencia']);
  const detalles = [];
  sin.subscribeSinModulo((modulo, token, detalle) => detalles.push([modulo, detalle]));
  router(r, async () => response(403, SIN_MODULO));
  await assert.rejects(e.cargarPerfil());
  const d = r.load('./dispositivosService');
  router(r, async () => response(403, {detail: 'Sin acceso a Dispositivos.', code: 'SIN_MODULO'}));
  await d.getInspecciones({refreshFromRemote: true}).catch(() => {});
  assert.deepEqual(detalles, [['emergencia', SIN_MODULO.detail], ['dispositivos', 'Sin acceso a Dispositivos.']]);
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
    '../services/emergenciaPerfil': e, '../services/emergenciaLimpieza': r.load('./emergenciaLimpieza'),
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

test('m5: AuthContext: si Emergencia era el unico modulo, el detail del perfil 403 queda para el login', async () => {
  const ui = await montarAuth(['emergencia']);
  try {
    router(ui.r, async () => response(403, SIN_MODULO));
    await renderer.act(async () => { await ui.e.cargarPerfil().catch(() => {}); await esperar(); await esperar(); });
    assert.equal(ui.auth().isAuthenticated, false);
    assert.equal(ui.auth().avisoSesion, SIN_MODULO.detail);
    await renderer.act(async () => { ui.auth().limpiarAvisoSesion(); });
    assert.equal(ui.auth().avisoSesion, null);
  } finally { await ui.close(); }
});

test('m5: AuthContext: con otro modulo, sacar Emergencia no deja aviso de sesion', async () => {
  const ui = await montarAuth(['becas', 'emergencia']);
  try {
    router(ui.r, async () => response(403, SIN_MODULO));
    await renderer.act(async () => { await ui.e.cargarPerfil().catch(() => {}); await esperar(); await esperar(); });
    assert.equal(ui.auth().isAuthenticated, true);
    assert.equal(ui.auth().avisoSesion, null);
  } finally { await ui.close(); }
});

test('m3: AuthContext: el logout borra el perfil guardado de ese usuario', async () => {
  const ui = await montarAuth(['becas', 'emergencia']);
  try {
    ui.r.legacy.set('emergencia_perfil:9', JSON.stringify({owner_user_id: '9', perfil: {relevar: true}}));
    router(ui.r, async () => response(200, {relevar: true, dispositivo: false}));
    await ui.e.cargarPerfil();
    assert.ok(ui.r.legacy.has('emergencia_perfil:7'));
    await renderer.act(async () => { await ui.auth().logout(); });
    assert.equal(ui.auth().isAuthenticated, false);
    assert.equal(ui.r.legacy.has('emergencia_perfil:7'), false);
    assert.equal(ui.r.legacy.has('emergencia_perfil:9'), true, 'el de otro usuario no se toca');
  } finally { await ui.close(); }
});

test('MAJOR 2 (PR #30): el logout borra los borradores de la ficha de Emergencia (datos personales y de salud)', async () => {
  const ui = await montarAuth(['emergencia']);
  try {
    ui.r.legacy.set('emergencia_llegadas_ficha:7', JSON.stringify({'184:2': {modo: 'confirmar', plano: {dni: '45111222'}, guardado_en: Date.now()}}));
    ui.r.legacy.set('emergencia_llegadas_ficha:9', JSON.stringify({}));
    await renderer.act(async () => { await ui.auth().logout(); });
    assert.equal(ui.auth().isAuthenticated, false);
    assert.deepEqual([...ui.r.legacy.keys()].filter(k => k.startsWith('emergencia_llegadas_ficha:')), []);
  } finally { await ui.close(); }
});

// ---- Segunda ronda de la revisión del PR #30: la sesión que se corta sola también limpia ----
const FICHA = 'emergencia_llegadas_ficha:7';
const borradorDe = (owner = '7') => JSON.stringify({'184:2': {modo: 'confirmar', plano: {dni: '45111222'}, guardado_en: Date.now(), owner}});
const fichasGuardadas = (r) => [...r.legacy.keys()].filter(k => k.startsWith('emergencia_llegadas_ficha:'));

test('MINOR A (PR #30): la sesión vencida (401) borra los borradores de la ficha', async () => {
  const ui = await montarAuth(['emergencia']);
  try {
    ui.r.legacy.set(FICHA, borradorDe());
    router(ui.r, async () => response(401, {detail: 'Invalid token.'}));
    await renderer.act(async () => { await ui.r.api.becasRequest('/api/emergencia/casos/mios/').catch(() => {}); await esperar(); await esperar(); });
    assert.equal(ui.auth().isAuthenticated, false);
    assert.deepEqual(fichasGuardadas(ui.r), []);
  } finally { await ui.close(); }
});

test('MINOR A (PR #30): sacar Emergencia (SIN_MODULO) borra los borradores; sacar otro módulo no', async () => {
  const ui = await montarAuth(['becas', 'emergencia']);
  try {
    ui.r.legacy.set(FICHA, borradorDe());
    const token = await ui.r.api.getBecasToken();
    await renderer.act(async () => { ui.sin.notificarSinModulo('becas', token, 'x'); await esperar(); await esperar(); });
    assert.deepEqual([...ui.auth().modulos], ['emergencia']);
    assert.deepEqual(fichasGuardadas(ui.r), [FICHA], 'sigue con Emergencia: el borrador queda');
    await renderer.act(async () => { ui.sin.notificarSinModulo('emergencia', token, 'Sin acceso.'); await esperar(); await esperar(); });
    assert.equal(ui.auth().isAuthenticated, false);
    assert.deepEqual(fichasGuardadas(ui.r), [], 'sin Emergencia, los borradores de la ficha no quedan');
  } finally { await ui.close(); }
});

test('MINOR A (PR #30): al entrar se depuran los borradores de otro usuario', async () => {
  const ui = await montarAuth(['becas']);
  try {
    ui.r.legacy.set('emergencia_llegadas_ficha:9', borradorDe('9'));
    ui.r.legacy.set(FICHA, borradorDe());
    router(ui.r, async () => response(200, {token: 'tok-2', user_id: 7, username: 'agente', modulos: ['becas']}));
    await renderer.act(async () => { await ui.auth().login('agente', 'x'); await esperar(); await esperar(); });
    assert.deepEqual(fichasGuardadas(ui.r), [FICHA], 'el de otro usuario se borra al entrar, sin abrir Emergencia');
  } finally { await ui.close(); }
});
