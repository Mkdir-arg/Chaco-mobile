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

function archivosFuente(dir) {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return archivosFuente(full);
    return /\.(js|jsx|ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test('todo keyboardDismissMode en src/ pasa por keyboardDismissModeFor', () => {
  const helper = path.normalize(path.join('src', 'utils', 'teclado.js'));
  let encontrados = 0;
  for (const file of archivosFuente('src')) {
    if (path.normalize(file) === helper) continue;
    fs.readFileSync(file, 'utf8').split('\n').forEach((linea, index) => {
      if (!/keyboardDismissMode\s*[:=]/.test(linea)) return;
      encontrados += 1;
      assert.match(linea, /keyboardDismissModeFor/, file + ':' + (index + 1) + ' no usa keyboardDismissModeFor');
    });
  }
  assert.ok(encontrados >= 3);
  for (const pantalla of ['LoginScreen', 'NewRelevamientoScreen', 'RelevamientoDetailScreen']) {
    const source = fs.readFileSync(path.join('src', 'screens', pantalla + '.js'), 'utf8');
    assert.match(source, /keyboardDismissMode\s*=\s*\{[^}]*keyboardDismissModeFor/, pantalla + ' no usa el helper');
  }
});
