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

// openSqliteSerialized guarda estado del módulo: cada test arranca con uno recién cargado.
const fresco = () => {
  const exportsFresco = {};
  vm.runInNewContext(code, {exports: exportsFresco});
  return exportsFresco;
};

const errorOcupada = () => Object.assign(new Error("Failed to execute 'createSyncAccessHandle' on 'FileSystemFileHandle': Access Handles cannot be created if there is another open Access Handle or Writable stream associated with the same file."), {name: 'NoModificationAllowedError'});

test('las bases se abren de a una: la segunda espera a que termine la primera', async () => {
  const {openSqliteSerialized} = fresco();
  const events = [];
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const open = async name => {
    events.push(`abre ${name}`);
    if (name === 'relevamientos') await gate;
    events.push(`lista ${name}`);
    return {name};
  };
  const first = openSqliteSerialized(open, 'relevamientos');
  const second = openSqliteSerialized(open, 'dispositivos');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(events, ['abre relevamientos']);
  release();
  assert.equal((await first).name, 'relevamientos');
  assert.equal((await second).name, 'dispositivos');
  assert.equal(events.join(','), 'abre relevamientos,lista relevamientos,abre dispositivos,lista dispositivos');
});

test('base tomada por otra pestaña: las dos aperturas dan el mismo aviso y el worker roto no se vuelve a llamar', async () => {
  const {openSqliteSerialized, BASE_OCUPADA, MENSAJE_BASE_OCUPADA} = fresco();
  const ocupada = errorOcupada();
  const llamadas = [];
  const open = async name => {
    llamadas.push(name);
    if (name === 'relevamientos') throw ocupada;
    throw new Error('Invalid VFS state');
  };
  const first = openSqliteSerialized(open, 'relevamientos');
  const second = openSqliteSerialized(open, 'dispositivos');
  for (const apertura of [first, second]) {
    await assert.rejects(apertura, error => {
      assert.equal(error.code, BASE_OCUPADA);
      assert.equal(error.message, MENSAJE_BASE_OCUPADA);
      assert.equal(error.cause, ocupada);
      return true;
    });
  }
  assert.deepEqual(llamadas, ['relevamientos']);
});

test('«Invalid VFS state» solo (worker roto de antes) también es base ocupada', async () => {
  const {openSqliteSerialized, BASE_OCUPADA} = fresco();
  await assert.rejects(openSqliteSerialized(async () => { throw new Error('Invalid VFS state'); }, 'x'), error => error.code === BASE_OCUPADA);
});

test('otros errores de apertura pasan sin tocar y no bloquean las siguientes', async () => {
  const {openSqliteSerialized, esBaseOcupada} = fresco();
  const otro = new Error('disk full');
  await assert.rejects(openSqliteSerialized(async () => { throw otro; }, 'x'), error => error === otro);
  assert.equal((await openSqliteSerialized(async name => ({name}), 'dispositivos')).name, 'dispositivos');
  assert.equal(esBaseOcupada(otro), false);
  assert.equal(esBaseOcupada({name: 'NoModificationAllowedError', message: ''}), true);
});
