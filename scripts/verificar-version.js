#!/usr/bin/env node
// Check de CI «Versión subida». Uso: node scripts/verificar-version.js <sha-base>
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { versionesDe, verificarSubida } = require('./version-lib');

const base = process.argv[2];
if (!base) {
  console.error('Falta el SHA de la rama base.');
  process.exit(2);
}
const versionBase = JSON.parse(execFileSync('git', ['show', `${base}:app.json`], { encoding: 'utf8' })).expo.version;
const versiones = versionesDe(path.join(__dirname, '..'));
const problemas = verificarSubida(versiones, versionBase);
if (problemas.length) {
  problemas.forEach((p) => console.error(`::error::${p}`));
  console.error('Subí la versión con `npm run version:subir`');
  process.exit(1);
}
console.log(`Versión ${versiones['app.json']} > ${versionBase} (base). OK`);
