#!/usr/bin/env node
// Uso: npm run version:subir [patch|minor|major]
const path = require('node:path');
const { subirArchivos } = require('./version-lib');

try {
  const { actual, nueva } = subirArchivos(path.join(__dirname, '..'), process.argv[2] || 'patch');
  console.log(`${actual} → ${nueva}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
