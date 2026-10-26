// useAvisos: el aviso de «relevamiento nuevo» sale apenas se tiene el listado, sin esperar a la
// pasada de rechazos (que puede tardar). Hook real con todo lo de afuera mockeado.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const renderer = require('react-test-renderer');
const {transformSync} = require('@babel/core');
global.IS_REACT_ACT_ENVIRONMENT = true;

const root = path.join(__dirname, '..');

function loadHook(mocks) {
  const filename = path.join(root, 'src/hooks/useAvisos.js');
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, Date, Promise});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(name => {
    assert.ok(mocks[name], 'Missing mock: ' + name); return mocks[name];
  }, module, module.exports);
  return module.exports.default;
}

const diferido = () => {
  let resolver;
  const promesa = new Promise(resolve => { resolver = resolve; });
  return {promesa, resolver};
};

async function montar({rechazos, sesion = async () => true}) {
  const toasts = [];
  const db = {};
  const mocks = {
    react: React,
    '@react-native-community/netinfo': {__esModule: true, default: {fetch: async () => ({isConnected: true, isInternetReachable: true})}},
    '../services/relevamientoService': {__esModule: true, default: {
      getAvisosDb: async () => db, getOwnerIdActual: async () => '7', getOperacionesParaAvisos: async () => []}},
    '../services/becasApi': {becasRequest: async () => ({}), getBecasToken: async () => 'token'},
    '../services/avisos': {contarNoLeidos: async () => 0, listarAvisos: async () => [], marcarLeido: async () => {},
      marcarTodoLeido: async () => {}, purgarAvisosViejos: async () => {}},
    '../services/detectoresAvisos': {
      avisarSiVigente: async (ctx, creados, notificar) => { if (!(await sesion())) return false; notificar(creados); return true; },
      detectarCola: async () => [],
      detectarRelevamientosNuevos: async () => [{clave: 'rel:1'}],
      detectarRechazos: async () => rechazos.promesa},
  };
  const useAvisos = loadHook(mocks);
  let api;
  const Probe = () => { api = useAvisos({activo: true, userId: 7, onNuevos: nuevos => toasts.push(nuevos.map(a => a.clave))}); return null; };
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Probe)); });
  return {api: () => api, toasts, close: () => renderer.act(async () => tree.unmount())};
}

const refresco = {success: true, remoto_bien_formado: true, records: [{id: 1}]};

test('el aviso de relevamiento nuevo no espera a la pasada de rechazos, que sigue en su propio ciclo', async () => {
  const rechazos = diferido();
  const ui = await montar({rechazos});
  try {
    // La pasada de rechazos queda colgada: el refresco igual termina y el aviso ya salió.
    await renderer.act(async () => { await ui.api().alRefrescarRelevamientos(refresco); });
    assert.deepEqual(ui.toasts, [['rel:1']]);
    rechazos.resolver([{clave: 'rech:9'}]);
    await renderer.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.deepEqual(ui.toasts, [['rel:1'], ['rech:9']]);
  } finally { await ui.close(); }
});

test('con la sesión cambiada no sale ningún toast, ni el de relevamiento nuevo ni el de rechazos', async () => {
  const rechazos = diferido();
  rechazos.resolver([{clave: 'rech:9'}]);
  const ui = await montar({rechazos, sesion: async () => false});
  try {
    await renderer.act(async () => { await ui.api().alRefrescarRelevamientos(refresco); });
    await renderer.act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    assert.deepEqual(ui.toasts, []);
  } finally { await ui.close(); }
});
