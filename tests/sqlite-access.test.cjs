const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {transformSync} = require('@babel/core');
const {setup, response} = require('./helpers/mobile-runtime.cjs');
const {code} = transformSync(fs.readFileSync(path.join(__dirname, '../src/services/sqliteAccess.js'), 'utf8'), {
  babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
});
const exportsObject = {};
vm.runInNewContext(code, {exports: exportsObject});
const {serializeSqliteAccess} = exportsObject;

for (const exclusive of [true, false]) {
  test(`cache waits until ${exclusive ? 'native exclusive' : 'web'} transaction commits`, async () => {
    let locked = false;
    let enter, release;
    const entered = new Promise(resolve => {enter = resolve;});
    const gate = new Promise(resolve => {release = resolve;});
    const events = [];
    const raw = {
      runAsync: async () => {
        if (locked) throw new Error('database is locked');
        events.push('cache');
      },
      withTransactionAsync: async task => {
        locked = true;
        try {await task(); events.push('commit');} finally {locked = false;}
      },
    };
    const tx = {runAsync: async () => {events.push('outbox');}};
    if (exclusive) raw.withExclusiveTransactionAsync = async task => {
      locked = true;
      try {await task(tx); events.push('commit');} finally {locked = false;}
    };
    const db = serializeSqliteAccess(raw);
    const method = exclusive ? 'withExclusiveTransactionAsync' : 'withTransactionAsync';
    const transaction = db[method](async connection => {
      if (exclusive) await connection.runAsync('UPDATE outbox');
      else assert.equal(connection, raw);
      enter();
      await gate;
    });
    await entered;
    const cache = db.runAsync('UPDATE cache');
    await Promise.resolve();
    assert.equal(events.includes('cache'), false);
    release();
    await Promise.all([transaction, cache]);
    assert.equal(events.at(-2), 'commit');
    assert.equal(events.at(-1), 'cache');
  });
}

test('rollback does not prevent the next queued write', async () => {
  let writes = 0;
  const db = serializeSqliteAccess({
    withTransactionAsync: async task => task(),
    runAsync: async () => {writes++;},
  });
  const failed = db.withTransactionAsync(async () => {throw new Error('rollback');});
  const next = db.runAsync('UPDATE cache');
  await assert.rejects(failed, /rollback/);
  await next;
  assert.equal(writes, 1);
});

test('SQLite lock after server accepted case retries idempotently and sends attachments', async () => {
  const {service, sql, setFetch} = await setup('android');
  const payload = {_owner_user_id: '7', backend: 'django_becas', relevamiento_id: 1,
    client_uuid: 'stable-uuid', capturado_en: '2026-10-10T12:00:00-03:00', version_capturada: 3,
    adjuntos_formulario: [{key: 'photo', uri: 'file:///photo.jpg', field_id: 1, scope: 'globales', fileName: 'photo.jpg', mimeType: 'image/jpeg'}]};
  sql.prepare(`INSERT INTO outbox_relevamientos (local_id,op_id,type,payload_json,created_at,status,last_error,updated_at)
    VALUES ('locked-case','op','insert_relevamiento',?,'now','FAILED_PERMANENT','NativeStatement.finalizeAsync: database is locked','now')`).run(JSON.stringify(payload));
  const requests = [];
  setFetch(async (url, options) => {
    requests.push({url, options});
    // Server returns the case previously accepted with this same UUID.
    return response(url.includes('/adjuntos/') ? 201 : 200, {id: 3});
  });
  const result = await service.syncPendingOperations();
  assert.equal(result.synced, 1);
  const create = requests.find(r => r.url.endsWith('/formularios/'));
  assert.equal(JSON.parse(create.options.body).client_uuid, 'stable-uuid');
  assert.equal(requests.filter(r => r.url.endsWith('/3/adjuntos/')).length, 1);
  const row = sql.prepare("SELECT * FROM outbox_relevamientos WHERE local_id='locked-case'").get();
  assert.equal(row.status, 'SYNCED');
  assert.equal(JSON.parse(row.payload_json).remote_formulario_id, 3);
});
