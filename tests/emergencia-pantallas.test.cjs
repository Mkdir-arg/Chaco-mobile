// Pantalla inicial de Emergencia y selector de módulos, con el servicio de perfil real sobre el
// runtime de prueba (fetch y almacenamiento simulados).
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

const root = path.join(__dirname, '..');
const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator', 'RefreshControl']
  .map(name => [name, name]));
const plataforma = {OS: 'android'};
Object.assign(native, {StyleSheet: {create: value => value}, Platform: plataforma});
const theme = {colors: new Proxy({}, {get: () => '#5059BC'})};
const typography = {bold: 'Manrope', medium: 'Manrope', semibold: 'Manrope', regular: 'Manrope'};
const text = node => node.children.map(value => typeof value === 'string' ? value : text(value)).join('');
const SIN_TAREAS = 'No tenés tareas en la app. Pedí que te sumen al equipo de un dispositivo.';

function loadPure(relative) {
  const {code} = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInNewContext('(function(module,exports){' + code + '\n})', {})(module, module.exports);
  return module.exports;
}

function loadScreen(relative, mocks) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Date});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(
    name => { assert.ok(mocks[name], 'Missing screen mock: ' + name); return mocks[name]; }, module, module.exports);
  return module.exports.default;
}

const esperar = () => new Promise(resolve => setTimeout(resolve, 0));

async function montarInicio(handler, {antes, props: extra = {}} = {}) {
  const r = await setup();
  r.setFetch(async () => response(200, {token: 'tok', user_id: 7, username: 'agente', modulos: ['emergencia']}));
  await r.api.loginBecas({username: 'agente', password: 'x'});
  const perfil = r.load('./emergenciaPerfil');
  if (antes) await antes(r, perfil);
  const pedidos = [];
  r.setFetch(async (url) => { pedidos.push(String(url)); return handler(String(url)); });
  const Screen = loadScreen('src/screens/EmergenciaInicioScreen.js', {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../theme/statusBadges': loadPure('src/theme/statusBadges.js'),
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../services/emergenciaPerfil': perfil,
    '../theme': loadPure('src/theme/tokens.js'),
  });
  const abiertos = [];
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(Screen, {onAbrir: acceso => abiertos.push(acceso.clave), ...extra}));
  });
  await renderer.act(async () => { await esperar(); });
  const labels = () => tree.root.findAllByType('Text').map(text);
  const accesos = () => tree.root.findAllByType('Pressable').map(node => node.props.accessibilityLabel);
  const press = async label => {
    const boton = tree.root.findAllByType('Pressable').find(node => node.props.accessibilityLabel === label);
    assert.ok(boton, 'Missing acceso ' + label);
    await renderer.act(async () => { boton.props.onPress(); });
  };
  const rerender = async props => renderer.act(async () => {
    tree.update(React.createElement(Screen, {onAbrir: acceso => abiertos.push(acceso.clave), ...extra, ...props}));
    await esperar();
  });
  return {r, perfil, tree, labels, accesos, press, abiertos, pedidos, rerender,
    close: () => renderer.act(async () => tree.unmount())};
}

test('Inicio: con el perfil completo muestra los tres accesos y cada uno avisa al tocarlo', async () => {
  const ui = await montarInicio(() => response(200, {relevar: true, dispositivo: true, llegadas: true, kits: true}));
  try {
    assert.deepEqual(ui.accesos(), ['Ingreso de familias', 'Llegada de familias', 'Recepción de kits']);
    assert.ok(ui.pedidos[0].endsWith('/api/emergencia/perfil/'));
    await ui.press('Recepción de kits');
    assert.deepEqual(ui.abiertos, ['kits']);
    assert.ok(!ui.labels().includes(SIN_TAREAS));
  } finally { await ui.close(); }
});

test('Inicio: solo relevar, y con perfil viejo `dispositivo` da llegadas y kits', async () => {
  let ui = await montarInicio(() => response(200, {relevar: true, dispositivo: false}));
  try { assert.deepEqual(ui.accesos(), ['Ingreso de familias']); } finally { await ui.close(); }
  ui = await montarInicio(() => response(200, {relevar: false, dispositivo: true}));
  try { assert.deepEqual(ui.accesos(), ['Llegada de familias', 'Recepción de kits']); } finally { await ui.close(); }
});

test('Inicio: sin ningun acceso muestra el texto del contrato', async () => {
  const ui = await montarInicio(() => response(200, {relevar: false, dispositivo: false}));
  try {
    assert.deepEqual(ui.accesos(), []);
    assert.ok(ui.labels().includes(SIN_TAREAS));
  } finally { await ui.close(); }
});

test('Inicio: sin red arranca con el perfil guardado y lo avisa', async () => {
  const ui = await montarInicio(() => { throw new TypeError('Load failed'); }, {
    antes: async (r, perfil) => {
      r.setFetch(async () => response(200, {relevar: true, dispositivo: false}));
      await perfil.cargarPerfil();
    },
  });
  try {
    assert.deepEqual(ui.accesos(), ['Ingreso de familias']);
    assert.ok(ui.labels().includes('Sin conexión: se muestran tus accesos guardados.'));
  } finally { await ui.close(); }
});

test('Inicio: sin red y sin nada guardado ofrece reintentar', async () => {
  let red = false;
  const ui = await montarInicio(() => {
    if (!red) throw new TypeError('Load failed');
    return response(200, {relevar: true, dispositivo: false});
  });
  try {
    assert.deepEqual(ui.accesos(), []);
    assert.ok(!ui.labels().includes(SIN_TAREAS), 'sin perfil no se dice que no tiene tareas');
    assert.ok(ui.labels().includes('Sin conexión: no se pudo cargar tu perfil.'), 'sin red, un texto claro y no el error tecnico');
    assert.ok(!ui.labels().some(t => /Network request failed|Load failed/.test(t)));
    const reintentar = ui.tree.root.findAllByType('CustomButton').find(node => node.props.title === 'Reintentar');
    assert.ok(reintentar);
    red = true;
    await renderer.act(async () => { await reintentar.props.onPress(); });
    assert.deepEqual(ui.accesos(), ['Ingreso de familias']);
  } finally { await ui.close(); }
});

test('Inicio: cuando otra pantalla re-pide el perfil (403 parcial), los accesos se actualizan', async () => {
  let perfil = {relevar: true, dispositivo: true};
  const ui = await montarInicio(() => response(200, perfil));
  try {
    assert.deepEqual(ui.accesos(), ['Ingreso de familias', 'Llegada de familias', 'Recepción de kits']);
    perfil = {relevar: false, dispositivo: true, llegadas: true, kits: false};
    await renderer.act(async () => {
      await ui.perfil.verificarSinModulo({status: 403, payload: {code: 'SIN_MODULO'}});
    });
    assert.deepEqual(ui.accesos(), ['Llegada de familias']);
  } finally { await ui.close(); }
});

test('Inicio: el boton de sincronizar del Banner vuelve a pedir el perfil', async () => {
  const ui = await montarInicio(() => response(200, {relevar: true, dispositivo: false}));
  try {
    assert.equal(ui.pedidos.length, 1);
    await ui.rerender({recarga: 1});
    assert.equal(ui.pedidos.length, 2);
  } finally { await ui.close(); }
});

test('m4: si el back falla con red (503), el aviso de lo guardado es neutro, sin «Sin conexión»', async () => {
  const ui = await montarInicio(() => response(503, {detail: 'caido'}), {
    antes: async (r, perfil) => {
      r.setFetch(async () => response(200, {relevar: true, dispositivo: false}));
      await perfil.cargarPerfil();
    },
  });
  try {
    assert.deepEqual(ui.accesos(), ['Ingreso de familias']);
    assert.ok(ui.labels().includes('No se pudo actualizar: se muestran tus accesos guardados.'));
    assert.ok(!ui.labels().some(label => label.startsWith('Sin conexión')));
  } finally { await ui.close(); }
});

test('m2: la pantalla avisa cuando carga (para el Banner) y en web muestra actividad al recargar', async () => {
  const estados = [];
  let soltar;
  let colgar = false;
  plataforma.OS = 'web';
  const ui = await montarInicio(() => (colgar ? new Promise(resolve => { soltar = resolve; })
    : response(200, {relevar: true, dispositivo: false})), {props: {onCargando: valor => estados.push(valor)}});
  try {
    assert.deepEqual(estados, [true, false]);
    const indicadores = () => ui.tree.root.findAllByType('ActivityIndicator')
      .filter(node => node.props.accessibilityLabel === 'Actualizando tus accesos');
    assert.equal(indicadores().length, 0);
    colgar = true;
    await ui.rerender({recarga: 1});
    assert.deepEqual(estados, [true, false, true]);
    assert.equal(indicadores().length, 1, 'RN Web no dibuja el RefreshControl');
    await renderer.act(async () => { soltar(response(200, {relevar: true, dispositivo: false})); await esperar(); await esperar(); });
    assert.deepEqual(estados, [true, false, true, false]);
    assert.equal(indicadores().length, 0);
  } finally { plataforma.OS = 'android'; await ui.close(); }
});

test('m2: EmergenciaApp pasa «syncing» al Banner mientras carga el perfil', async () => {
  let onCargando;
  const App = loadScreen('src/navigation/EmergenciaApp.js', {
    react: React, 'react-native': native,
    '../context/AuthContext': {useAuth: () => ({user: {nombre: 'Ana'}, logout() {}})},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showAlert() {}})},
    '../components/Banner': {__esModule: true, default: 'Banner'},
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/SettingsPanel': {__esModule: true, default: 'SettingsPanel'},
    '../screens/EmergenciaInicioScreen': {__esModule: true, default: props => { onCargando = props.onCargando; return null; }},
    '../screens/EmergenciaMisEnviosScreen': {__esModule: true, default: () => null},
    '../screens/EmergenciaFormulario1Screen': {__esModule: true, default: () => null},
    '../screens/EmergenciaMisDispositivosScreen': {__esModule: true, default: () => null},
    '../screens/EmergenciaEntregasScreen': {__esModule: true, default: () => null},
    '../screens/EmergenciaRecibirEntregaScreen': {__esModule: true, default: () => null},
    '../screens/EmergenciaLlegadaBuscarScreen': {__esModule: true, default: () => null},
    '../screens/EmergenciaDerivacionScreen': {__esModule: true, default: () => null},
    '../screens/EmergenciaIntegrantesScreen': {__esModule: true, default: () => null},
    '../screens/EmergenciaFichaScreen': {__esModule: true, default: () => null},
    '@react-native-community/netinfo': {__esModule: true, default: {addEventListener: () => () => {}}},
    '../services/emergenciaCola': {syncPendientes: async () => ({}), getPendingCount: async () => 0,
      reintentar: async () => ({}), getLocalidadesGuardadas: async () => ({localidades: []})},
    '../utils/emergencia': {avisoDeSalida: () => null},
  });
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(App)); });
  try {
    const estado = () => tree.root.findByType('Banner').props.syncStatus;
    assert.equal(estado(), 'synced');
    await renderer.act(async () => { onCargando(true); });
    assert.equal(estado(), 'syncing');
    await renderer.act(async () => { onCargando(false); });
    assert.equal(estado(), 'synced');
  } finally { await renderer.act(async () => tree.unmount()); }
});

test('m6: accesibilidad del Inicio: titulo como encabezado, iconos decorativos y feedback al tocar', async () => {
  const ui = await montarInicio(() => response(200, {relevar: true, dispositivo: true}));
  try {
    const titulo = ui.tree.root.findAllByType('Text').find(node => text(node) === 'Emergencia');
    assert.equal(titulo.props.accessibilityRole, 'header');
    for (const icono of ui.tree.root.findAllByType('Ionicons')) {
      assert.equal(icono.props.accessible, false);
      assert.equal(icono.props.importantForAccessibility, 'no');
    }
    const card = ui.tree.root.findAllByType('Pressable')[0];
    assert.equal(typeof card.props.style, 'function', 'el estilo depende de pressed');
    const plano = estilo => Object.assign({}, ...[estilo].flat(Infinity).filter(Boolean));
    assert.equal(plano(card.props.style({pressed: false})).opacity, undefined);
    assert.ok(plano(card.props.style({pressed: true})).opacity < 1);
  } finally { await ui.close(); }
});

test('Selector: Emergencia aparece con su icono, en orden', async () => {
  const Screen = loadScreen('src/screens/ModuloSelectorScreen.js', {
    react: React, 'react-native': native,
    '../components/AuthVisualBackground': {__esModule: true, default: 'AuthVisualBackground'},
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../context/AuthContext': {useAuth: () => ({user: {nombre: 'Ana'}, modulos: ['becas', 'dispositivos', 'emergencia'],
      elegirModulo() {}, logout() {}})},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../services/modulos': loadPure('src/services/modulos.js'),
    '../theme': loadPure('src/theme/tokens.js'),
  });
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
  try {
    const botones = tree.root.findAllByType('CustomButton').map(node => [node.props.title, node.props.iconLeft]);
    assert.deepEqual(botones.slice(0, 3), [['Becas', 'school-outline'], ['Dispositivos', 'business-outline'],
      ['Emergencia', 'medkit-outline']]);
  } finally { await renderer.act(async () => tree.unmount()); }
});

test('m5: el login muestra por que se cerro la sesion y lo limpia al volver a entrar', async () => {
  const limpiados = [];
  let avisoSesion = 'El usuario no tiene acceso al módulo Emergencia.';
  const nativeLogin = {...native, Image: 'Image', KeyboardAvoidingView: 'KeyboardAvoidingView', Linking: {openURL() {}}};
  const Screen = loadScreen('src/screens/LoginScreen.js', {
    react: React, 'react-native': nativeLogin, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../components/FormInput': {__esModule: true, default: 'TextInput', FormInputContainer: 'FormInputContainer'},
    '../context/ThemeContext': {useTheme: () => ({theme, typography,
      branding: {assets: {logo: 1}, applicationName: 'Chaco', loginSubtitle: ''}})},
    '../context/AuthContext': {useAuth: () => ({login: async () => ({success: false, error: 'Credenciales invalidas'}),
      avisoSesion, limpiarAvisoSesion: () => { limpiados.push(true); avisoSesion = null; }})},
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/PwaInstallGuide': {__esModule: true, default: 'PwaInstallGuide'},
    '../components/AuthVisualBackground': {__esModule: true, default: 'AuthVisualBackground'},
    '../theme': loadPure('src/theme/tokens.js'),
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '../config/apiConfig': {API_CONFIG: {djangoBaseUrl: 'https://example.test'}},
    '../services/versionApp': {versionActual: () => '1.2.11'},
  });
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Screen)); });
  try {
    const textos = () => tree.root.findAllByType('Text').map(text);
    assert.ok(textos().includes('El usuario no tiene acceso al módulo Emergencia.'));
    const inputs = tree.root.findAllByType('TextInput');
    await renderer.act(async () => { inputs[0].props.onChangeText('agente'); inputs[1].props.onChangeText('clave'); });
    const entrar = tree.root.findAllByType('CustomButton').find(node => typeof node.props.onPress === 'function'
      && /ingresar|iniciar|entrar/i.test(String(node.props.title)));
    assert.ok(entrar, 'boton de ingreso');
    await renderer.act(async () => { await entrar.props.onPress(); });
    assert.equal(limpiados.length, 1);
    assert.ok(textos().includes('Credenciales invalidas'));
  } finally { await renderer.act(async () => tree.unmount()); }
});
