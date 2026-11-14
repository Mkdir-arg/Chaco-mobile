// utils/jpeg.js: aJpeg siempre devuelve un JPEG real dentro del tope (Emergencia acepta solo
// JPEG). En web con un canvas simulado; en nativo con expo-image-manipulator simulado.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {setup} = require('./helpers/mobile-runtime.cjs');

const MB = 1024 * 1024;
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47];
const bytes = (cabecera, total) => {
  const datos = new Uint8Array(Math.max(total, cabecera.length));
  datos.set(cabecera);
  return datos;
};
const archivo = (cabecera, total, nombre, type) => new File([bytes(cabecera, total)], nombre, {type});
const primeros = async (blob) => [...new Uint8Array(await blob.slice(0, 3).arrayBuffer())];

// Canvas simulado: el JPEG pesa `ancho * alto * calidad * factor` bytes.
function navegador(r, {ancho = 4000, alto = 3000, factor = 1, decodifica = true, toBlobNulo = false} = {}) {
  const registro = {decodificadas: 0, codificadas: [], fondos: 0, cerradas: 0};
  r.setGlobal('createImageBitmap', async () => {
    registro.decodificadas += 1;
    if (!decodifica) throw new DOMException('The source image could not be decoded.');
    return {width: ancho, height: alto, close: () => { registro.cerradas += 1; }};
  });
  r.setGlobal('document', {createElement: (tipo) => {
    assert.equal(tipo, 'canvas');
    const canvas = {width: 0, height: 0};
    canvas.getContext = () => ({fillRect: () => { registro.fondos += 1; }, drawImage() {}});
    canvas.toBlob = (callback, type, calidad) => {
      registro.codificadas.push({ancho: canvas.width, alto: canvas.height, calidad, type});
      callback(toBlobNulo ? null : new Blob([bytes(JPEG, Math.round(canvas.width * canvas.height * calidad * factor))], {type}));
    };
    return canvas;
  }});
  return registro;
}

test('web: un PNG chico pasa a JPEG real, con fondo, nombre .jpg y legible sin fetch', async () => {
  const r = await setup('web');
  const registro = navegador(r, {ancho: 800, alto: 600});
  const {aJpeg} = r.load('../utils/jpeg');
  const png = archivo(PNG, 2000, 'captura.png', 'image/png');
  const asset = await aJpeg({uri: 'blob:https://app.test/png', file: png, fileName: 'captura.png', fileSize: 2000, mimeType: 'image/png'});
  assert.equal(asset.mimeType, 'image/jpeg');
  assert.equal(asset.fileName, 'captura.jpg'); assert.equal(asset.name, 'captura.jpg');
  assert.deepEqual(await primeros(asset.file), JPEG);
  assert.equal(asset.file.type, 'image/jpeg');
  assert.equal(asset.fileSize, asset.file.size); assert.equal(asset.size, asset.file.size);
  assert.equal(asset.width, 800); assert.equal(asset.height, 600);
  assert.ok(asset.uri.startsWith('blob:'));
  assert.equal(registro.fondos, 1);
  assert.equal(registro.cerradas, 1);
  assert.deepEqual(registro.codificadas.map(({type}) => type), ['image/jpeg']);
  const attachments = r.load('./webAttachments');
  assert.equal(await attachments.readWebBlob(asset.uri), asset.file);
});

test('web: una foto grande baja calidad y lado en pasos hasta entrar en el tope', async () => {
  const r = await setup('web');
  const registro = navegador(r, {ancho: 4000, alto: 3000, factor: 3});
  const {aJpeg, CALIDADES} = r.load('../utils/jpeg');
  const grande = archivo(JPEG, 9 * MB, 'IMG_0001.JPG', 'image/jpeg');
  const asset = await aJpeg({uri: 'blob:https://app.test/g', file: grande, fileName: 'IMG_0001.JPG'});
  assert.ok(asset.fileSize <= 3 * MB, `pesa ${asset.fileSize}`);
  assert.equal(asset.fileName, 'IMG_0001.JPG');
  const pasos = registro.codificadas;
  assert.ok(pasos.length > 1);
  assert.ok(pasos.every(({ancho, alto}) => Math.max(ancho, alto) <= 2048));
  // Primero todas las calidades al lado máximo, después un lado menor.
  assert.deepEqual(JSON.parse(JSON.stringify(pasos.slice(0, CALIDADES.length).map(({ancho, calidad}) => [ancho, calidad]))), [...CALIDADES].map((c) => [2048, c]));
  assert.ok(pasos.at(-1).ancho < 2048);
  assert.equal(asset.width, pasos.at(-1).ancho);
});

test('web: el tope y el lado se pueden pasar', async () => {
  const r = await setup('web');
  const registro = navegador(r, {ancho: 3000, alto: 4000});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({file: archivo(PNG, 100, 'a.webp', 'image/webp')}, {maxBytes: MB, maxLado: 1000});
  assert.ok(asset.fileSize <= MB);
  assert.ok(registro.codificadas.every(({ancho, alto}) => Math.max(ancho, alto) <= 1000));
});

test('web: un JPEG real que ya entra se devuelve sin recomprimir', async () => {
  const r = await setup('web');
  const registro = navegador(r);
  const {aJpeg} = r.load('../utils/jpeg');
  const jpg = archivo(JPEG, 500 * 1024, 'casa.jpeg', 'image/jpeg');
  const asset = await aJpeg({uri: 'blob:https://app.test/j', file: jpg, fileName: 'casa.jpeg'});
  assert.equal(asset.file, jpg);
  assert.equal(asset.uri, 'blob:https://app.test/j');
  assert.equal(asset.fileSize, jpg.size);
  assert.equal(registro.decodificadas, 0);
});

test('web: un .jpg que por dentro es PNG se convierte igual', async () => {
  const r = await setup('web');
  const registro = navegador(r, {ancho: 640, alto: 480});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({file: archivo(PNG, 1000, 'trucho.jpg', 'image/jpeg'), fileName: 'trucho.jpg'});
  assert.equal(registro.decodificadas, 1);
  assert.deepEqual(await primeros(asset.file), JPEG);
  assert.equal(asset.fileName, 'trucho.jpg');
});

test('web: si el navegador no la decodifica (HEIC en Chrome), error JPEG_NO_CONVERTIBLE', async () => {
  const r = await setup('web');
  navegador(r, {decodifica: false});
  const {aJpeg, ERROR_NO_CONVERTIBLE} = r.load('../utils/jpeg');
  await assert.rejects(aJpeg({file: archivo([0, 0, 0, 0x18], 1000, 'IMG.HEIC', 'image/heic')}),
    (error) => error.code === ERROR_NO_CONVERTIBLE && /JPEG/.test(error.message));
});

test('web: si no entra ni con el paso más chico, error JPEG_EXCEDE', async () => {
  const r = await setup('web');
  navegador(r, {factor: 1000});
  const {aJpeg, ERROR_EXCEDE} = r.load('../utils/jpeg');
  await assert.rejects(aJpeg({file: archivo(PNG, 100, 'x.png', 'image/png')}), (error) => error.code === ERROR_EXCEDE);
});

test('web: sin poder leer el archivo o sin poder codificarlo, error JPEG_NO_CONVERTIBLE', async () => {
  const r = await setup('web');
  navegador(r, {toBlobNulo: true});
  const {aJpeg, ERROR_NO_CONVERTIBLE} = r.load('../utils/jpeg');
  await assert.rejects(aJpeg({uri: 'blob:https://app.test/perdida'}), (error) => error.code === ERROR_NO_CONVERTIBLE);
  await assert.rejects(aJpeg({file: archivo(PNG, 100, 'x.png', 'image/png')}), (error) => error.code === ERROR_NO_CONVERTIBLE);
});

// Nativo: el manipulador guarda archivos cuyo peso es ancho * alto * calidad * factor.
function nativo({ancho = 4000, alto = 3000, factor = 1, inicio = 'iVBO', tamanoOriginal = 9 * MB, falla = false} = {}) {
  const registro = {manipulados: [], guardados: [], liberados: 0};
  const tamanos = new Map([['file:///original', tamanoOriginal]]);
  const ref = (w, h) => ({
    width: w, height: h,
    saveAsync: async ({compress, format}) => {
      const uri = `file:///cache/${registro.guardados.length}.jpg`;
      registro.guardados.push({ancho: w, alto: h, compress, format});
      tamanos.set(uri, Math.round(w * h * compress * factor));
      return {uri, width: w, height: h};
    },
    release: () => { registro.liberados += 1; },
  });
  const manipulator = {
    SaveFormat: {JPEG: 'jpeg'},
    ImageManipulator: {manipulate: (uri) => {
      registro.manipulados.push(uri);
      let medidas = {w: ancho, h: alto};
      const contexto = {
        resize: ({width, height}) => { medidas = {w: width, h: height}; return contexto; },
        renderAsync: async () => { if (falla) throw new Error('formato no soportado'); return ref(medidas.w, medidas.h); },
      };
      return contexto;
    }},
  };
  const fileSystem = {
    EncodingType: {Base64: 'base64'},
    getInfoAsync: async (uri) => (tamanos.has(uri) ? {exists: true, size: tamanos.get(uri)} : {exists: false}),
    readAsStringAsync: async (uri, opciones) => {
      registro.lectura = opciones;
      return uri === 'file:///original' ? inicio : '';
    },
  };
  return {registro, mocks: {'expo-image-manipulator': manipulator, 'expo-file-system/legacy': fileSystem}};
}

test('nativo: HEIC grande sale JPEG ≤ 3 MB con expo-image-manipulator, en pasos', async () => {
  const {registro, mocks} = nativo({factor: 3});
  const r = await setup('android', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({uri: 'file:///original', fileName: 'IMG_0002.HEIC', width: 4000, height: 3000});
  assert.equal(asset.mimeType, 'image/jpeg');
  assert.equal(asset.fileName, 'IMG_0002.jpg');
  assert.ok(asset.fileSize <= 3 * MB);
  assert.ok(asset.uri.startsWith('file:///cache/'));
  assert.ok(registro.guardados.every(({format, ancho, alto}) => format === 'jpeg' && Math.max(ancho, alto) <= 2048));
  assert.ok(registro.guardados.length > 1);
  assert.equal(asset.width, registro.guardados.at(-1).ancho);
  assert.deepEqual({...registro.lectura}, {encoding: 'base64', position: 0, length: 3});
  assert.ok(registro.liberados >= 1);
});

test('nativo: un JPEG real que ya entra no pasa por el manipulador', async () => {
  const {registro, mocks} = nativo({inicio: '/9j/', tamanoOriginal: MB});
  const r = await setup('ios', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({uri: 'file:///original', fileName: 'foto.jpg'});
  assert.equal(asset.uri, 'file:///original');
  assert.equal(asset.fileSize, MB);
  assert.equal(registro.manipulados.length, 0);
});

test('nativo: un JPEG que pasa el tope se recomprime', async () => {
  const {registro, mocks} = nativo({inicio: '/9j/', tamanoOriginal: 8 * MB, ancho: 1500, alto: 1000});
  const r = await setup('android', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({uri: 'file:///original', fileName: 'foto.jpg'});
  assert.ok(asset.fileSize <= 3 * MB);
  assert.ok(registro.manipulados.length >= 1);
});

test('nativo: si no la puede abrir, JPEG_NO_CONVERTIBLE; si no entra, JPEG_EXCEDE', async () => {
  const falla = nativo({falla: true});
  const r1 = await setup('android', {mocks: falla.mocks});
  const j1 = r1.load('../utils/jpeg');
  await assert.rejects(j1.aJpeg({uri: 'file:///original'}), (error) => error.code === j1.ERROR_NO_CONVERTIBLE);
  const enorme = nativo({factor: 1000});
  const r2 = await setup('android', {mocks: enorme.mocks});
  const j2 = r2.load('../utils/jpeg');
  await assert.rejects(j2.aJpeg({uri: 'file:///original'}), (error) => error.code === j2.ERROR_EXCEDE);
});

test('los pasos de lado no agrandan una foto chica ni se repiten', async () => {
  const r = await setup('web');
  const {pasosDeLado} = r.load('../utils/jpeg');
  assert.deepEqual(JSON.parse(JSON.stringify(pasosDeLado(800, 600))), [{ancho: 800, alto: 600}, {ancho: 717, alto: 538}]);
  assert.deepEqual([...pasosDeLado(4000, 3000).map(({ancho}) => ancho)], [2048, 1536, 1024, 717]);
});
