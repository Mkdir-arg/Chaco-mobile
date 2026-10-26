// Permisos en nativo (src/services/permisos.js): mapeo de estados de expo-location y
// expo-image-picker, y «Abrir ajustes» con Linking.openSettings.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {transformSync} = require('@babel/core');

const root = path.join(__dirname, '..');

function cargarPermisos({ubicacion = {}, camara = {}} = {}) {
  const llamadas = {ajustes: 0, appState: []};
  const mocks = {
    'react-native': {
      AppState: {addEventListener: (tipo, manejador) => { llamadas.appState.push([tipo, manejador]); return {remove() { llamadas.removido = true; }}; }},
      Linking: {openSettings: async () => { llamadas.ajustes += 1; }},
    },
    'expo-location': {
      getForegroundPermissionsAsync: async () => ubicacion.leer(),
      requestForegroundPermissionsAsync: async () => ubicacion.pedir(),
    },
    'expo-image-picker': {
      getCameraPermissionsAsync: async () => camara.leer(),
      requestCameraPermissionsAsync: async () => camara.pedir(),
    },
  };
  const filename = path.join(root, 'src/services/permisos.js');
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  new Function('require', 'module', 'exports', code)(nombre => {
    assert.ok(mocks[nombre], 'Missing mock ' + nombre);
    return {__esModule: true, ...mocks[nombre]};
  }, module, module.exports);
  return {permisos: module.exports, llamadas};
}

const CASOS = [
  ['granted', {status: 'granted', granted: true, canAskAgain: true}, {estado: 'granted', canAskAgain: true}, 'Permitido'],
  ['denied con canAskAgain', {status: 'denied', granted: false, canAskAgain: true}, {estado: 'denied', canAskAgain: true}, 'Bloqueado'],
  ['denied sin canAskAgain', {status: 'denied', granted: false, canAskAgain: false}, {estado: 'denied', canAskAgain: false}, 'Bloqueado'],
  ['undetermined', {status: 'undetermined', granted: false, canAskAgain: true}, {estado: 'prompt', canAskAgain: true}, 'Sin pedir'],
];

test('expo-location y expo-image-picker: consultar y pedir traducen cada estado', async () => {
  for (const [nombre, entrada, esperado, etiqueta] of CASOS) {
    const {permisos} = cargarPermisos({
      ubicacion: {leer: async () => entrada, pedir: async () => entrada},
      camara: {leer: async () => entrada, pedir: async () => entrada},
    });
    for (const clave of ['ubicacion', 'camara']) {
      for (const accion of [permisos.consultarPermiso, permisos.pedirPermiso]) {
        const resultado = await accion(clave);
        assert.equal(resultado.estado, esperado.estado, `${clave} ${nombre}`);
        assert.equal(resultado.canAskAgain, esperado.canAskAgain, `${clave} ${nombre}`);
        assert.equal(permisos.ETIQUETAS_ESTADO[resultado.estado], etiqueta);
      }
    }
  }
});

test('un error del módulo nativo es «No se puede saber» y nunca se propaga; pedir vuelve a consultar', async () => {
  const falla = async () => { throw new Error('nativo'); };
  const {permisos} = cargarPermisos({ubicacion: {leer: falla, pedir: falla}, camara: {leer: falla, pedir: falla}});
  for (const clave of ['ubicacion', 'camara']) {
    assert.deepEqual({...await permisos.consultarPermiso(clave)}, {estado: 'unknown', canAskAgain: true});
    assert.deepEqual({...await permisos.pedirPermiso(clave)}, {estado: 'unknown', canAskAgain: true});
  }
  const {permisos: p2} = cargarPermisos({
    ubicacion: {leer: async () => ({status: 'denied', canAskAgain: false}), pedir: falla},
    camara: {leer: async () => ({status: 'undetermined'}), pedir: falla},
  });
  assert.equal((await p2.pedirPermiso('ubicacion')).estado, 'denied');
  assert.equal((await p2.pedirPermiso('camara')).estado, 'prompt');
});

test('«Abrir ajustes» llama a Linking.openSettings y volver al frente refresca', async () => {
  const {permisos, llamadas} = cargarPermisos();
  await permisos.abrirAjustes();
  assert.equal(llamadas.ajustes, 1);
  let refrescos = 0;
  const baja = permisos.alVolverAlFrente(() => { refrescos += 1; });
  const [tipo, manejador] = llamadas.appState[0];
  assert.equal(tipo, 'change');
  manejador('background');
  manejador('active');
  assert.equal(refrescos, 1);
  baja();
  assert.equal(llamadas.removido, true);
});
