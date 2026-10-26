// usePermisos y la sección Permisos de SettingsPanel: desmontaje, «Pidiendo…» y «Abrir ajustes».
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

function cargar(relative, mocks) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, Symbol, Promise});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(nombre => {
    assert.ok(mocks[nombre], 'Missing mock: ' + nombre); return mocks[nombre];
  }, module, module.exports);
  return module.exports;
}

const diferido = () => {
  let resolver;
  const promesa = new Promise(resolve => { resolver = resolve; });
  return {promesa, resolver};
};

// React con los setters de useState registrados: permite saber si algo se seteó tras desmontar.
function reactContado(registro) {
  return {...React, useState: inicial => {
    const [valor, set] = React.useState(inicial);
    const envuelto = React.useCallback(nuevo => { registro.push(registro.desmontado === true); return set(nuevo); }, [set]);
    return [valor, envuelto];
  }};
}

async function montarHook({consultar, pedir, esperaMs}) {
  const registro = [];
  const escuchas = {};
  const servicio = {
    PERMISOS: ['ubicacion', 'camara'],
    consultarPermiso: consultar, pedirPermiso: pedir,
    observarPermiso: (clave, alCambiar) => { escuchas[clave] = alCambiar; return () => {}; },
    alVolverAlFrente: alVolver => { escuchas.frente = alVolver; return () => {}; },
  };
  const usePermisos = cargar('src/hooks/usePermisos.js', {react: reactContado(registro), '../services/permisos': servicio}).default;
  let api;
  const Sonda = () => { api = usePermisos(true, {esperaMs}); return null; };
  let arbol;
  await renderer.act(async () => { arbol = renderer.create(React.createElement(Sonda)); });
  return {
    api: () => api, escuchas,
    desmontar: async () => { await renderer.act(async () => arbol.unmount()); registro.desmontado = true; },
    setearTrasDesmontar: () => registro.filter(Boolean).length,
  };
}

const GRANTED = {estado: 'granted', canAskAgain: true};
const PROMPT = {estado: 'prompt', canAskAgain: true};

test('D1: cerrar el perfil mientras se pide un permiso no setea estado después', async () => {
  const pedido = diferido();
  const ui = await montarHook({consultar: async () => PROMPT, pedir: () => pedido.promesa});
  let promesa;
  await renderer.act(async () => { promesa = ui.api().pedir('ubicacion'); });
  await ui.desmontar();
  await renderer.act(async () => { pedido.resolver(GRANTED); await promesa; });
  assert.equal(ui.setearTrasDesmontar(), 0);
});

test('D1: un refresco asíncrono y los listeners que terminan después de desmontar no setean estado', async () => {
  const lectura = diferido();
  let colgar = false;
  const ui = await montarHook({consultar: () => (colgar ? lectura.promesa : Promise.resolve(PROMPT)), pedir: async () => GRANTED});
  colgar = true;
  await renderer.act(async () => { ui.escuchas.ubicacion(); ui.escuchas.frente(); });
  await ui.desmontar();
  await renderer.act(async () => { lectura.resolver(GRANTED); await new Promise(resolve => setTimeout(resolve, 5)); });
  assert.equal(ui.setearTrasDesmontar(), 0);
});

test('D2: mientras se pide, esa clave queda en «pidiendo» y se libera al terminar', async () => {
  const pedido = diferido();
  const ui = await montarHook({consultar: async () => PROMPT, pedir: () => pedido.promesa});
  let promesa;
  await renderer.act(async () => { promesa = ui.api().pedir('ubicacion'); });
  assert.equal(ui.api().pidiendo.ubicacion, true);
  assert.equal(ui.api().pidiendo.camara, undefined);
  await renderer.act(async () => { pedido.resolver(GRANTED); await promesa; });
  assert.equal(ui.api().pidiendo.ubicacion, false);
  assert.equal(ui.api().permisos.ubicacion.estado, 'granted');
  await ui.desmontar();
});

test('D2: un diálogo ignorado vence, vuelve a consultar el estado y libera el botón', async () => {
  let estado = PROMPT;
  const ui = await montarHook({consultar: async () => estado, pedir: () => new Promise(() => {}), esperaMs: 20});
  let promesa;
  await renderer.act(async () => { promesa = ui.api().pedir('camara'); });
  assert.equal(ui.api().pidiendo.camara, true);
  estado = {estado: 'denied', canAskAgain: false};
  await renderer.act(async () => { await promesa; });
  assert.equal(ui.api().pidiendo.camara, false);
  assert.equal(ui.api().permisos.camara.estado, 'denied');
  await ui.desmontar();
});

// ---------------------------------------------------------------- SettingsPanel
function loadTokens() {
  const exported = {};
  const code = transformSync(fs.readFileSync(path.join(root, 'src/theme/tokens.js'), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']}).code;
  vm.runInNewContext(code, {exports: exported});
  return exported;
}

async function montarPanel({os = 'android', leer, pedir}) {
  const llamadas = {ajustes: 0};
  const nativos = {
    ...Object.fromEntries(['View', 'Text', 'Pressable', 'Modal', 'ScrollView', 'Switch'].map(n => [n, n])),
    Platform: {OS: os}, StyleSheet: {create: v => v, absoluteFillObject: {}},
    Dimensions: {get: () => ({width: 400, height: 800})},
    Animated: {View: 'AnimatedView', Value: class { constructor(v) { this.v = v; } },
      spring: () => ({start() {}}), timing: () => ({start(cb) { if (cb) cb(); }})},
    AppState: {addEventListener: () => ({remove() {}})},
    Linking: {openSettings: async () => { llamadas.ajustes += 1; }},
  };
  const theme = {colors: new Proxy({}, {get: () => '#5059BC'})};
  const permisosNativo = cargar('src/services/permisos.js', {
    'react-native': nativos,
    'expo-location': {getForegroundPermissionsAsync: leer, requestForegroundPermissionsAsync: pedir},
    'expo-image-picker': {getCameraPermissionsAsync: leer, requestCameraPermissionsAsync: pedir},
  });
  const usePermisos = cargar('src/hooks/usePermisos.js', {react: React, '../services/permisos': permisosNativo}).default;
  const Panel = cargar('src/components/SettingsPanel.js', {
    react: React, 'react-native': nativos,
    '@expo/vector-icons': {Ionicons: 'Ionicons'}, 'expo-linear-gradient': {LinearGradient: 'LinearGradient'},
    '../context/ThemeContext': {useTheme: () => ({theme, isDark: false, toggleTheme() {}, typography: {medium: 'M', regular: 'R', bold: 'B', semibold: 'S'}})},
    '../context/AuthContext': {useAuth: () => ({user: {username: 'ana'}})},
    './CustomButton': {__esModule: true, default: 'CustomButton'},
    './AvisosContador': {__esModule: true, default: 'AvisosContador'},
    '../hooks/usePermisos': {__esModule: true, default: usePermisos},
    '../services/permisos': permisosNativo,
    '../theme': loadTokens(),
  }).default;
  let arbol;
  await renderer.act(async () => {
    arbol = renderer.create(React.createElement(Panel, {visible: true, onClose() {}, onLogout() {}, onOpenAvisos() {}}));
  });
  const botones = () => arbol.root.findAllByType('CustomButton').map(n => n.props)
    .filter(props => ['Permitir', 'Pidiendo…', 'Abrir ajustes'].includes(props.title));
  return {arbol, botones, llamadas, cerrar: () => renderer.act(async () => arbol.unmount())};
}

test('D2: en el panel, «Permitir» pasa a «Pidiendo…» deshabilitado mientras corre el pedido', async () => {
  const pedido = diferido();
  const ui = await montarPanel({leer: async () => ({status: 'undetermined', canAskAgain: true}), pedir: () => pedido.promesa});
  try {
    assert.deepEqual(ui.botones().map(b => b.title), ['Permitir', 'Permitir']);
    assert.ok(ui.botones().every(b => !b.disabled));
    let promesa;
    await renderer.act(async () => { promesa = ui.botones()[0].onPress(); });
    assert.deepEqual(ui.botones().map(b => [b.title, !!b.disabled]), [['Pidiendo…', true], ['Permitir', false]]);
    await renderer.act(async () => { pedido.resolver({status: 'granted', granted: true}); await promesa; });
    assert.equal(ui.botones().some(b => b.title === 'Pidiendo…'), false);
  } finally { await ui.cerrar(); }
});

test('D3: en el panel, bloqueado sin canAskAgain muestra «Abrir ajustes» y abre Linking.openSettings', async () => {
  const bloqueado = async () => ({status: 'denied', canAskAgain: false});
  const ui = await montarPanel({leer: bloqueado, pedir: bloqueado});
  try {
    assert.deepEqual(ui.botones().map(b => b.title), ['Abrir ajustes', 'Abrir ajustes']);
    await renderer.act(async () => { await ui.botones()[0].onPress(); });
    assert.equal(ui.llamadas.ajustes, 1);
  } finally { await ui.cerrar(); }
});

test('D3: en el panel, denegado con canAskAgain sigue mostrando «Permitir»', async () => {
  const ui = await montarPanel({leer: async () => ({status: 'denied', canAskAgain: true}), pedir: async () => ({status: 'granted'})});
  try {
    assert.deepEqual(ui.botones().map(b => b.title), ['Permitir', 'Permitir']);
  } finally { await ui.cerrar(); }
});
