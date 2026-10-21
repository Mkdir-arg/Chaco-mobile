const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./helpers/mobile-runtime.cjs');

// expo-location web pide con maximumAge: Infinity: sin pisarlo, el navegador puede
// devolver la posicion de la casa anterior.
test('la ubicacion pide una posicion reciente y con tiempo limite', async () => {
  const r=await setup('web');let opciones;
  r.setLocation(async(options)=>{opciones=options;return {coords:{latitude:1,longitude:2}};});
  const posicion=await r.location.posicionActual(4);
  assert.equal(posicion.coords.latitude,1);
  assert.ok(opciones.maximumAge>0 && opciones.maximumAge<=30000, 'maximumAge='+opciones.maximumAge);
  assert.ok(opciones.timeout>0 && opciones.timeout<=20000, 'timeout='+opciones.timeout);
  assert.equal(opciones.accuracy,4);
});

test('una foto grande se reduce a 2048 px del lado mayor y conserva la proporcion', async () => {
  const {images}=await setup('web');
  assert.deepEqual({...images.medidasReducidas(4000,3000)},{ancho:2048,alto:1536});
  assert.deepEqual({...images.medidasReducidas(3000,4000)},{ancho:1536,alto:2048});
  assert.deepEqual({...images.medidasReducidas(1200,900)},{ancho:1200,alto:900});
});

test('la foto achicada pasa a .jpg para que la validacion de extension la acepte', async () => {
  const {images}=await setup('web');
  assert.equal(images.nombreJpg('IMG_0001.PNG'),'IMG_0001.jpg');
  assert.equal(images.nombreJpg('foto.de.casa.webp'),'foto.de.casa.jpg');
  assert.equal(images.nombreJpg(''),'foto.jpg');
  assert.equal(images.nombreJpg('camara'),'camara.jpg');
});

test('en nativo (sin File) el asset pasa intacto', async () => {
  const {images}=await setup('android');
  const asset={uri:'file:///foto.jpg',fileSize:9000000};
  assert.equal(await images.achicarAsset(asset),asset);
});
