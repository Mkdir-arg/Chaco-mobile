const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./helpers/mobile-runtime.cjs');
const vectores = require('./fixtures/condiciones_vectores.json');

// Los vectores son los del back (programas/tests/fixtures/condiciones_vectores.json):
// el motor del back es la verdad y la app debe decidir lo mismo.
// `visibles` incluye grupos, campos y textos. Los items pasan por evaluarDiseno,
// el mismo camino que usa la app (aplana el arbol y llama a aplicar).

vectores.forEach(vector => {
  test(vector.nombre, async () => {
    const {definition: api} = await setup();
    const [y, m, d] = vector.fecha_referencia.split('-').map(Number);
    const items = JSON.parse(JSON.stringify(vector.items));
    const result = api.evaluarDiseno({version: 3, items}, {valores: vector.respuestas, identidad: {}, contacto: {}, apoderado: {}},
      new Date(y, m - 1, d, 12).toISOString());
    assert.deepEqual([...result.visibles].sort(), [...vector.visibles].sort());
  });
});
