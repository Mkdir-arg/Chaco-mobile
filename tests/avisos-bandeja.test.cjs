// Bandeja de avisos y contador: lo que ve el relevador.
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
const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'Modal'].map(name => [name, name]));
Object.assign(native, {StyleSheet: {create: value => value}});
const theme = {colors: new Proxy({}, {get: () => '#5059BC'})};
const typography = {bold: 'Manrope', medium: 'Manrope', regular: 'Manrope'};
const text = node => node.children.map(value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(value)).join('');

function loadTokens() {
  const exported = {};
  const code = transformSync(fs.readFileSync(path.join(root, 'src/theme/tokens.js'), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']}).code;
  vm.runInNewContext(code, {exports: exported});
  return exported;
}

function load(relative, mocks) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, Date});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(name => {
    assert.ok(mocks[name], 'Missing mock: ' + name); return mocks[name];
  }, module, module.exports);
  return module.exports.default;
}

async function montar(props) {
  const runtime = await setup();
  const mocks = {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../services/avisos': runtime.load('./avisos'), '../theme': loadTokens(),
    './CustomButton': {__esModule: true, default: 'CustomButton'}, './AvisosContador': {__esModule: true, default: load('src/components/AvisosContador.js', {
      react: React, 'react-native': native, '../context/ThemeContext': {useTheme: () => ({theme, typography})}, '../theme': loadTokens()})},
  };
  const Bandeja = load('src/components/AvisosBandeja.js', mocks);
  let tree;
  await renderer.act(async () => {tree = renderer.create(React.createElement(Bandeja, {visible: true, ...props}));});
  return {tree, labels: () => tree.root.findAllByType('Text').map(text),
    boton: () => tree.root.findAllByType('CustomButton')[0]};
}

const aviso = (id, titulo, extra = {}) => ({id, tipo: 'relevamiento_nuevo', titulo, texto: 'detalle ' + id,
  creado_en: new Date(Date.now() - 5 * 60000).toISOString(), leido_en: null, relevamiento_id: '4', ...extra});

test('bandeja vacía: dice «No tenés avisos» y no ofrece marcar todo', async () => {
  const {labels, boton} = await montar({avisos: [], noLeidos: 0});
  assert.ok(labels().includes('No tenés avisos'));
  assert.equal(boton(), undefined);
});

test('bandeja: título, texto y hace cuánto; tocar un aviso lo entrega a la app; marcar todo', async () => {
  const tocados = [];
  let marcados = 0;
  const {labels, boton, tree} = await montar({avisos: [aviso(2, 'Te asignaron el relevamiento N° 8'), aviso(1, 'Otro', {leido_en: 'x'})],
    noLeidos: 1, onPressAviso: item => tocados.push(item.id), onMarcarTodo: () => { marcados += 1; }});
  assert.ok(labels().includes('Te asignaron el relevamiento N° 8'));
  assert.ok(labels().includes('detalle 2'));
  assert.ok(labels().includes('hace 5 min'));
  assert.equal(boton().props.title, 'Marcar todo como leído');
  assert.equal(boton().props.disabled, false);
  await renderer.act(async () => { boton().props.onPress(); });
  assert.equal(marcados, 1);
  const filas = tree.root.findAllByProps({accessibilityRole: 'button'}).filter(nodo => nodo.props.accessibilityLabel === 'Otro');
  await renderer.act(async () => { filas[0].props.onPress(); });
  assert.deepEqual(tocados, [1]);
});

test('bandeja: «Marcar todo» se apaga cuando no queda nada sin leer', async () => {
  const {boton} = await montar({avisos: [aviso(1, 'Leído', {leido_en: 'x'})], noLeidos: 0});
  assert.equal(boton().props.disabled, true);
});

test('contador: no dibuja con cero y topa en 99+', async () => {
  const runtime = await setup();
  const Contador = load('src/components/AvisosContador.js', {
    react: React, 'react-native': native, '../context/ThemeContext': {useTheme: () => ({theme, typography})}, '../theme': loadTokens()});
  const dibujar = async cantidad => {
    let tree;
    await renderer.act(async () => {tree = renderer.create(React.createElement(Contador, {cantidad}));});
    return tree.toJSON();
  };
  assert.equal(await dibujar(0), null);
  const tres = await dibujar(3);
  assert.equal(text(tres), '3');
  assert.equal(text(await dibujar(150)), '99+');
  void runtime;
});
