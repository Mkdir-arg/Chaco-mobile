const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup, response} = require('./helpers/mobile-runtime.cjs');

test('web offline capture persists attachment bytes in SQLite, not an object URL', async () => {
  const r=await setup('web');r.setOnline(false);
  const uri='data:image/jpeg;base64,b2ZmbGluZS1ieXRlcw==';
  const saved=await r.service.saveBecasFormulario({relevamiento_id:1,version_capturada:3,
    data:{globales:{1:{uri,fileName:'dni.jpg',size:13}},requisitos:{}},
    campos_definicion:[{id:1,scope:'globales',tipo:'ARCHIVO'}]});
  const local=r.sql.prepare('SELECT payload_json FROM local_relevamientos WHERE local_id=?').get(saved.record.local_id);
  const outbox=r.sql.prepare('SELECT payload_json FROM outbox_relevamientos WHERE local_id=?').get(saved.record.local_id);
  assert.equal(JSON.parse(local.payload_json).adjuntos_formulario[0].uri,uri);
  assert.equal(JSON.parse(outbox.payload_json).adjuntos_formulario[0].uri,uri);
  assert.equal(await r.service.getPendingCount(),1);
});

test('web upload appends a Blob and filename without forcing the multipart boundary',async()=>{
  const r=await setup('web');let request;
  r.setFetch(async(url,options)=>{request=options;return response(201,{id:1});});
  await r.api.becasUploadFile('/upload/',{fileUri:'data:image/jpeg;base64,aW1hZ2U=',fileName:'dni.jpg'});
  const entry=request.body.fields.find(field=>field[0]==='archivo');
  assert.ok(entry[1] instanceof Blob); assert.equal(entry[2],'dni.jpg');
  assert.equal(request.headers['Content-Type'],undefined);
});
