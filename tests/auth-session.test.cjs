const { test } = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

for (const platform of ['web', 'android']) {
for (const method of ['becasRequest', 'becasUploadFile']) {
  test(`${platform} ${method}: 401 invalida sesión y avisa al proveedor`, async () => {
    const {api, values} = await setup(platform);
    let expired = 0;
    const unsubscribe = api.subscribeBecasSessionExpired(() => expired++);
    await assert.rejects(api[method]('/endpoint/', {fileUri: 'file:///photo.jpg'}), e => e.status === 401);
    assert.equal(values.has('becas_auth_token'), false);
    assert.equal(values.has('user_data'), false);
    assert.equal(expired, 1);
    unsubscribe();
  });
}

}

test('401 concurrentes invalidan una sola vez; un 401 viejo conserva una sesión nueva', async () => {
  const {api, values, setFetch} = await setup();
  let expired = 0;
  api.subscribeBecasSessionExpired(() => expired++);
  await Promise.allSettled([api.becasRequest('/a'), api.becasRequest('/b')]);
  assert.equal(expired, 1);
  values.set('becas_auth_token', 'old-token');
  setFetch(async () => {values.set('becas_auth_token', 'new-token'); return response(401, {});});
  await assert.rejects(api.becasRequest('/a'));
  assert.equal(values.get('becas_auth_token'), 'new-token');
  assert.equal(expired, 1);
});

test('429 de login conserva el detail del servidor', async () => {
  const {api, setFetch} = await setup();
  setFetch(async () => response(429, {detail: 'Esperá antes de volver a intentar.'}));
  await assert.rejects(api.loginBecas({username: 'test', password: 'test'}), /Esperá antes de volver a intentar/);
});

for (const attachments of [false, true]) {
  test(`cola: 401 ${attachments ? 'en adjunto' : 'en alta'} conserva operaciones y reanuda tras login`, async () => {
    const {api, service, sql, setFetch} = await setup();
    await service.getPendingCount();
    for (let i = 1; i <= 2; i++) {
      const payload = {_owner_user_id: '7', backend: 'django_becas', relevamiento_id: 1,
        ...(attachments ? {remote_formulario_id: i, adjuntos_formulario: [{key: 'photo', uri: 'file:///photo.jpg', field_id: 1}]} : {})};
      sql.prepare(`INSERT INTO outbox_relevamientos (local_id,op_id,type,payload_json,created_at,status,retry_count,updated_at) VALUES (?,?, 'insert_relevamiento',?,?,'PENDING',8,?)`).run(`local${i}`, `op${i}`, JSON.stringify(payload), `2026-10-10T00:00:0${i}Z`, 'now');
    }
    let calls = 0;
    setFetch(async () => {calls++; return response(401, {detail: 'Invalid token.'});});
    await service.syncPendingOperations();
    assert.equal(calls, 1, 'no sigue enviando la cola sin sesión');
    const rows = sql.prepare('SELECT * FROM outbox_relevamientos ORDER BY local_id').all();
    assert.deepEqual(rows.map(r => r.status), ['PENDING', 'PENDING']);
    assert.equal(rows[0].retry_count, 8, '401 no consume reintentos');
    assert.equal(rows[0].next_retry_at, null);
    assert.equal(rows[0].last_error_code, 'AUTH_REQUIRED');
    setFetch(async url => url.endsWith('/api/becas/auth/token/')
      ? response(200, {token: 'new-token', user_id: 7, username: 'test'})
      : response(200, {id: 123}));
    await api.loginBecas({username: 'test', password: 'test'});
    const result = await service.syncPendingOperations();
    assert.equal(result.synced, 2);
    assert.equal(sql.prepare("SELECT count(*) AS n FROM outbox_relevamientos WHERE status='PENDING'").get().n, 0);
  });
}


test('errores del servidor no borran la sesión', async () => {
  const {api, values, setFetch} = await setup();
  setFetch(async () => response(500, {detail: 'Error temporal'}));
  await assert.rejects(api.becasRequest('/endpoint/'), e => e.status === 500);
  assert.equal(values.get('becas_auth_token'), 'old-token');
});

test('cola sin token no envía solicitudes; los pendientes de otro usuario no se envían', async () => {
  const {service, sql, values, setFetch} = await setup();
  await service.getPendingCount();
  sql.prepare(`INSERT INTO outbox_relevamientos (local_id,op_id,type,payload_json,created_at,status,updated_at)
    VALUES ('other','op','insert_relevamiento',?,'now','PENDING','now')`).run(JSON.stringify({_owner_user_id: '8', backend: 'django_becas', relevamiento_id: 1}));
  let calls = 0;
  setFetch(async () => {calls++; return response(200, {id: 1});});
  await service.syncPendingOperations();
  assert.equal(calls, 0);
  values.delete('becas_auth_token');
  values.set('user_data', JSON.stringify({id: 8}));
  await service.syncPendingOperations();
  assert.equal(calls, 0);
  assert.equal(sql.prepare('SELECT status FROM outbox_relevamientos').get().status, 'PENDING');
});
