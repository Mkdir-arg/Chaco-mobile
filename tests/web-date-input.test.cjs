const {test} = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const renderer = require('react-test-renderer');
const fs = require('node:fs');
const vm = require('node:vm');
const {transformSync} = require('@babel/core');
global.IS_REACT_ACT_ENVIRONMENT = true;
const {code} = transformSync(fs.readFileSync('src/components/WebDateInput.js', 'utf8'), {
  babelrc: false, configFile: false,
  plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs'],
});
const target = {exports: {}};
vm.runInThisContext('(function(require,module,exports){' + code + '\n})')(name => {
  if (name === 'react') return React;
  if (name === 'react-native') return {View: 'View'};
  if (name === '../context/ThemeContext') return {useTheme: () => ({theme: {colors: {
    surface: 'white', primary: 'purple', border: 'gray', text: 'black',
  }}, typography: {medium: 'sans-serif'}, isDark: false})};
  throw new Error(name);
}, target, target.exports);
const Input = target.exports.default;

test('web calendar preserves local day, stored format, clearing and birth date limit', async () => {
  let tree;
  const changes = [];
  await renderer.act(async () => {tree = renderer.create(React.createElement(Input, {
    value: '2000-02-29', label: 'Nacimiento', required: true,
    maximumDate: new Date(2026, 9, 21, 23, 59), onSelect: value => changes.push(value),
  }));});
  const input = tree.root.findByType('input');
  assert.equal(input.props.type, 'date');
  assert.equal(input.props.style.fontSize, 16);
  assert.equal(input.props.value, '2000-02-29');
  assert.equal(input.props.max, '2026-10-21');
  assert.equal(input.props['aria-label'], 'Nacimiento, obligatorio');
  await renderer.act(async () => {
    input.props.onChange({target: {value: '2000-02-29', validity: {valid: true}}});
    input.props.onChange({target: {value: '2027-01-01', validity: {valid: false}}});
    input.props.onChange({target: {value: '', validity: {valid: false}}});
  });
  assert.deepEqual(changes, ['29/02/2000', '']);
  await renderer.act(async () => input.props.onFocus());
  assert.equal(tree.root.findByType('View').props.style[1].borderColor, 'purple');
  await renderer.act(async () => input.props.onBlur());
  assert.equal(tree.root.findByType('View').props.style[1].borderColor, 'gray');
  await renderer.act(async () => tree.unmount());
});

test('empty date has no invented value or maximum', async () => {
  let tree;
  await renderer.act(async () => {tree = renderer.create(React.createElement(Input, {
    value: '', label: 'Fecha', onSelect() {}, maximumDate: new Date('invalid'),
  }));});
  assert.equal(tree.root.findByType('input').props.value, '');
  assert.equal(tree.root.findByType('input').props.max, undefined);
  await renderer.act(async () => tree.unmount());
});

test('disabled: the web calendar does not change the value', async () => {
  let tree;
  const changes = [];
  await renderer.act(async () => {tree = renderer.create(React.createElement(Input, {
    value: '2000-02-29', label: 'Fecha', disabled: true, onSelect: value => changes.push(value),
  }));});
  const input = tree.root.findByType('input');
  assert.equal(input.props.disabled, true);
  await renderer.act(async () => input.props.onChange({target: {value: '2001-01-01', validity: {valid: true}}}));
  assert.deepEqual(changes, []);
  await renderer.act(async () => tree.unmount());
});

// FechaInput (nativo): `disabled` es aditivo; sin él se abre como siempre.
const cargarFecha = (os, abiertos) => {
  const fuente = transformSync(fs.readFileSync('src/components/FechaInput.js', 'utf8'), {
    babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs'],
  }).code;
  const modulo = {exports: {}};
  vm.runInThisContext('(function(require,module,exports){' + fuente + '\n})')(name => {
    if (name === 'react') return React;
    if (name === 'react-native') return {Platform: {OS: os}, Pressable: 'Pressable', StyleSheet: {create: v => v}, Text: 'Text', View: 'View'};
    if (name === '@react-native-community/datetimepicker') return {__esModule: true, default: 'DateTimePicker', DateTimePickerAndroid: {open: o => abiertos.push(o)}};
    if (name === '../context/ThemeContext') return {useTheme: () => ({theme: {colors: {surface: 'white', border: 'gray', text: 'black', textSoft: 'gray'}}, typography: {medium: 'x'}})};
    if (name === '../theme') return {fontSizes: {sm: 14}, radii: {lg: 8}};
    if (name === './WebDateInput') return {__esModule: true, default: 'WebDateInput'};
    throw new Error(name);
  }, modulo, modulo.exports);
  return modulo.exports.default;
};

test('FechaInput: disabled does not open the picker (native) and reaches the web input; default unchanged', async () => {
  const abiertos = [];
  const Fecha = cargarFecha('android', abiertos);
  for (const [disabled, esperados] of [[true, 0], [undefined, 1]]) {
    let tree;
    await renderer.act(async () => {tree = renderer.create(React.createElement(Fecha, {label: 'Fecha', value: '01/02/2000', onSelect() {}, disabled}));});
    const boton = tree.root.findByType('Pressable');
    assert.equal(boton.props.disabled, !!disabled);
    assert.deepEqual(boton.props.accessibilityState, {disabled: !!disabled});
    await renderer.act(async () => boton.props.onPress());
    assert.equal(abiertos.length, esperados);
    abiertos.length = 0;
    await renderer.act(async () => tree.unmount());
  }
  const FechaWeb = cargarFecha('web', abiertos);
  let tree;
  await renderer.act(async () => {tree = renderer.create(React.createElement(FechaWeb, {label: 'Fecha', value: '01/02/2000', onSelect() {}, disabled: true}));});
  assert.equal(tree.root.findByType('WebDateInput').props.disabled, true);
  await renderer.act(async () => tree.unmount());
});
