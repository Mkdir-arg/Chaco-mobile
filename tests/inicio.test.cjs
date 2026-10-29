// Inicio: resumen del día, días con la píldora y tarjetas con chips de estado.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const renderer = require('react-test-renderer');
const {transformSync} = require('@babel/core');
const {setup} = require('./helpers/mobile-runtime.cjs');
global.IS_REACT_ACT_ENVIRONMENT = true;

const root = path.join(__dirname, '..');
const text = node => node.children.map(value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(value)).join('');

function pure(relative) {
  const {code} = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInNewContext('(function(module,exports){' + code + '\n})', {})(module, module.exports);
  return module.exports;
}

class Value {
  constructor(v) { this.v = v; }
  setValue(v) { this.v = v; }
  interpolate() { return this; }
}
const anim = () => ({start() {}, stop() {}});
const native = {
  View: 'View', Text: 'Text', ScrollView: 'ScrollView', RefreshControl: 'RefreshControl',
  StyleSheet: {create: value => value},
  Animated: {Value, View: 'AnimatedView', spring: anim, timing: anim, loop: anim},
  Easing: {out: f => f, quad: t => t, bezier: () => t => t},
};

async function montar(relevamientos, now) {
  const runtime = await setup();
  const mocks = {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    'react-native-svg': {__esModule: true, default: 'Svg', Circle: 'Circle'},
    'expo-linear-gradient': {LinearGradient: 'LinearGradient'},
    '../context/ThemeContext': {useTheme: () => ({typography: new Proxy({}, {get: () => 'Manrope'})})},
    '../components/StaggeredItem': {__esModule: true, default: ({children}) => children},
    '../components/PressableScale': {__esModule: true, default: ({containerStyle, haptic, scale, ...props}) => React.createElement('Pressable', props)},
    '../hooks/useReduceMotion': {__esModule: true, default: () => false},
    '../hooks/useAssignmentClock': {__esModule: true, default: () => now},
    '../theme/statusBadges': pure('src/theme/statusBadges.js'),
    '../theme': pure('src/theme/tokens.js'),
    '../utils/dates': runtime.dates,
  };
  const filename = path.join(root, 'src/screens/HomeScreen.js');
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInContext('(function(require,module,exports){' + code + '\n})', vm.createContext({console, Date, Math, Number, String, Array, Set}))(
    name => { assert.ok(mocks[name], 'Missing mock: ' + name); return mocks[name]; }, module, module.exports);
  let tree;
  await renderer.act(async () => {
    tree = renderer.create(React.createElement(module.exports.default, {assignedRelevamientos: relevamientos, onOpenRelevamiento() {}}));
  });
  const labels = () => tree.root.findAllByType('Text').map(text);
  const dias = () => tree.root.findAllByType('Pressable').filter(node => node.props.accessibilityState);
  return {tree, labels, dias, close: () => renderer.act(async () => tree.unmount())};
}

const iso = date => date.toISOString();
const horas = (now, h) => new Date(now.getTime() + h * 3600000);

test('resumen: cuenta terminados de hoy y avisa el que cierra pronto', async () => {
  const now = new Date();
  const ui = await montar([
    {id: 1, titulo: 'Villa Prosperidad', estado: 'EN_CURSO', localidad: 'Resistencia', fecha_asignada: iso(horas(now, -1)), fecha_hasta: iso(horas(now, 1))},
    {id: 2, titulo: 'Barrio Toba', estado: 'TERMINADO', fecha_asignada: iso(horas(now, -1)), fecha_hasta: iso(horas(now, 1)), relevados: 12},
  ], now);
  try {
    const all = ui.labels();
    assert.ok(all.includes('1 de 2 terminados hoy'), all.join('|'));
    assert.ok(all.some(label => /^Villa Prosperidad · Cierra a las \d{2}:\d{2}$/.test(label)), all.join('|'));
    assert.ok(all.includes('Hoy · 2'));
    assert.ok(all.includes('En curso'));
    assert.ok(all.includes('12 relevados'));
  } finally { await ui.close(); }
});

test('sin relevamientos hoy: lo dice y sugiere otro día', async () => {
  const ui = await montar([], new Date());
  try {
    assert.ok(ui.labels().includes('Hoy no tenés relevamientos'));
    assert.ok(ui.labels().includes('Sin relevamientos asignados para esta fecha.'));
  } finally { await ui.close(); }
});

test('elegir otro día cambia la sección y marca el día como seleccionado', async () => {
  const now = new Date();
  const manana = horas(now, 24);
  const ui = await montar([
    {id: 3, titulo: 'Fontana Norte', estado: 'ASIGNADO', fecha_asignada: iso(manana), fecha_hasta: iso(horas(manana, 2))},
  ], now);
  try {
    assert.equal(ui.dias()[0].props.accessibilityState.selected, true);
    await renderer.act(async () => { ui.dias()[1].props.onPress(); });
    assert.equal(ui.dias()[1].props.accessibilityState.selected, true);
    assert.ok(ui.labels().some(label => / · 1$/.test(label) && !label.startsWith('Hoy')));
    assert.ok(ui.labels().includes('Fontana Norte'));
  } finally { await ui.close(); }
});

test('vencido: la tarjeta muestra «Vencido» aunque el estado sea En curso', async () => {
  const now = new Date();
  const ayer = horas(now, -26);
  const ui = await montar([
    {id: 4, titulo: 'Censo viejo', estado: 'EN_CURSO', fecha_asignada: iso(ayer), fecha_hasta: iso(horas(now, -3))},
  ], now);
  try {
    const dia = ui.dias().find(node => node.props.accessibilityLabel.includes('1 relevamiento'));
    await renderer.act(async () => { dia.props.onPress(); });
    assert.ok(ui.labels().includes('Vencido'), ui.labels().join('|'));
  } finally { await ui.close(); }
});
