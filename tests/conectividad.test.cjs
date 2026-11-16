const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

// NetInfo con estado fijo y listeners, para probar el helper sin depender del mock global.
const netinfoFalsa = (inicial) => {
  let estado = inicial;
  const listeners = new Set();
  return {
    mock: {default: {
      fetch: async () => estado,
      addEventListener: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    }},
    emitir: (nuevo) => { estado = nuevo; listeners.forEach((fn) => fn(nuevo)); },
    cantidad: () => listeners.size,
  };
};

const ventanaFalsa = () => {
  const listeners = new Map();
  return {
    addEventListener: (evento, fn) => listeners.set(evento, fn),
    removeEventListener: (evento, fn) => { if (listeners.get(evento) === fn) listeners.delete(evento); },
    disparar: (evento) => listeners.get(evento)?.(),
    escucha: (evento) => listeners.has(evento),
  };
};

const SIN_INTERNET = {isConnected: true, isInternetReachable: false};
const CON_INTERNET = {isConnected: true, isInternetReachable: true};

test('web: hayRed sigue a navigator.onLine aunque NetInfo haya quedado en «sin internet»', async () => {
  const red = netinfoFalsa(SIN_INTERNET);
  const r = await setup('web', {mocks: {'@react-native-community/netinfo': red.mock}});
  const conectividad = r.load('./conectividad');
  r.setNavigator({onLine: true});
  assert.equal(await conectividad.hayRed(), true);
  assert.equal(conectividad.hayRedEn(SIN_INTERNET), true);
  red.emitir(CON_INTERNET);
  r.setNavigator({onLine: false});
  assert.equal(await conectividad.hayRed(), false);
  assert.equal(conectividad.hayRedEn(CON_INTERNET), false);
});

test('nativo: hayRed usa NetInfo y un fetch que falla cuenta como sin red', async () => {
  const red = netinfoFalsa(CON_INTERNET);
  const r = await setup('android', {mocks: {'@react-native-community/netinfo': red.mock}});
  const conectividad = r.load('./conectividad');
  r.setNavigator({onLine: false});
  assert.equal(await conectividad.hayRed(), true);
  red.emitir(SIN_INTERNET);
  assert.equal(await conectividad.hayRed(), false);
  red.emitir({isConnected: true, isInternetReachable: null});
  assert.equal(await conectividad.hayRed(), true, 'null es «todavía no se sabe»: no frena la cola');
  red.mock.default.fetch = async () => { throw new Error('NetInfo no disponible'); };
  assert.equal(await conectividad.hayRed(), false);
});

test('web: escucharReconexion avisa con el evento online del navegador y se desuscribe', async () => {
  const red = netinfoFalsa(SIN_INTERNET);
  const r = await setup('web', {mocks: {'@react-native-community/netinfo': red.mock}});
  const ventana = ventanaFalsa();
  r.setGlobal('window', ventana);
  const conectividad = r.load('./conectividad');
  let avisos = 0;
  const dejar = conectividad.escucharReconexion(() => { avisos += 1; });
  assert.equal(red.cantidad(), 0, 'en web no se escucha a NetInfo');
  ventana.disparar('online');
  assert.equal(avisos, 1);
  dejar();
  assert.equal(ventana.escucha('online'), false);
});

test('nativo: escucharReconexion avisa solo al pasar de sin red a con red', async () => {
  const red = netinfoFalsa(SIN_INTERNET);
  const r = await setup('android', {mocks: {'@react-native-community/netinfo': red.mock}});
  const conectividad = r.load('./conectividad');
  let avisos = 0;
  const dejar = conectividad.escucharReconexion(() => { avisos += 1; });
  red.emitir(SIN_INTERNET);
  red.emitir(CON_INTERNET);
  red.emitir(CON_INTERNET);
  assert.equal(avisos, 1);
  red.emitir(SIN_INTERNET);
  red.emitir(CON_INTERNET);
  assert.equal(avisos, 2);
  dejar();
  assert.equal(red.cantidad(), 0);
});

test('web: la cola de Becas sale al volver la red aunque NetInfo siga en «sin internet»', async () => {
  const red = netinfoFalsa(SIN_INTERNET);
  const r = await setup('web', {mocks: {'@react-native-community/netinfo': red.mock}});
  r.setNavigator({onLine: false});
  const posts = [];
  r.setFetch(async (url, options) => {
    if (options?.method === 'POST') { posts.push(url); return response(201, {id: 99}); }
    return response(200, []);
  });
  await r.service.saveBecasFormulario({relevamiento_id: 1, version_capturada: 3,
    datos_identificacion: {dni: '12345678'}, data: {globales: {}, requisitos: {}}});
  assert.equal(posts.length, 0, 'sin red para el navegador no se intenta');
  assert.equal(await r.service.getPendingCount(), 1);
  // Volvió la red, pero NetInfo web sigue con su prueba de `/` hecha sin señal.
  r.setNavigator({onLine: true});
  await r.service.syncPendingOperations();
  assert.equal(posts.length, 1);
  assert.equal(await r.service.getPendingCount(), 0);
});
