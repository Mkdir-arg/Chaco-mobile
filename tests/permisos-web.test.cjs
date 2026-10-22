const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./helpers/mobile-runtime.cjs');

const cargar = async (nav) => {
  const r = await setup('web');
  r.setNavigator(nav);
  return {r, permisos: r.load('./permisos.web')};
};
const consulta = (estados) => ({query: async ({name}) => {
  const state = estados[name];
  if (state instanceof Error) throw state;
  return {state};
}});

test('el estado del navegador se traduce a Permitido / Sin pedir / Bloqueado', async () => {
  const {permisos} = await cargar({permissions: consulta({geolocation: 'granted', camera: 'prompt'})});
  const gps = await permisos.consultarPermiso('ubicacion');
  const cam = await permisos.consultarPermiso('camara');
  assert.equal(permisos.ETIQUETAS_ESTADO[gps.estado], 'Permitido');
  assert.equal(permisos.ETIQUETAS_ESTADO[cam.estado], 'Sin pedir');
  const {permisos: p2} = await cargar({permissions: consulta({geolocation: 'denied', camera: 'denied'})});
  const bloqueado = await p2.consultarPermiso('ubicacion');
  assert.equal(p2.ETIQUETAS_ESTADO[bloqueado.estado], 'Bloqueado');
  assert.equal(bloqueado.canAskAgain, false);
});

test('sin API de permisos (o con error) el estado es "No se puede saber" y se puede pedir igual', async () => {
  for (const nav of [undefined, {}, {permissions: consulta({camera: new TypeError('Safari')})}]) {
    const {permisos} = await cargar(nav);
    const cam = await permisos.consultarPermiso('camara');
    assert.equal(permisos.ETIQUETAS_ESTADO[cam.estado], 'No se puede saber');
    assert.equal(cam.canAskAgain, true);
  }
});

test('Permitir en Camara corta todos los tracks del stream', async () => {
  const tracks = [{stopped: false, stop() {this.stopped = true;}}, {stopped: false, stop() {this.stopped = true;}}];
  let pedido;
  const {permisos} = await cargar({
    permissions: consulta({camera: 'granted'}),
    mediaDevices: {getUserMedia: async (c) => {pedido = c; return {getTracks: () => tracks};}},
  });
  const r = await permisos.pedirPermiso('camara');
  assert.deepEqual({...pedido}, {video: true});
  assert.ok(tracks.every(t => t.stopped), 'quedo un track abierto');
  assert.equal(r.estado, 'granted');
});

test('Permitir en Ubicacion no guarda ni devuelve la posicion', async () => {
  let opciones;
  const {r, permisos} = await cargar({
    permissions: consulta({geolocation: 'granted'}),
    geolocation: {getCurrentPosition: (ok, fail, o) => {opciones = o; ok({coords: {latitude: -27.4, longitude: -58.9}});}},
  });
  const antes = JSON.stringify([...r.values.entries()]);
  const filas = r.sql.prepare('SELECT COUNT(*) n FROM local_relevamientos').get().n;
  const res = await permisos.pedirPermiso('ubicacion');
  assert.equal(res.estado, 'granted');
  assert.ok(opciones.timeout > 0, 'sin timeout');
  assert.equal(JSON.stringify(res).includes('-27.4'), false);
  assert.equal(JSON.stringify([...r.values.entries()]), antes);
  assert.equal(r.sql.prepare('SELECT COUNT(*) n FROM local_relevamientos').get().n, filas);
});

test('un error o timeout no rompe y deja el estado coherente', async () => {
  const denegado = Object.assign(new Error('denied'), {code: 1});
  const {permisos} = await cargar({
    permissions: consulta({geolocation: 'denied', camera: new Error('sin api')}),
    geolocation: {getCurrentPosition: (ok, fail) => fail(denegado)},
    mediaDevices: {getUserMedia: async () => {throw Object.assign(new Error('x'), {name: 'NotAllowedError'});}},
  });
  assert.equal((await permisos.pedirPermiso('ubicacion')).estado, 'denied');
  // Safari: no se puede consultar, pero el rechazo del usuario se reconoce
  assert.equal((await permisos.pedirPermiso('camara')).estado, 'denied');
  // timeout (code 3): sin API, el estado sigue sin poder saberse y nada se propaga
  const {permisos: p2} = await cargar({
    permissions: consulta({geolocation: new Error('x')}),
    geolocation: {getCurrentPosition: (ok, fail) => fail({code: 3})},
  });
  assert.equal((await p2.pedirPermiso('ubicacion')).estado, 'unknown');
  // sin geolocation ni mediaDevices
  const {permisos: p3} = await cargar({});
  assert.equal((await p3.pedirPermiso('ubicacion')).estado, 'unknown');
  assert.equal((await p3.pedirPermiso('camara')).estado, 'unknown');
});

test('la ayuda de Bloqueado distingue iPhone del resto', async () => {
  const {permisos: ios} = await cargar({userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'});
  assert.match(ios.ayudaBloqueado('camara'), /Ajustes → Safari → Cámara/);
  const {permisos: and} = await cargar({userAgent: 'Mozilla/5.0 (Linux; Android 14)'});
  assert.match(and.ayudaBloqueado('ubicacion'), /candado/);
});
