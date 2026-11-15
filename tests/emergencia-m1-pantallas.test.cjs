// Pantallas de M1 · Ingreso de familias (Formulario 1, «Mis envíos») y la navegación de
// EmergenciaApp, con la cola mockeada. Las reglas (utils/emergencia) y la lectura del DNI
// (utils/dni) son las reales.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const renderer = require('react-test-renderer');
const {transformSync} = require('@babel/core');
const {setup} = require('./helpers/mobile-runtime.cjs');
global.IS_REACT_ACT_ENVIRONMENT = true;

const root = path.join(__dirname, '..');
const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'Pressable', 'ActivityIndicator', 'Image', 'TextInput',
  'RefreshControl'].map(name => [name, name]));
const plataforma = {OS: 'android'};
Object.assign(native, {Platform: plataforma, StyleSheet: {create: value => value}});
const theme = {colors: new Proxy({}, {get: (_, k) => (k === 'danger' ? '#D00000' : '#5059BC')})};
const typography = {bold: 'Manrope', medium: 'Manrope', semibold: 'Manrope', regular: 'Manrope'};
const text = node => node.children.map(value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(value)).join('');
const esperar = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));

function loadPure(relative) {
  const {code} = transformSync(fs.readFileSync(path.join(root, relative), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInNewContext('(function(module,exports){' + code + '\n})', {})(module, module.exports);
  return module.exports;
}

function loadScreen(relative, mocks, timers = {}) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, Date,
    setInterval: timers.setInterval || (() => 0), clearInterval: timers.clearInterval || (() => {}), ...(timers.globals || {})});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(
    name => { assert.ok(mocks[name], 'Missing screen mock: ' + name); return mocks[name]; }, module, module.exports);
  return module.exports.default;
}

async function render(Screen, props) {
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Screen, props)); });
  await renderer.act(async () => { await esperar(); });
  const labels = () => tree.root.findAllByType('Text').map(text);
  const porLabel = (label) => tree.root.findAll(node => node.props && node.props.accessibilityLabel === label && typeof node.type === 'string');
  const press = async (label) => {
    const [nodo] = porLabel(label).filter(n => n.type === 'Pressable');
    assert.ok(nodo, 'Missing pressable ' + label);
    await renderer.act(async () => { await nodo.props.onPress(); });
  };
  const button = title => tree.root.findAllByType('CustomButton').find(node => node.props.title === title);
  const pressButton = async (title) => {
    const found = button(title);
    assert.ok(found, 'Missing CustomButton ' + title);
    await renderer.act(async () => { await found.props.onPress(); });
  };
  const input = label => tree.root.findAllByType('TextInput').find(node => node.props.accessibilityLabel === label);
  const escribir = async (label, valor) => {
    const found = input(label);
    assert.ok(found, 'Missing input ' + label);
    await renderer.act(async () => { found.props.onChangeText(valor); });
  };
  return {tree, labels, press, button, pressButton, input, escribir, porLabel,
    close: async () => renderer.act(async () => tree.unmount())};
}

async function baseMocks() {
  const runtime = await setup();
  const toasts = [];
  const alerts = [];
  return {runtime, toasts, alerts, mocks: {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showToast: value => toasts.push(value), showAlert: (...args) => alerts.push(args)})},
    '../theme/statusBadges': loadPure('src/theme/statusBadges.js'),
    '../theme': loadPure('src/theme/tokens.js'),
    '../components/CustomButton': {__esModule: true, default: 'CustomButton'},
    '../components/FormInput': {__esModule: true, default: native.TextInput},
    '../components/FechaInput': {__esModule: true, default: 'FechaInput'},
    '../components/CameraModal': {__esModule: true, default: 'CameraModal'},
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '../utils/emergencia': runtime.load('../utils/emergencia'),
    '../utils/dni': runtime.load('../utils/dni'),
    '../utils/dates': runtime.dates,
    '../services/identityLookup': runtime.identity,
  }};
}

// Cola falsa: guarda lo que se le pide y contesta lo configurado.
function colaFalsa({borrador = null, encolar = null, locales = [], misEnvios = {casos: []}} = {}) {
  const calls = {guardados: [], fotos: [], quitadas: [], encolados: [], descartados: [], reintentos: []};
  const base = {uuid_cliente: 'uuid-1', fotos: {}, errores: null, nuevo: true};
  const cola = {
    calls,
    abrirBorrador: async ({uuid} = {}) => {
      calls.abierto = uuid ?? null;
      if (borrador === 'ninguno') return null;
      return {...base, ...(borrador || {}), datos: {...(borrador?.datos || {})}};
    },
    guardarBorrador: async (uuid, datos) => { calls.guardados.push([uuid, datos]); return true; },
    ponerFoto: async (uuid, campo, asset, opciones) => { calls.fotos.push([uuid, campo, asset, opciones]); return {uri: 'file:///test/attachments/emergencia/' + campo + '.jpg', fileName: campo + '.jpg', mimeType: 'image/jpeg'}; },
    quitarFoto: async (uuid, campo) => { calls.quitadas.push([uuid, campo]); return true; },
    encolarCaso: async (uuid, args) => { calls.encolados.push([uuid, args]); return encolar ? encolar(uuid, args) : {uuid_cliente: uuid, envio: {estado: 'pendiente'}}; },
    descartar: async (uuid) => { calls.descartados.push(uuid); return true; },
    reintentar: async (uuid) => { calls.reintentos.push(uuid); return {synced: 1, failed: 0}; },
    getLocalidadesGuardadas: async () => ({localidades: [{id: 12, nombre: 'Barranqueras'}, {id: 3, nombre: 'Resistencia'}, {id: 4, nombre: 'Barrio Toba'}]}),
    getEnviosLocales: async () => locales,
    getMisEnvios: async () => misEnvios,
  };
  return cola;
}

async function montarFormulario({borrador, encolar, consultar, props = {}, jpeg} = {}) {
  const {mocks, toasts, alerts, runtime} = await baseMocks();
  const emergencia = runtime.load('../utils/emergencia');
  const cola = colaFalsa({borrador, encolar});
  cola.abrirBorrador = (anterior => async (args) => {
    const b = await anterior(args);
    return b && {...b, datos: {...emergencia.datosIniciales(), ...(borrador?.datos || {})}};
  })(cola.abrirBorrador);
  const consultas = [];
  const conversiones = [];
  const ubicacion = {pedidos: 0};
  const terminados = [];
  const olvidados = [];
  Object.assign(mocks, {
    '../services/webAttachments': {forgetWebFile: (uri) => { olvidados.push(uri); return true; }},
    'expo-location': {requestForegroundPermissionsAsync: async () => ({status: 'granted'}), Accuracy: {High: 4}},
    '../services/imagePicker': {
      requestCameraPermissionsAsync: async () => ({granted: true}),
      launchCameraAsync: async () => ({canceled: false, assets: [{uri: 'file:///cache/camara.heic', fileName: 'IMG.HEIC'}]}),
      launchImageLibraryAsync: async () => ({canceled: false, assets: [{uri: 'file:///cache/galeria.png', fileName: 'g.png'}]}),
    },
    '../services/emergenciaApi': {consultarPersona: async (args) => { consultas.push(args); return consultar ? consultar(args) : {success: true, origen: 'personas', data: {nombre: 'Rosa', apellido: 'Benitez', fecha_nacimiento: '1984-03-02'}}; }},
    '../services/ubicacion': {UBICACION_DEMORADA: 'UBICACION_DEMORADA', posicionActual: async () => { ubicacion.pedidos += 1; return {coords: {latitude: -27.4512345, longitude: -58.9876543, accuracy: 12.34}}; }},
    '../services/emergenciaCola': cola,
    '../utils/jpeg': {aJpeg: jpeg || (async (asset) => { conversiones.push(asset); return {...asset, uri: 'file:///cache/ImageManipulator/x.jpg', fileName: 'x.jpg', mimeType: 'image/jpeg', size: 1000}; })},
  });
  const Screen = loadScreen('src/screens/EmergenciaFormulario1Screen.js', mocks);
  const ui = await render(Screen, {onTerminar: (r) => terminados.push(r), ...props});
  return {...ui, cola, toasts, alerts, consultas, conversiones, ubicacion, terminados, emergencia, olvidados};
}

const COMPLETO = {traslado: 'BOMBEROS', dni: '30111222', sexo: 'F', nombre: 'Rosa', apellido: 'Benitez', adultos_f: 1, direccion: 'Calle 1'};

test('Formulario 1: sin datos no encola y muestra qué corregir, campo por campo', async () => {
  const ui = await montarFormulario();
  try {
    assert.equal(ui.cola.calls.abierto, null, 'abre el borrador en curso (sin uuid)');
    await ui.pressButton('Enviar');
    assert.equal(ui.cola.calls.encolados.length, 0);
    const labels = ui.labels();
    assert.ok(labels.includes('Para corregir'));
    for (const esperado of ['• Traslado: Elegí cómo llegó la familia.', '• DNI: El DNI del responsable tiene que tener 7 u 8 números.',
      '• Nombre: Escribí el nombre del responsable.', '• Apellido: Escribí el apellido del responsable.',
      '• Personas: Cargá al menos una persona: el responsable también cuenta.',
      '• Dirección: Escribí la dirección o una referencia: es el mínimo para ubicar a la familia.']) {
      assert.ok(labels.includes(esperado), esperado);
    }
    assert.ok(labels.includes('Elegí cómo llegó la familia.'), 'el error también va junto al campo');
    assert.equal(ui.input('Dirección o referencia').props.style.find(s => s && s.borderColor).borderColor, '#D00000');
    assert.equal(ui.toasts.at(-1).type, 'warning');
    // «Otra» exige texto.
    await ui.press('Traslado: Otra');
    assert.ok(ui.input('Otro traslado'));
    assert.equal(ui.input('Otro traslado').props.maxLength, 120);
    assert.ok(ui.labels().includes('Contá cómo llegó la familia.'));
    await ui.escribir('Otro traslado', 'Lancha vecinal');
    assert.ok(!ui.labels().includes('Contá cómo llegó la familia.'));
  } finally { await ui.close(); }
});

test('Formulario 1: consulta, contadores, localidad, GPS, foto y envío con la hora de ese momento', async () => {
  const ui = await montarFormulario();
  try {
    await ui.press('Traslado: Bomberos');
    await ui.escribir('DNI del responsable', '30.111.222');
    assert.equal(ui.input('DNI del responsable').props.value, '30111222');
    await ui.pressButton('Buscar persona');
    assert.ok(ui.labels().some(l => l.startsWith('Elegí el sexo')), 'sin sexo no consulta');
    assert.equal(ui.consultas.length, 0);
    await ui.press('Sexo: Femenino');
    await ui.pressButton('Buscar persona');
    assert.deepEqual(JSON.parse(JSON.stringify(ui.consultas)), [{dni: '30111222', sexo: 'F'}]);
    assert.equal(ui.input('Nombre').props.value, 'Rosa');
    assert.equal(ui.input('Apellido').props.value, 'Benitez');
    assert.equal(ui.tree.root.findByType('FechaInput').props.value, '02/03/1984');
    assert.ok(ui.labels().includes('Encontramos a Rosa Benitez en la Base de Personas.'));
    assert.ok(ui.labels().includes('Nombre'), 'encontrada: nombre no obligatorio');

    await ui.press('Sumar Adultos · Mujeres');
    await ui.press('Sumar Menores · Varones');
    await ui.press('Sumar Menores · Varones');
    await ui.press('Restar Menores · Varones');
    assert.ok(ui.labels().includes('Total: 2 personas'));
    await ui.press('Sumar Lactantes');
    await ui.press('Embarazo');
    assert.equal(ui.porLabel('Embarazo')[0].props.accessibilityState.checked, true);

    await ui.escribir('Dirección o referencia', 'Av. 9 de Julio 1200');
    await ui.escribir('Buscar localidad', 'barr');
    assert.deepEqual(ui.porLabel('Elegir Barranqueras').length, 1);
    assert.deepEqual(ui.porLabel('Elegir Barrio Toba').length, 1);
    assert.equal(ui.porLabel('Elegir Resistencia').length, 0);
    await ui.press('Elegir Barranqueras');
    assert.ok(ui.labels().includes('Barranqueras'));

    await ui.pressButton('Tomar ubicación');
    assert.equal(ui.ubicacion.pedidos, 1);
    assert.ok(ui.labels().includes('-27.451235, -58.987654 (±12.3 m)'));

    await ui.pressButton('Agregar foto de la vivienda');
    const [titulo, , opciones] = ui.alerts.at(-1);
    assert.equal(titulo, 'Foto de la vivienda');
    await renderer.act(async () => { await opciones.find(o => o.text === 'Galería').onPress(); });
    assert.equal(ui.conversiones.length, 1, 'pasa por aJpeg');
    const [uuidFoto, campo, convertido, opcionesFoto] = ui.cola.calls.fotos[0];
    assert.equal(uuidFoto, 'uuid-1'); assert.equal(campo, 'foto_vivienda');
    assert.equal(convertido.mimeType, 'image/jpeg');
    assert.deepEqual({...opcionesFoto}, {temporal: true}, 'en nativo la salida de aJpeg es temporal');
    assert.ok(ui.porLabel('Quitar Foto de la vivienda').length);

    const antes = Date.now();
    await ui.pressButton('Enviar');
    assert.equal(ui.cola.calls.encolados.length, 1);
    const [uuid, {datos, relevadoEn}] = ui.cola.calls.encolados[0];
    assert.equal(uuid, 'uuid-1');
    assert.ok(relevadoEn.getTime() >= antes && relevadoEn.getTime() <= Date.now(), 'relevado_en = al tocar Enviar');
    assert.equal(datos.adultos_f, 1); assert.equal(datos.menores_m, 1); assert.equal(datos.lactantes, 1);
    assert.equal(datos.embarazo, true); assert.equal(datos.localidad, 12); assert.equal(datos.latitud, -27.451235);
    assert.equal(datos.precision_m, 12.3); assert.equal(datos.consulta.estado, 'encontrada');
    assert.equal(ui.terminados.length, 1);
    assert.equal(ui.toasts.at(-1).message, 'Guardado en el teléfono: se envía solo apenas haya señal.');
  } finally { await ui.close(); }
});

test('Formulario 1: persona que no figura o sin red pide nombre y apellido; cambiar el DNI anula la consulta', async () => {
  let respuesta = () => { throw Object.assign(new Error('No figura'), {status: 404, payload: {success: false}}); };
  const ui = await montarFormulario({consultar: () => respuesta()});
  try {
    await ui.escribir('DNI del responsable', '30111222');
    await ui.press('Sexo: Masculino');
    await ui.pressButton('Buscar persona');
    assert.ok(ui.labels().includes('No figura en la Base de Personas: cargá nombre y apellido para darla de alta.'));
    assert.ok(ui.labels().includes('Nombre *'));
    respuesta = () => { throw Object.assign(new Error('Network request failed'), {network: true}); };
    await ui.pressButton('Buscar persona');
    assert.ok(ui.labels().some(l => l.startsWith('Sin conexión: no se pudo buscar a la persona.')));
    respuesta = () => { throw Object.assign(new Error('fallecida'), {status: 404, payload: {success: false, fallecido: true}}); };
    await ui.pressButton('Buscar persona');
    assert.ok(ui.labels().some(l => l.startsWith('La persona figura como fallecida')));
    respuesta = () => ({success: true, origen: 'personas', data: {nombre: 'Juan', apellido: 'Paz'}});
    await ui.pressButton('Buscar persona');
    assert.ok(ui.labels().includes('Nombre'));
    await ui.escribir('DNI del responsable', '30111223');
    assert.ok(ui.labels().includes('Nombre *'), 'otro DNI: la confirmación ya no vale');
  } finally { await ui.close(); }
});

test('Formulario 1: el escaneo del DNI completa la identidad', async () => {
  const ui = await montarFormulario();
  try {
    await ui.pressButton('Escanear DNI');
    const camara = ui.tree.root.findByType('CameraModal');
    assert.equal(camara.props.visible, true); assert.equal(camara.props.purpose, 'scanner');
    await renderer.act(async () => {
      camara.props.onBarcodeScanned({data: '00123456789@BENITEZ@ROSA@F@30111222@A@02/03/1984@01/01/2020', type: 'pdf417'});
    });
    assert.equal(ui.tree.root.findByType('CameraModal').props.visible, false);
    assert.equal(ui.input('DNI del responsable').props.value, '30111222');
    assert.equal(ui.input('Nombre').props.value, 'ROSA');
    assert.equal(ui.input('Apellido').props.value, 'BENITEZ');
    assert.equal(ui.porLabel('Sexo: Femenino')[0].props.accessibilityState.selected, true);
    assert.ok(ui.labels().includes('Datos tomados del DNI.'));
    assert.equal(ui.consultas.length, 0);
  } finally { await ui.close(); }
});

test('Formulario 1: un borrador devuelto por el servidor muestra sus errores y se corrige con el mismo uuid', async () => {
  const ui = await montarFormulario({
    props: {uuid: 'uuid-400'},
    borrador: {uuid_cliente: 'uuid-400', nuevo: false, datos: COMPLETO,
      errores: {direccion: ['Escribí la dirección.'], foto_acceso: ['La foto no es JPEG.'], total: ['Cargá al menos una persona.']}},
  });
  try {
    assert.equal(ui.cola.calls.abierto, 'uuid-400');
    const labels = ui.labels();
    assert.ok(labels.includes('• Dirección: Escribí la dirección.'));
    assert.ok(labels.includes('• Foto del acceso: La foto no es JPEG.'));
    assert.ok(labels.includes('Escribí la dirección.'));
    await ui.escribir('Dirección o referencia', 'Calle 2');
    assert.ok(!ui.labels().includes('Escribí la dirección.'), 'al corregir el campo se va su error');
    await ui.press('Sumar Mayores · Varones');
    assert.ok(!ui.labels().includes('• Personas: Cargá al menos una persona.'));
    await ui.pressButton('Enviar');
    assert.equal(ui.cola.calls.encolados[0][0], 'uuid-400');
  } finally { await ui.close(); }
});

test('Formulario 1: si el envío inmediato vuelve con 400 se queda en la pantalla con los errores', async () => {
  const ui = await montarFormulario({
    borrador: {datos: COMPLETO},
    encolar: (uuid) => ({uuid_cliente: uuid, envio: {estado: 'corregir', errores: {dni: ['DNI inválido.']}}}),
  });
  try {
    await ui.pressButton('Enviar');
    assert.equal(ui.terminados.length, 0);
    assert.ok(ui.labels().includes('• DNI: DNI inválido.'));
    assert.equal(ui.toasts.at(-1).message, 'El servidor rechazó algunos datos. Corregí lo marcado y volvé a enviar.');
  } finally { await ui.close(); }
});

test('Formulario 1: enviado al toque muestra el número; foto que no convierte avisa sin guardar', async () => {
  const fallas = Object.assign(new Error('x'), {code: 'JPEG_EXCEDE'});
  const ui = await montarFormulario({
    borrador: {datos: COMPLETO},
    encolar: (uuid) => ({uuid_cliente: uuid, envio: {estado: 'enviado', resultado: {numero: '2026-000184'}}}),
    jpeg: async () => { throw fallas; },
  });
  try {
    await ui.pressButton('Agregar foto del acceso');
    await renderer.act(async () => { await ui.alerts.at(-1)[2].find(o => o.text === 'Cámara').onPress(); });
    assert.equal(ui.cola.calls.fotos.length, 0);
    assert.equal(ui.toasts.at(-1).message, 'La foto sigue pesando demasiado después de comprimirla. Probá con otra foto.');
    await ui.pressButton('Enviar');
    assert.equal(ui.toasts.at(-1).message, 'Familia enviada: caso 2026-000184.');
  } finally { await ui.close(); }
});

test('Formulario 1: el borrador se guarda al cerrar la pantalla y se puede descartar con confirmación', async () => {
  const ui = await montarFormulario();
  await ui.escribir('Dirección o referencia', 'Ruta 11 km 1000');
  await ui.close();
  const [uuid, datos] = ui.cola.calls.guardados.at(-1);
  assert.equal(uuid, 'uuid-1'); assert.equal(datos.direccion, 'Ruta 11 km 1000');

  const otra = await montarFormulario();
  try {
    await otra.pressButton('Descartar relevamiento');
    const [titulo, , opciones] = otra.alerts.at(-1);
    assert.equal(titulo, 'Descartar relevamiento');
    assert.equal(otra.cola.calls.descartados.length, 0, 'no sin confirmar');
    await renderer.act(async () => { await opciones.find(o => o.text === 'Descartar').onPress(); });
    assert.deepEqual(otra.cola.calls.descartados, ['uuid-1']);
    assert.equal(otra.terminados.length, 1);
  } finally { await otra.close(); }
});

// ---- Mis envíos ----

async function montarMisEnvios({locales = [], misEnvios = {casos: []}} = {}) {
  const {mocks, toasts, alerts} = await baseMocks();
  const cola = colaFalsa({locales, misEnvios});
  mocks['../services/emergenciaCola'] = cola;
  const corregidos = [];
  let nuevos = 0;
  const Screen = loadScreen('src/screens/EmergenciaMisEnviosScreen.js', mocks);
  const ui = await render(Screen, {onCorregir: (uuid) => corregidos.push(uuid), onNuevo: () => { nuevos += 1; }});
  return {...ui, cola, toasts, alerts, corregidos, nuevos: () => nuevos};
}

const local = (extra) => ({tipo: 'envio', uuid_cliente: 'u', resumen: 'Benitez, Rosa · DNI 30111222 · 3 personas',
  creado_en: '2026-11-14T13:00:00Z', puedeReintentar: false, puedeDescartar: true, ...extra});

test('Mis envíos: lo del teléfono (pendiente, error, para corregir) y lo recibido, con sus acciones', async () => {
  const ui = await montarMisEnvios({
    locales: [
      local({uuid_cliente: 'p', estado: 'pendiente'}),
      local({uuid_cliente: 'e', estado: 'error', code: 'REINTENTOS_AGOTADOS', puedeReintentar: true}),
      local({uuid_cliente: 'x', estado: 'error', code: 'UUID_EN_USO'}),
      local({uuid_cliente: 'c', tipo: 'borrador', estado: 'corregir', code: 'VALIDACION', errores: {direccion: ['Escribí la dirección.']}}),
    ],
    misEnvios: {casos: [{numero: '2026-000185', estado: 'EN_GESTION', total_declarado: 2, creado_en: '2026-11-12T10:05:00-03:00'},
      {numero: '2026-000184', estado: 'ALOJADO', total_declarado: 1, creado_en: '2026-11-12T10:00:00-03:00'}]},
  });
  try {
    const labels = ui.labels();
    for (const t of ['En el teléfono', 'Recibidos', 'Pendiente de envío', 'Con error', 'Para corregir', 'Caso 2026-000185',
      'En gestión', 'Alojado', '• Dirección: Escribí la dirección.',
      'No se pudo enviar después de varios intentos. Probá reintentar cuando tengas buena señal.']) {
      assert.ok(labels.includes(t), t);
    }
    assert.ok(labels.some(l => l.startsWith('Este envío no se puede mandar: su identificador ya lo usó otro caso.')));
    const titulos = ui.tree.root.findAllByType('CustomButton').map(b => b.props.title);
    assert.equal(titulos.filter(t => t === 'Reintentar').length, 1, 'UUID_EN_USO no ofrece reintentar');
    assert.equal(titulos.filter(t => t === 'Corregir').length, 1);
    await ui.pressButton('Reintentar');
    assert.deepEqual(ui.cola.calls.reintentos, ['e']);
    await ui.pressButton('Corregir');
    assert.deepEqual(ui.corregidos, ['c']);
    await ui.pressButton('Relevar una familia');
    assert.equal(ui.nuevos(), 1);
    const descartar = ui.tree.root.findAllByType('CustomButton').filter(b => b.props.title === 'Descartar')[0];
    await renderer.act(async () => { descartar.props.onPress(); });
    assert.equal(ui.cola.calls.descartados.length, 0);
    await renderer.act(async () => { await ui.alerts.at(-1)[2].find(o => o.text === 'Descartar').onPress(); });
    assert.deepEqual(ui.cola.calls.descartados, ['p']);
  } finally { await ui.close(); }
});

test('Mis envíos: sin red muestra la lista guardada con aviso', async () => {
  const ui = await montarMisEnvios({misEnvios: {casos: [{numero: '2026-000001', estado: 'NUEVO', total_declarado: 1}], desdeCache: true, sinRed: true}});
  try {
    assert.ok(ui.labels().includes('Sin conexión: se muestra la última lista guardada.'));
    assert.ok(ui.labels().includes('Caso 2026-000001'));
    assert.ok(ui.labels().includes('No hay envíos pendientes.'));
  } finally { await ui.close(); }
});

// ---- EmergenciaApp ----

async function montarApp({pendientes = 0, resumen = null, enCurso = null, sync = null, reintento = null, globals = {}} = {}) {
  const {mocks, toasts, alerts} = await baseMocks();
  const llamadas = {sync: 0, logout: 0, reintentar: 0, localidades: 0, intervalos: [], limpiados: [], desuscripto: 0, descartados: [], orden: []};
  const pantallas = {};
  const capturar = nombre => props => { pantallas[nombre] = props; return null; };
  Object.assign(mocks, {
    '@react-native-community/netinfo': {__esModule: true, default: {addEventListener: (fn) => { llamadas.netinfo = fn; return () => { llamadas.desuscripto += 1; }; }}},
    '../context/AuthContext': {useAuth: () => ({user: {nombre: 'Ana'}, logout() { llamadas.logout += 1; }})},
    '../components/Banner': {__esModule: true, default: 'Banner'},
    '../components/SettingsPanel': {__esModule: true, default: 'SettingsPanel'},
    '../screens/EmergenciaInicioScreen': {__esModule: true, default: capturar('inicio')},
    '../screens/EmergenciaMisEnviosScreen': {__esModule: true, default: capturar('envios')},
    '../screens/EmergenciaFormulario1Screen': {__esModule: true, default: capturar('formulario')},
    '../screens/EmergenciaMisDispositivosScreen': {__esModule: true, default: capturar('kitsDispositivos')},
    '../screens/EmergenciaEntregasScreen': {__esModule: true, default: capturar('kitsEntregas')},
    '../screens/EmergenciaRecibirEntregaScreen': {__esModule: true, default: capturar('kitsRecibir')},
    '../screens/EmergenciaLlegadaBuscarScreen': {__esModule: true, default: capturar('llegadasBuscar')},
    '../screens/EmergenciaDerivacionScreen': {__esModule: true, default: capturar('llegadasDerivacion')},
    '../screens/EmergenciaIntegrantesScreen': {__esModule: true, default: capturar('llegadasIntegrantes')},
    '../screens/EmergenciaFichaScreen': {__esModule: true, default: capturar('llegadasFicha')},
    '../screens/EmergenciaCierreScreen': {__esModule: true, default: capturar('llegadasCierre')},
    '../screens/EmergenciaPuertaScreen': {__esModule: true, default: capturar('llegadasPuerta')},
    '../services/emergenciaLimpieza': {depurarBorradoresFicha: async () => {}},
    '../services/emergenciaCola': {
      syncPendientes: async () => { llamadas.sync += 1; llamadas.orden.push('sync'); return sync ? sync() : {synced: 0}; },
      getPendingCount: async () => pendientes,
      getResumenPendientes: async () => resumen || {enCola: pendientes, paraRevisar: 0, sinTerminar: 0},
      getBorradorEnCurso: async () => enCurso,
      descartar: async (uuid) => { llamadas.descartados.push(uuid); return true; },
      reintentar: async () => { llamadas.reintentar += 1; llamadas.orden.push('reintentar'); return reintento ? reintento() : {synced: 1, failed: 0}; },
      getLocalidadesGuardadas: async () => { llamadas.localidades += 1; return {localidades: []}; },
    },
  });
  const App = loadScreen('src/navigation/EmergenciaApp.js', mocks, {
    setInterval: (fn, ms) => { llamadas.intervalos.push(ms); return 99; },
    clearInterval: (id) => { llamadas.limpiados.push(id); },
    globals,
  });
  const ui = await render(App, {});
  return {...ui, llamadas, pantallas, toasts, alerts};
}

test('EmergenciaApp: sincroniza y guarda localidades al montarse, y deja de hacerlo al desmontarse', async () => {
  const ui = await montarApp({pendientes: 2});
  assert.equal(ui.llamadas.sync, 1);
  assert.equal(ui.llamadas.localidades, 1);
  assert.deepEqual(ui.llamadas.intervalos, [8000]);
  const banner = ui.tree.root.findByType('Banner');
  assert.equal(banner.props.syncStatus, 'pending');
  assert.equal(banner.props.syncPendingCount, 2);
  await ui.close();
  assert.deepEqual(ui.llamadas.limpiados, [99]);
  assert.equal(ui.llamadas.desuscripto, 1);
});

test('EmergenciaApp: «Ingreso de familias» abre Mis envíos, de ahí el formulario y vuelve', async () => {
  const ui = await montarApp();
  try {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'relevar', titulo: 'Ingreso de familias'}); });
    assert.equal(ui.tree.root.findByType('Banner').props.title, 'Ingreso de familias');
    assert.ok(ui.pantallas.envios);
    await renderer.act(async () => { ui.pantallas.envios.onCorregir('uuid-400'); });
    assert.equal(ui.pantallas.formulario.uuid, 'uuid-400');
    assert.equal(ui.tree.root.findByType('Banner').props.title, 'Relevar una familia');
    await renderer.act(async () => { ui.pantallas.formulario.onTerminar(); });
    assert.equal(ui.tree.root.findByType('Banner').props.title, 'Ingreso de familias');
    await renderer.act(async () => { ui.tree.root.findByType('Banner').props.onBackPress(); });
    assert.equal(ui.tree.root.findByType('Banner').props.title, 'Hola, Ana');
    // Un acceso que esta versión no conoce queda en «Próximamente».
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'otro', titulo: 'Algo nuevo'}); });
    assert.equal(ui.alerts.at(-1)[0], 'Próximamente');
  } finally { await ui.close(); }
});

test('EmergenciaApp M3: «Recepción de kits» -> dispositivos -> entregas -> recibir, y volver por cada paso', async () => {
  const ui = await montarApp();
  const titulo = () => ui.tree.root.findByType('Banner').props.title;
  const atras = async () => renderer.act(async () => { ui.tree.root.findByType('Banner').props.onBackPress(); });
  try {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'kits', titulo: 'Recepción de kits'}); });
    assert.equal(titulo(), 'Recepción de kits');
    assert.ok(ui.pantallas.kitsDispositivos);
    assert.equal(ui.tree.root.findByType('Banner').props.showBackButton, true);
    // Con varios dispositivos: elegir uno, abrir una entrega y volver.
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 7, nombre: 'Club Sarmiento'}, {unico: false}); });
    assert.equal(titulo(), 'Club Sarmiento');
    assert.equal(ui.pantallas.kitsEntregas.dispositivo.id, 7);
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onAbrir({id: 31, numero: '2026-K-000031', lineas: []}); });
    assert.equal(titulo(), 'Recibir entrega');
    assert.equal(ui.pantallas.kitsRecibir.entrega.id, 31);
    assert.equal(ui.pantallas.kitsRecibir.dispositivoId, 7);
    await atras();
    assert.equal(titulo(), 'Club Sarmiento');
    await atras();
    assert.equal(titulo(), 'Recepción de kits');
    await atras();
    assert.equal(titulo(), 'Hola, Ana');
    // Con uno solo: entra directo, y volver desde las entregas va al inicio.
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'kits', titulo: 'Recepción de kits'}); });
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 9, nombre: 'Escuela 12'}, {unico: true}); });
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onAbrir({id: 40, numero: 'K-40', lineas: []}); });
    await atras();
    assert.equal(titulo(), 'Escuela 12');
    await atras();
    assert.equal(titulo(), 'Hola, Ana');
  } finally { await ui.close(); }
});

test('EmergenciaApp M3: recibida y 409 vuelven a las entregas; 404 a los dispositivos; SIN_MODULO al inicio', async () => {
  const ui = await montarApp();
  const titulo = () => ui.tree.root.findByType('Banner').props.title;
  const abrirRecepcion = async () => {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'kits', titulo: 'Recepción de kits'}); });
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 7, nombre: 'Club Sarmiento'}, {unico: false}); });
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onAbrir({id: 31, numero: 'K-31', lineas: []}); });
    assert.equal(titulo(), 'Recibir entrega');
  };
  try {
    await abrirRecepcion();
    await renderer.act(async () => { ui.pantallas.kitsRecibir.onTerminar('recibida', {estado: 'RECIBIDA', diferencias: []}); });
    assert.equal(titulo(), 'Club Sarmiento');
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onAbrir({id: 31, numero: 'K-31', lineas: []}); });
    await renderer.act(async () => { ui.pantallas.kitsRecibir.onTerminar('conflicto', {estadoActual: 'CANCELADA'}); });
    assert.equal(titulo(), 'Club Sarmiento');
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onAbrir({id: 31, numero: 'K-31', lineas: []}); });
    await renderer.act(async () => { ui.pantallas.kitsRecibir.onTerminar('no_encontrada'); });
    assert.equal(titulo(), 'Recepción de kits');
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 7, nombre: 'Club Sarmiento'}, {unico: false}); });
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onNoEncontrado(); });
    assert.equal(titulo(), 'Recepción de kits');
    assert.equal(ui.toasts.at(-1).type, 'warning');
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onSinModulo('El usuario no recibe kits.'); });
    assert.equal(titulo(), 'Hola, Ana');
    assert.deepEqual(ui.alerts.at(-1).slice(0, 2), ['Sin permiso', 'El usuario no recibe kits.']);
  } finally { await ui.close(); }
});

test('EmergenciaApp M3: mientras se manda la recepción no hay flecha de volver ni se puede salir', async () => {
  const ui = await montarApp();
  const banner = () => ui.tree.root.findByType('Banner');
  try {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'kits', titulo: 'Recepción de kits'}); });
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 7, nombre: 'Club'}, {unico: false}); });
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onAbrir({id: 31, numero: 'K-31', lineas: []}); });
    assert.equal(banner().props.showBackButton, true);
    await renderer.act(async () => { ui.pantallas.kitsRecibir.onEnviando(true); });
    assert.equal(banner().props.showBackButton, false);
    await renderer.act(async () => { banner().props.onBackPress(); });
    assert.equal(banner().props.title, 'Recibir entrega', 'volver no hace nada mientras se manda');
    await renderer.act(async () => { ui.pantallas.kitsRecibir.onEnviando(false); });
    assert.equal(banner().props.showBackButton, true);
    await renderer.act(async () => { banner().props.onBackPress(); });
    assert.equal(banner().props.title, 'Club');
  } finally { await ui.close(); }
});

test('EmergenciaApp M3: al volver por un 404 a «mis dispositivos» no se entra directo (sin bucle con un solo dispositivo)', async () => {
  const ui = await montarApp();
  try {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'kits', titulo: 'Recepción de kits'}); });
    assert.equal(ui.pantallas.kitsDispositivos.entrarDirecto, true);
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 7, nombre: 'Club'}, {unico: true}); });
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onNoEncontrado(); });
    assert.equal(ui.pantallas.kitsDispositivos.entrarDirecto, false);
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 7, nombre: 'Club'}, {unico: false}); });
    await renderer.act(async () => { ui.pantallas.kitsEntregas.onAbrir({id: 31, numero: 'K-31', lineas: []}); });
    await renderer.act(async () => { ui.pantallas.kitsRecibir.onTerminar('no_encontrada'); });
    assert.equal(ui.pantallas.kitsDispositivos.entrarDirecto, false);
  } finally { await ui.close(); }
});

test('EmergenciaApp M3: el botón de sincronizar recarga las listas de kits, sin el aviso de M1', async () => {
  const ui = await montarApp();
  try {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'kits', titulo: 'Recepción de kits'}); });
    const antes = ui.pantallas.kitsDispositivos.recarga;
    await renderer.act(async () => { await ui.tree.root.findByType('Banner').props.onSyncPress(); });
    assert.equal(ui.pantallas.kitsDispositivos.recarga, antes + 1);
    assert.ok(!ui.toasts.some(t => t.message === 'No había nada para enviar.'));
    await renderer.act(async () => { ui.pantallas.kitsDispositivos.onElegir({id: 7, nombre: 'Club'}, {unico: false}); });
    const enEntregas = ui.pantallas.kitsEntregas.recarga;
    await renderer.act(async () => { await ui.tree.root.findByType('Banner').props.onSyncPress(); });
    assert.equal(ui.pantallas.kitsEntregas.recarga, enEntregas + 1);
  } finally { await ui.close(); }
});

test('EmergenciaApp: cerrar sesión con familias sin entregar avisa antes de salir', async () => {
  const ui = await montarApp({pendientes: 3});
  try {
    await renderer.act(async () => { await ui.tree.root.findByType('SettingsPanel').props.onLogout(); });
    assert.equal(ui.llamadas.logout, 0);
    const [titulo, mensaje, opciones] = ui.alerts.at(-1);
    assert.equal(titulo, 'Cerrar sesión');
    assert.equal(mensaje, '3 familias en cola: se envían solas cuando vuelvas a entrar con este usuario.');
    opciones.find(o => o.text === 'Salir').onPress();
    assert.equal(ui.llamadas.logout, 1);
  } finally { await ui.close(); }
  const sinNada = await montarApp({pendientes: 0});
  try {
    await renderer.act(async () => { await sinNada.tree.root.findByType('SettingsPanel').props.onLogout(); });
    assert.equal(sinNada.llamadas.logout, 1);
  } finally { await sinNada.close(); }
});

test('EmergenciaApp: el botón de sincronizar reintenta lo pendiente', async () => {
  const ui = await montarApp({pendientes: 1});
  try {
    await renderer.act(async () => { await ui.tree.root.findByType('Banner').props.onSyncPress(); });
    assert.equal(ui.llamadas.reintentar, 1);
    assert.equal(ui.toasts.at(-1).message, 'Se enviaron 1.');
  } finally { await ui.close(); }
});

// ---- Revisión M1: identidad, doble envío, fotos, demorado, logout, borrador en curso, sync manual ----

const diferida = () => {
  let resolver;
  let rechazar;
  const promesa = new Promise((res, rej) => { resolver = res; rechazar = rej; });
  return {promesa, resolver, rechazar};
};

test('Formulario 1: una consulta lenta no confirma a otra persona si cambió el DNI o el sexo', async () => {
  const pedidos = [];
  const ui = await montarFormulario({consultar: () => { const d = diferida(); pedidos.push(d); return d.promesa; }});
  // Sin esperar: la consulta queda en vuelo hasta que el test la resuelve.
  const disparar = async (u, titulo) => renderer.act(async () => { u.button(titulo).props.onPress(); await esperar(); });
  try {
    await ui.escribir('DNI del responsable', '30111222');
    await ui.press('Sexo: Femenino');
    await disparar(ui, 'Buscar persona');
    assert.equal(pedidos.length, 1);
    await ui.escribir('DNI del responsable', '30111223');
    await renderer.act(async () => { pedidos[0].resolver({success: true, data: {nombre: 'Rosa', apellido: 'Benitez'}}); await esperar(); });
    assert.equal(ui.input('Nombre').props.value, '', 'no completa con los datos de otro DNI');
    assert.ok(ui.labels().includes('Nombre *'), 'sigue pidiendo nombre');
    assert.ok(!ui.labels().some(l => l.startsWith('Encontramos')));
    assert.equal(ui.button('Buscar persona').props.loading, false);

    // Mismo DNI, otro sexo: tampoco.
    await disparar(ui, 'Buscar persona');
    await ui.press('Sexo: Masculino');
    await renderer.act(async () => { pedidos[1].resolver({success: true, data: {nombre: 'Rosa', apellido: 'Benitez'}}); await esperar(); });
    assert.ok(ui.labels().includes('Nombre *'));
    // Un 404 tardío tampoco marca nada.
    await disparar(ui, 'Buscar persona');
    await ui.escribir('DNI del responsable', '30111224');
    await renderer.act(async () => { pedidos[2].rechazar(Object.assign(new Error('No'), {status: 404, payload: {}})); await esperar(); });
    assert.ok(!ui.labels().includes('No figura en la Base de Personas: cargá nombre y apellido para darla de alta.'));

    // Dos pedidos seguidos del mismo DNI: vale el último.
    await disparar(ui, 'Buscar persona');
    await disparar(ui, 'Buscar persona');
    await renderer.act(async () => { pedidos[4].resolver({success: true, data: {nombre: 'Juan', apellido: 'Paz'}}); await esperar(); });
    await renderer.act(async () => { pedidos[3].resolver({success: true, data: {nombre: 'Viejo', apellido: 'Lento'}}); await esperar(); });
    assert.equal(ui.input('Nombre').props.value, 'Juan');
    assert.ok(ui.labels().includes('Nombre'), 'confirmada para el DNI y sexo actuales');
    // La confirmación que se guarda dice de quién es.
    await ui.press('Traslado: Bomberos');
    await ui.press('Sumar Adultos · Varones');
    await ui.escribir('Dirección o referencia', 'Calle 1');
    await ui.pressButton('Enviar');
    const [, {datos}] = ui.cola.calls.encolados[0];
    assert.deepEqual({...datos.consulta}, {estado: 'encontrada', dni: '30111224', sexo: 'M'});
  } finally { await ui.close(); }
});

test('Formulario 1: un segundo toque en «Enviar» mientras se envía no hace nada', async () => {
  const pendiente = diferida();
  const ui = await montarFormulario({borrador: {datos: COMPLETO}, encolar: () => pendiente.promesa});
  try {
    const enviar = ui.button('Enviar');
    await renderer.act(async () => { enviar.props.onPress(); enviar.props.onPress(); await esperar(); });
    await renderer.act(async () => { await ui.button('Enviar').props.onPress(); });
    assert.equal(ui.cola.calls.encolados.length, 1);
    await renderer.act(async () => { pendiente.resolver({uuid_cliente: 'uuid-1', envio: {estado: 'pendiente'}}); await esperar(); });
    assert.equal(ui.alerts.length, 0, 'sin alert de UNIQUE ni de nada');
    assert.equal(ui.terminados.length, 1);
  } finally { await ui.close(); }
});

test('Formulario 1: un error de `fotos` del servidor se muestra en la sección de fotos', async () => {
  const ui = await montarFormulario({props: {uuid: 'u'}, borrador: {uuid_cliente: 'u', nuevo: false, datos: COMPLETO,
    errores: {fotos: ['Mandá las fotos en JPEG.']}}});
  try {
    assert.ok(ui.labels().includes('• Fotos: Mandá las fotos en JPEG.'));
    assert.ok(ui.labels().includes('Mandá las fotos en JPEG.'), 'también junto a las fotos');
  } finally { await ui.close(); }
});

test('Formulario 1 web: tras guardar la foto se suelta el File del selector', async () => {
  plataforma.OS = 'web';
  try {
    const ui = await montarFormulario({jpeg: async (asset) => ({...asset, uri: 'blob:https://app.test/jpeg', mimeType: 'image/jpeg'})});
    try {
      await ui.pressButton('Agregar foto de la vivienda');
      await renderer.act(async () => { await ui.alerts.at(-1)[2].find(o => o.text === 'Galería').onPress(); });
      assert.equal(ui.cola.calls.fotos.length, 1);
      assert.deepEqual(ui.olvidados, ['file:///cache/galeria.png']);
    } finally { await ui.close(); }
  } finally { plataforma.OS = 'android'; }
});

test('Mis envíos: un envío demorado lo dice, y sigue sin botón de reintentar', async () => {
  const ui = await montarMisEnvios({locales: [local({uuid_cliente: 'd', estado: 'pendiente', demorado: true, retry_count: 4})]});
  try {
    assert.ok(ui.labels().includes('Demorado'));
    assert.ok(ui.labels().some(l => l.startsWith('Lleva varios intentos sin poder enviarse')));
    assert.ok(!ui.tree.root.findAllByType('CustomButton').some(b => b.props.title === 'Reintentar'));
  } finally { await ui.close(); }
});

test('Mis envíos: cuando la sincronización de fondo entregó algo, se vuelve a pedir «Recibidos»', async () => {
  const {mocks} = await baseMocks();
  const cola = colaFalsa();
  let pedidos = 0;
  cola.getMisEnvios = async () => { pedidos += 1; return {casos: pedidos > 1 ? [{numero: '2026-000190', estado: 'NUEVO', total_declarado: 1}] : []}; };
  mocks['../services/emergenciaCola'] = cola;
  const Screen = loadScreen('src/screens/EmergenciaMisEnviosScreen.js', mocks);
  let tree;
  await renderer.act(async () => { tree = renderer.create(React.createElement(Screen, {syncTick: 0, enviadosTick: 0})); await esperar(); });
  assert.equal(pedidos, 1);
  await renderer.act(async () => { tree.update(React.createElement(Screen, {syncTick: 1, enviadosTick: 0})); await esperar(); });
  assert.equal(pedidos, 1, 'una pasada sin entregas solo relee lo local');
  await renderer.act(async () => { tree.update(React.createElement(Screen, {syncTick: 2, enviadosTick: 1})); await esperar(); });
  assert.equal(pedidos, 2);
  assert.ok(tree.root.findAllByType('Text').map(text).includes('Caso 2026-000190'));
  await renderer.act(async () => tree.unmount());
});

test('aviso de salida: separa en cola, para revisar y sin terminar, con plurales', async () => {
  const {runtime} = await baseMocks();
  const {avisoDeSalida} = runtime.load('../utils/emergencia');
  assert.equal(avisoDeSalida({}), null);
  assert.equal(avisoDeSalida({enCola: 1}), '1 familia en cola: se envía sola cuando vuelvas a entrar con este usuario.');
  assert.equal(avisoDeSalida({paraRevisar: 1}),
    '1 envío para revisar (con error o para corregir): no sale solo; revisalo en «Mis envíos» cuando vuelvas a entrar.');
  assert.equal(avisoDeSalida({enCola: 2, paraRevisar: 3, sinTerminar: 1}), [
    '2 familias en cola: se envían solas cuando vuelvas a entrar con este usuario.',
    '3 envíos para revisar (con error o para corregir): no salen solos; revisalos en «Mis envíos» cuando vuelvas a entrar.',
    'Un formulario sin terminar: queda guardado en el teléfono para cuando vuelvas a entrar.'].join('\n'));
});

test('EmergenciaApp: cerrar sesión con solo un formulario sin terminar también avisa', async () => {
  const ui = await montarApp({resumen: {enCola: 0, paraRevisar: 1, sinTerminar: 1}});
  try {
    await renderer.act(async () => { await ui.tree.root.findByType('SettingsPanel').props.onLogout(); });
    assert.equal(ui.llamadas.logout, 0);
    const [, mensaje] = ui.alerts.at(-1);
    assert.ok(mensaje.includes('1 envío para revisar') && mensaje.includes('Un formulario sin terminar'));
    assert.ok(!mensaje.includes('en cola'));
  } finally { await ui.close(); }
});

test('EmergenciaApp: «Relevar una familia» con un borrador en curso pregunta; empezar otra descarta con confirmación', async () => {
  const ui = await montarApp({enCurso: {uuid_cliente: 'b-1', resumen: 'Benitez · DNI 30111222'}});
  try {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'relevar', titulo: 'Ingreso de familias'}); });
    await renderer.act(async () => { await ui.pantallas.envios.onNuevo(); });
    const [titulo, mensaje, opciones] = ui.alerts.at(-1);
    assert.equal(titulo, 'Formulario sin terminar');
    assert.ok(mensaje.includes('«Benitez · DNI 30111222»'));
    assert.deepEqual([...opciones.map(o => o.text)], ['Seguir con ese', 'Empezar otra', 'Cancelar']);
    assert.equal(ui.tree.root.findByType('Banner').props.title, 'Ingreso de familias', 'no abre en silencio');
    await renderer.act(async () => { opciones.find(o => o.text === 'Seguir con ese').onPress(); });
    assert.equal(ui.pantallas.formulario.uuid, 'b-1');
    await renderer.act(async () => { ui.pantallas.formulario.onTerminar(); });

    await renderer.act(async () => { await ui.pantallas.envios.onNuevo(); });
    await renderer.act(async () => { ui.alerts.at(-1)[2].find(o => o.text === 'Empezar otra').onPress(); });
    const [titulo2, , confirmar] = ui.alerts.at(-1);
    assert.equal(titulo2, 'Empezar otra familia');
    assert.deepEqual(ui.llamadas.descartados, [], 'no descarta sin confirmar');
    await renderer.act(async () => { await confirmar.find(o => o.text === 'Descartar y empezar').onPress(); });
    assert.deepEqual(ui.llamadas.descartados, ['b-1']);
    assert.equal(ui.tree.root.findByType('Banner').props.title, 'Relevar una familia');
    assert.equal(ui.pantallas.formulario.uuid, null);
  } finally { await ui.close(); }
  const sinBorrador = await montarApp();
  try {
    await renderer.act(async () => { sinBorrador.pantallas.inicio.onAbrir({clave: 'relevar', titulo: 'Ingreso de familias'}); });
    await renderer.act(async () => { await sinBorrador.pantallas.envios.onNuevo(); });
    assert.equal(sinBorrador.tree.root.findByType('Banner').props.title, 'Relevar una familia');
    assert.equal(sinBorrador.alerts.length, 0);
  } finally { await sinBorrador.close(); }
});

test('EmergenciaApp: el sync manual con una pasada de fondo en curso la espera, reintenta y muestra el resultado', async () => {
  const fondo = diferida();
  let primera = true;
  const ui = await montarApp({pendientes: 1, sync: () => { if (primera) { primera = false; return fondo.promesa; } return {synced: 0}; },
    reintento: () => ({synced: 1, failed: 0})});
  try {
    let manual;
    await renderer.act(async () => { manual = ui.tree.root.findByType('Banner').props.onSyncPress(); await esperar(); });
    assert.equal(ui.llamadas.reintentar, 0, 'espera a la pasada de fondo');
    assert.equal(ui.tree.root.findByType('Banner').props.syncStatus, 'syncing');
    await renderer.act(async () => { fondo.resolver({synced: 0}); await manual; });
    assert.deepEqual(ui.llamadas.orden, ['sync', 'reintentar']);
    assert.equal(ui.toasts.at(-1).message, 'Se enviaron 1.');
  } finally { await ui.close(); }
});

test('EmergenciaApp: una pasada de fondo que entregó algo avisa a «Mis envíos»', async () => {
  const ui = await montarApp({sync: () => ({synced: 1, failed: 0})});
  try {
    await renderer.act(async () => { ui.pantallas.inicio.onAbrir({clave: 'relevar', titulo: 'Ingreso de familias'}); });
    assert.ok(ui.pantallas.envios.enviadosTick >= 1);
  } finally { await ui.close(); }
});

// La reconexión: en web el evento `online` del navegador (como la cola, que mira navigator.onLine),
// no NetInfo web, que puede seguir con una prueba hecha sin señal.
const ventanaFalsa = () => {
  const handlers = new Map();
  return {handlers, addEventListener: (tipo, fn) => handlers.set(tipo, fn), removeEventListener: (tipo, fn) => {
    if (handlers.get(tipo) === fn) handlers.delete(tipo);
  }};
};
const inmediato = (fn) => setTimeout(fn, 0);

test('EmergenciaApp web: al volver la red sincroniza por el evento `online`, no por NetInfo', async () => {
  plataforma.OS = 'web';
  const ventana = ventanaFalsa();
  try {
    const ui = await montarApp({globals: {window: ventana, setTimeout: inmediato}});
    assert.equal(ui.llamadas.sync, 1);
    assert.equal(ui.llamadas.netinfo, undefined, 'en web no escucha NetInfo');
    assert.ok(ventana.handlers.has('online'));
    await renderer.act(async () => { ventana.handlers.get('online')(); await esperar(5); });
    assert.equal(ui.llamadas.sync, 2);
    await ui.close();
    assert.ok(!ventana.handlers.has('online'), 'deja de escuchar al desmontarse');
  } finally { plataforma.OS = 'android'; }
});

test('EmergenciaApp nativo: al volver la red sincroniza por NetInfo', async () => {
  const ventana = ventanaFalsa();
  const ui = await montarApp({globals: {window: ventana, setTimeout: inmediato}});
  try {
    assert.equal(ventana.handlers.size, 0, 'en nativo no usa window');
    assert.equal(typeof ui.llamadas.netinfo, 'function');
    await renderer.act(async () => { ui.llamadas.netinfo({isConnected: false}); await esperar(5); });
    assert.equal(ui.llamadas.sync, 1, 'sin red no sincroniza');
    await renderer.act(async () => { ui.llamadas.netinfo({isConnected: true, isInternetReachable: true}); await esperar(5); });
    assert.equal(ui.llamadas.sync, 2);
  } finally { await ui.close(); }
});
