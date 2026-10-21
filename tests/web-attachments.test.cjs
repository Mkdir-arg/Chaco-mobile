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

// Bajo la CSP de ECOM (`connect-src` sin blob: ni data:) el navegador rechaza fetch a
// las dos. El harness reproduce ese rechazo en web, asi que estos tests fallan si
// algun camino vuelve a leer un adjunto con fetch.
test('web: un archivo elegido (blob:) se guarda como data: con sus bytes, sin fetch', async () => {
  const r=await setup('web');
  const file=new Blob([new Uint8Array([0xff,0xd8,0xff,0x00,0x10])],{type:'image/jpeg'});
  r.attachments.rememberWebFile({uri:'blob:https://app.test/elegido',file});
  const saved=await r.attachments.persistWebAttachment({uri:'blob:https://app.test/elegido',mimeType:'image/jpeg'});
  assert.equal(saved.uri,'data:image/jpeg;base64,/9j/ABA=');
  assert.equal(saved.size,5);
});

test('web: la subida decodifica el data: en el lugar, con los bytes y el tipo originales', async () => {
  const r=await setup('web');let request;
  r.setFetch(async(url,options)=>{request=options;return response(201,{id:1});});
  await r.api.becasUploadFile('/upload/',{fileUri:'data:image/png;base64,iVBORw==',fileName:'f.png'});
  const blob=request.body.fields.find(field=>field[0]==='archivo')[1];
  assert.equal(blob.type,'image/png');
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())],[0x89,0x50,0x4e,0x47]);
});

test('web: una blob: URL sin archivo registrado pide volver a elegirlo, no muestra el error de CSP', async () => {
  const r=await setup('web');
  await assert.rejects(r.attachments.persistWebAttachment({uri:'blob:https://app.test/perdido'}),
    /Volvé a seleccionarlo/);
});
