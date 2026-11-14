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
  const registro = {decodificadas: 0, codificadas: [], fondos: 0, cerradas: 0, canvases: []};
  r.setGlobal('createImageBitmap', async () => {
    registro.decodificadas += 1;
    if (!decodifica) throw new DOMException('The source image could not be decoded.');
    return {width: ancho, height: alto, close: () => { registro.cerradas += 1; }};
  });
  r.setGlobal('document', {createElement: (tipo) => {
    assert.equal(tipo, 'canvas');
    const canvas = {width: 0, height: 0};
    registro.canvases.push(canvas);
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
  const {aJpeg} = r.load('../utils/jpeg');
  const grande = archivo(JPEG, 9 * MB, 'IMG_0001.JPG', 'image/jpeg');
  const asset = await aJpeg({uri: 'blob:https://app.test/g', file: grande, fileName: 'IMG_0001.JPG'});
  assert.ok(asset.fileSize <= 3 * MB, `pesa ${asset.fileSize}`);
  assert.equal(asset.fileName, 'IMG_0001.JPG');
  const pasos = registro.codificadas;
  assert.ok(pasos.length > 1);
  assert.ok(pasos.every(({ancho, alto}) => Math.max(ancho, alto) <= 2048));
  // Primero todas las calidades al lado máximo, después un lado menor.
  assert.deepEqual(JSON.parse(JSON.stringify(pasos.slice(0, 4).map(({ancho, calidad}) => [ancho, calidad]))), [[2048, 0.85], [2048, 0.7], [2048, 0.55], [2048, 0.4]]);
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

// Nativo: el manipulador guarda archivos cuyo peso es ancho * alto * calidad * factor. Registra
// cada contexto y cada ImageRef para comprobar que se liberan, y de dónde se decodificó cada uno.
function nativo({ancho = 4000, alto = 3000, factor = 1, inicio = 'iVBO', tamanoOriginal = 9 * MB, falla = false, fallaGuardar = false} = {}) {
  const registro = {manipulados: [], guardados: [], contextos: [], refs: [], liberados: 0};
  const tamanos = new Map([['file:///original', tamanoOriginal]]);
  const ref = (w, h) => {
    const imagen = {
      width: w, height: h, liberada: false,
      saveAsync: async ({compress, format}) => {
        if (imagen.liberada) throw new Error('ImageRef ya liberada');
        if (fallaGuardar) throw new Error('disco lleno');
        const uri = `file:///cache/${registro.guardados.length}.jpg`;
        registro.guardados.push({ancho: w, alto: h, compress, format});
        tamanos.set(uri, Math.round(w * h * compress * factor));
        return {uri, width: w, height: h};
      },
      release: () => { imagen.liberada = true; registro.liberados += 1; },
    };
    registro.refs.push(imagen);
    return imagen;
  };
  const manipulator = {
    SaveFormat: {JPEG: 'jpeg'},
    ImageManipulator: {manipulate: (fuente) => {
      registro.manipulados.push(typeof fuente === 'string' ? fuente : 'ref');
      if (typeof fuente !== 'string' && fuente.liberada) throw new Error('fuente ya liberada');
      let medidas = typeof fuente === 'string' ? {w: ancho, h: alto} : {w: fuente.width, h: fuente.height};
      const contexto = {
        liberado: false,
        resize: ({width, height}) => {
          const {w, h} = medidas;
          medidas = {w: width ?? Math.round(w * height / h), h: height ?? Math.round(h * width / w)};
          return contexto;
        },
        renderAsync: async () => { if (falla) throw new Error('formato no soportado'); return ref(medidas.w, medidas.h); },
        release: () => { contexto.liberado = true; },
      };
      registro.contextos.push(contexto);
      return contexto;
    }},
  };
  const fileSystem = {
    EncodingType: {Base64: 'base64'},
    getInfoAsync: async (uri) => (tamanos.has(uri) ? {exists: true, size: tamanos.get(uri)} : {exists: false}),
    deleteAsync: async (uri) => { (registro.borrados ||= []).push(uri); },
    readAsStringAsync: async (uri, opciones) => {
      registro.lectura = opciones;
      return uri === 'file:///original' ? inicio : '';
    },
  };
  return {registro, mocks: {'expo-image-manipulator': manipulator, 'expo-file-system/legacy': fileSystem}};
}

const desdeUri = (registro) => registro.manipulados.filter((fuente) => fuente !== 'ref').length;
const todoLiberado = (registro) => {
  assert.ok(registro.contextos.length > 0);
  assert.ok(registro.contextos.every(({liberado}) => liberado), 'quedó un contexto sin liberar');
  assert.ok(registro.refs.every(({liberada}) => liberada), 'quedó un ImageRef sin liberar');
};

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
  // Los intentos que no entraron se borran de la caché; el devuelto, no.
  assert.equal((registro.borrados || []).length, registro.guardados.length - 1);
  assert.ok(!registro.borrados.includes(asset.uri));
});

test('nativo: con las medidas del selector decodifica la uri una vez, ya achicada, y libera todo', async () => {
  const {registro, mocks} = nativo({factor: 3});
  const r = await setup('android', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  await aJpeg({uri: 'file:///original', fileName: 'IMG.HEIC', width: 4000, height: 3000});
  assert.equal(desdeUri(registro), 1);
  // La uri se abre una sola vez y la primera imagen ya sale con el lado máximo (el original no queda retenido).
  assert.equal(registro.refs[0].width, 2048);
  assert.ok(registro.refs.every(({width, height}) => Math.max(width, height) <= 2048));
  assert.ok(registro.manipulados.length > 1, 'los pasos siguientes salen de la imagen cargada');
  todoLiberado(registro);
});

test('nativo: medidas del selector giradas no deforman la foto', async () => {
  const {registro, mocks} = nativo({ancho: 3000, alto: 4000, factor: 3});
  const r = await setup('android', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({uri: 'file:///original', width: 4000, height: 3000});
  assert.equal(desdeUri(registro), 1);
  assert.ok(Math.max(asset.width, asset.height) <= 2048);
  assert.ok(Math.abs(asset.width / asset.height - 3 / 4) < 0.01, `${asset.width}x${asset.height}`);
  todoLiberado(registro);
});

test('nativo: sin medidas del selector, una sola decodificación de la uri y todo liberado', async () => {
  const {registro, mocks} = nativo({factor: 3});
  const r = await setup('ios', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({uri: 'file:///original', fileName: 'IMG.HEIC'});
  assert.ok(asset.fileSize <= 3 * MB);
  assert.equal(desdeUri(registro), 1);
  assert.ok(registro.manipulados.length > 1);
  todoLiberado(registro);
});

test('nativo: en error (no entra, no guarda) también se libera todo', async () => {
  for (const [opciones, code] of [[{factor: 1000}, 'JPEG_EXCEDE'], [{fallaGuardar: true}, 'JPEG_NO_CONVERTIBLE']]) {
    const {registro, mocks} = nativo(opciones);
    const r = await setup('android', {mocks});
    const {aJpeg} = r.load('../utils/jpeg');
    await assert.rejects(aJpeg({uri: 'file:///original', width: 4000, height: 3000}), (error) => error.code === code);
    assert.equal(desdeUri(registro), 1);
    todoLiberado(registro);
  }
  const {registro, mocks} = nativo({falla: true});
  const r = await setup('android', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  await assert.rejects(aJpeg({uri: 'file:///original'}), (error) => error.code === 'JPEG_NO_CONVERTIBLE');
  todoLiberado(registro);
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

test('nativo: un PNG chico (aunque se llame .jpg) pasa igual por el manipulador', async () => {
  const {registro, mocks} = nativo({inicio: 'iVBO', tamanoOriginal: 100 * 1024, ancho: 800, alto: 600});
  const r = await setup('android', {mocks});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({uri: 'file:///original', fileName: 'captura.jpg'});
  assert.equal(registro.manipulados.length, 1);
  assert.equal(registro.guardados[0].format, 'jpeg');
  assert.ok(asset.uri.startsWith('file:///cache/'));
  assert.equal(asset.fileName, 'captura.jpg');
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

test('web: liberarJpeg revoca la blob: URL que creó aJpeg y la olvida; la del selector no la toca', async () => {
  const r = await setup('web');
  navegador(r, {ancho: 800, alto: 600});
  const revocadas = [];
  const URLReal = URL;
  r.setGlobal('URL', Object.assign(function () {}, {
    createObjectURL: (blob) => URLReal.createObjectURL(blob),
    revokeObjectURL: (uri) => { revocadas.push(uri); URLReal.revokeObjectURL(uri); },
  }));
  const {aJpeg, liberarJpeg} = r.load('../utils/jpeg');
  const attachments = r.load('./webAttachments');
  const original = {uri: 'blob:https://app.test/png', file: archivo(PNG, 2000, 'c.png', 'image/png')};
  const asset = await aJpeg(original);
  assert.equal(await attachments.readWebBlob(asset.uri), asset.file);
  assert.equal(liberarJpeg(asset), true);
  assert.deepEqual(revocadas, [asset.uri]);
  await assert.rejects(attachments.readWebBlob(asset.uri));
  assert.equal(liberarJpeg(asset), false);
  assert.equal(liberarJpeg(original), false);
  assert.equal(liberarJpeg(null), false);
  assert.deepEqual(revocadas, [asset.uri]);
  // Un JPEG que ya entraba vuelve con la uri del selector: no es de aJpeg, no se revoca.
  const jpg = await aJpeg({uri: 'blob:https://app.test/j', file: archivo(JPEG, 1000, 'a.jpg', 'image/jpeg')});
  assert.equal(liberarJpeg(jpg), false);
});

test('web: cada canvas se suelta (0x0) después de codificar', async () => {
  const r = await setup('web');
  const registro = navegador(r, {ancho: 4000, alto: 3000, factor: 3});
  const {aJpeg} = r.load('../utils/jpeg');
  const asset = await aJpeg({file: archivo(PNG, 100, 'x.png', 'image/png')});
  assert.ok(asset.fileSize <= 3 * MB);
  assert.ok(registro.canvases.length > 1);
  assert.equal(registro.canvases.length, registro.codificadas.length);
  assert.ok(registro.canvases.every(({width, height}) => width === 0 && height === 0));
});
