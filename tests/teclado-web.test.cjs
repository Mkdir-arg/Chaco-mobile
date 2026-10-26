const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {transformSync} = require('@babel/core');

function cargarHelper(os) {
  const {code} = transformSync(fs.readFileSync('src/utils/teclado.js', 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
  });
  const module = {exports: {}};
  new Function('require', 'module', 'exports', code)(name => {
    assert.equal(name, 'react-native');
    return {Platform: {OS: os}};
  }, module, module.exports);
  return module.exports.keyboardDismissModeFor;
}

test('en web el ScrollView no cierra el teclado al scrollear', () => {
  const modo = cargarHelper('web');
  assert.equal(modo(), 'none');
  assert.equal(modo('interactive'), 'none');
});

test('en nativo se mantiene el modo pedido', () => {
  for (const os of ['android', 'ios']) {
    const modo = cargarHelper(os);
    assert.equal(modo(), 'on-drag');
    assert.equal(modo('interactive'), 'interactive');
  }
});

test('ninguna pantalla fija keyboardDismissMode en un literal on-drag', () => {
  const dir = 'src/screens';
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /keyboardDismissMode\s*=\s*(["']on-drag["']|\{\s*["']on-drag["']\s*\})/, `${file} fija on-drag`);
    assert.doesNotMatch(source, /keyboardDismissMode\s*=\s*\{(?![^}]*keyboardDismissModeFor)/, `${file} no usa keyboardDismissModeFor`);
  }
});
