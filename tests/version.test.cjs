const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {comparar, subirArchivos, verificarSubida, versionesDe} = require('../scripts/version-lib');

function proyecto(version = '1.1.3') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-'));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({expo: {name: 'x', version}}, null, 2));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: 'mobile', version}, null, 2));
  const lock = {name: 'mobile', version, lockfileVersion: 3, packages: {'': {name: 'mobile', version},
    'node_modules/dep': {version}}};
  fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));
  return dir;
}

test('comparar: numérica por parte, no por texto', () => {
  assert.equal(comparar('1.1.4', '1.1.3'), 1);
  assert.equal(comparar('1.1.3', '1.1.3'), 0);
  assert.equal(comparar('1.2.0', '1.1.9'), 1);
  assert.equal(comparar('1.10.0', '1.9.0'), 1);
  assert.equal(comparar('1.1.3', '1.1.4'), -1);
});

test('verificarSubida: mayor pasa; igual o menor falla; desalineadas fallan', () => {
  const v = (x) => ({'app.json': x, 'package.json': x, 'package-lock.json': x, 'package-lock.json (packages[""])': x});
  assert.deepEqual(verificarSubida(v('1.1.4'), '1.1.3'), []);
  assert.equal(verificarSubida(v('1.1.3'), '1.1.3').length, 1);
  assert.equal(verificarSubida(v('1.1.2'), '1.1.3').length, 1);
  assert.deepEqual(verificarSubida(v('1.10.0'), '1.9.0'), []);
  assert.equal(verificarSubida({...v('1.1.4'), 'package.json': '1.1.3'}, '1.1.3').length, 1);
});

test('subirArchivos: patch, minor, major; solo toca la raíz del lock', () => {
  for (const [nivel, esperada] of [['patch', '1.1.4'], ['minor', '1.2.0'], ['major', '2.0.0']]) {
    const dir = proyecto();
    assert.deepEqual(subirArchivos(dir, nivel), {actual: '1.1.3', nueva: esperada});
    assert.deepEqual(new Set(Object.values(versionesDe(dir))), new Set([esperada]));
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    assert.equal(lock.packages['node_modules/dep'].version, '1.1.3');
  }
});
