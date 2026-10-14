const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('@babel/core');
const root = path.join(__dirname, '..');
const code = transformSync(fs.readFileSync(path.join(root, 'src/theme/statusBadges.js'), 'utf8'), {
  babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
}).code;
const exportsObject = {};
vm.runInNewContext(code, { exports: exportsObject });
const { relevamientoBadge, casoBadge } = exportsObject;
for (const [state, label, background] of [
  ['ASIGNADO', 'Asignado', '#E5E7EB'], ['EN_CURSO', 'En curso', '#FFF8F1'],
  ['FINALIZANDO', 'Finalizando', '#FFF8F1'], ['FINALIZADO', 'Finalizado', '#FFEAF6'],
  ['EN_REVISION', 'En revisión', '#F5F3FF'], ['TERMINADO', 'Terminado', '#ECFDF5'],
  ['VENCIDO', 'Vencido', '#FFF8F1'],
]) test(`relevamiento ${state}`, () => {
  assert.equal(relevamientoBadge(state).label, label);
  assert.equal(relevamientoBadge(state).bg, background);
});
for (const [state, background] of [['ENVIADO', '#FFF8F1'], ['APROBADO', '#ECFDF5'], ['RECHAZADO', '#FEF0F2'], ['BAJA', '#E5E7EB']]) {
  test(`caso ${state}`, () => assert.equal(casoBadge(state).bg, background));
}
test('DATAÑACH uses only Chaco symbol assets', () => {
  const app = require('../app.json').expo;
  assert.equal(app.name, 'DATAÑACH');
  assert.equal(app.icon, './assets/brand/app-icon-chaco-symbol.png');
  assert.equal(app.android.adaptiveIcon.foregroundImage, app.icon);
  assert.equal(app.splash.image, './assets/brand/mini-logo-chaco.png');
  assert.ok(fs.existsSync(path.join(root, app.icon)));
});
test('Android plugin writes HTTPS-only configuration and manifest', async () => {
  let manifestMod, resourceMod;
  const source = fs.readFileSync(path.join(root, 'plugins/withAndroidNetworkSecurityConfig.js'), 'utf8');
  const written = new Map();
  const plugins = {
    AndroidConfig: { Manifest: { getMainApplicationOrThrow: result => result } },
    withAndroidManifest: (config, fn) => { manifestMod = fn; return config; },
    withDangerousMod: (config, [, fn]) => { resourceMod = fn; return config; },
    withPlugins: (config, mods) => mods.reduce((value, fn) => fn(value), config),
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: name => name === 'expo/config-plugins' ? plugins : name === 'fs' ? {
    promises: { mkdir: async () => {}, copyFile: async () => {}, writeFile: async (file, content) => written.set(file, content) },
  } : require(name) });
  module.exports({});
  const manifest = manifestMod({ modResults: { $: {} } }).modResults;
  assert.equal(manifest.$['android:usesCleartextTraffic'], 'false');
  await resourceMod({ modRequest: { projectRoot: root, platformProjectRoot: '/android' } });
  const xml = [...written.values()][0];
  assert.match(xml, /datanach\.ecomdev\.ar/);
  assert.match(xml, /datanach\.chaco\.gob\.ar/);
  assert.doesNotMatch(xml, /cleartextTrafficPermitted="true"|10\.5\.6\.209|relevamiento-deshum/);
});
