// Respuesta al toque: escala al apoyar el dedo, vibración corta solo al elegir.
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

function load(relative, mocks) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInContext('(function(require,module,exports){' + code + '\n})', vm.createContext({console}))(name => {
    assert.ok(mocks[name], 'Missing mock: ' + name); return mocks[name];
  }, module, module.exports);
  return module.exports;
}

function loadTokens() {
  const exported = {};
  const code = transformSync(fs.readFileSync(path.join(root, 'src/theme/tokens.js'), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']}).code;
  vm.runInNewContext(code, {exports: exported});
  return exported;
}

test('vibrarSeleccion: 10 ms en Android y web, nada en iOS, sin romper si falla', () => {
  const {vibrarSeleccion} = load('src/utils/haptica.js', {'react-native': {Platform: {OS: 'android'}, Vibration: {}}});
  const llamadas = [];
  assert.equal(vibrarSeleccion('android', ms => llamadas.push(ms)), true);
  assert.equal(vibrarSeleccion('web', ms => llamadas.push(ms)), true);
  assert.equal(vibrarSeleccion('ios', ms => llamadas.push(ms)), false);
  assert.deepEqual(llamadas, [10, 10]);
  assert.equal(vibrarSeleccion('android', () => { throw new Error('sin permiso'); }), false);
});

async function montar(props, {reduce = false} = {}) {
  const animaciones = [];
  const vibraciones = [];
  const Animated = {
    Value: class { constructor(v) { this.v = v; } },
    View: 'AnimatedView',
    timing: (valor, config) => ({start: () => animaciones.push(config.toValue)}),
  };
  const native = {Animated, Easing: {bezier: () => t => t}, Pressable: 'Pressable'};
  const PressableScale = load('src/components/PressableScale.js', {
    react: React, 'react-native': native, '../theme': loadTokens(),
    '../hooks/useReduceMotion': {__esModule: true, default: () => reduce},
    '../utils/haptica': {vibrarSeleccion: () => vibraciones.push(1)},
  }).default;
  let tree;
  await renderer.act(async () => {tree = renderer.create(React.createElement(PressableScale, props));});
  return {tree, animaciones, vibraciones, pressable: () => tree.root.findByType('Pressable')};
}

test('PressableScale: se achica a 0,97 al apoyar y vuelve a 1 al soltar', async () => {
  const eventos = [];
  const ui = await montar({onPressIn: () => eventos.push('in'), onPress: () => eventos.push('press')});
  ui.pressable().props.onPressIn();
  ui.pressable().props.onPressOut();
  ui.pressable().props.onPress();
  assert.deepEqual(ui.animaciones, [0.97, 1]);
  assert.deepEqual(eventos, ['in', 'press']);
  assert.equal(ui.vibraciones.length, 0);
});

test('PressableScale: vibra solo con haptic, y deshabilitado no se achica', async () => {
  const ui = await montar({haptic: true, disabled: true});
  ui.pressable().props.onPressIn();
  assert.deepEqual(ui.animaciones, []);
  ui.pressable().props.onPress();
  assert.equal(ui.vibraciones.length, 1);
});

test('PressableScale: con «reducir movimiento» no anima, pero el toque funciona', async () => {
  let tocado = false;
  const ui = await montar({onPress: () => { tocado = true; }}, {reduce: true});
  ui.pressable().props.onPressIn();
  ui.pressable().props.onPressOut();
  ui.pressable().props.onPress();
  assert.deepEqual(ui.animaciones, []);
  assert.equal(tocado, true);
});
