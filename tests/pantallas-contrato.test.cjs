// Contrato back <-> app, parte pantallas: DNI duplicado, estados, sexo X, GPS, constructor,
// localidad, cupo, descartadas, volver a adjuntar y bloqueo por versión.
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
const field = (clave, texto, extra = {}) => ({tipo_item: 'campo', clave, texto, tipo: 'STRING', origen: 'pregunta', ...extra});
const group = (clave, titulo, items, extra = {}) => ({tipo: 'grupo', clave, titulo, items, ...extra});
const native = Object.fromEntries(['View', 'Text', 'ScrollView', 'TouchableOpacity', 'ActivityIndicator', 'Image', 'Pressable',
  'Modal', 'TextInput', 'KeyboardAvoidingView', 'FlatList', 'RefreshControl'].map(name => [name, name]));
Object.assign(native, {Platform: {OS: 'web'}, StyleSheet: {create: value => value, absoluteFillObject: {}}, Alert: {alert() {}}});
const theme = {colors: new Proxy({}, {get: () => '#5059BC'})};
const typography = {bold: 'Manrope', medium: 'Manrope', semibold: 'Manrope', regular: 'Manrope'};
const text = node => node.children.map(value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(value)).join('');

function loadTokens() {
  const exported = {};
  const code = transformSync(fs.readFileSync(path.join(root, 'src/theme/tokens.js'), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']}).code;
  vm.runInNewContext(code, {exports: exported});
  return exported;
}

function loadScreen(relative, mocks) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)(name => {
    assert.ok(mocks[name], 'Missing screen mock: ' + name); return mocks[name];
  }, module, module.exports);
  return module.exports.default;
}

async function render(Screen, props) {
  let tree;
  await renderer.act(async () => {tree = renderer.create(React.createElement(Screen, props));});
  const labels = () => tree.root.findAllByType('Text').map(text);
  const press = async (label, type = 'TouchableOpacity') => {
    const button = tree.root.findAllByType(type).find(node => node.findAllByType('Text').some(child => text(child) === label));
    assert.ok(button, 'Missing button ' + label);
    await renderer.act(async () => {await button.props.onPress();});
  };
  const button = title => tree.root.findAllByType('CustomButton').find(node => node.props.title === title);
  return {tree, labels, press, button, close: async () => renderer.act(async () => tree.unmount())};
}

// Detalle del relevamiento con servicio y servicios auxiliares mockeados.
async function mountDetail(options = {}) {
  const runtime = await setup();
  const items = options.items || [group('g-datos', 'Datos del caso', [field('pg-1', 'Pregunta uno')])];
  const definition = {items, version: 3, acepta_respuestas: true, ...(options.definition || {})};
  const alerts = [];
  const calls = {consultar: 0, saved: undefined, replaced: [], restored: []};
  const detail = () => ({id: 1, estado: 'EN_CURSO', source: 'asignado', backend: 'django_becas', nombre: 'QA',
    fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-12-31T23:59:59-03:00',
    cupo_maximo: 0, cupo_disponible: null, cupo_completo: null,
    definicion_formulario: definition, campos_definicion: runtime.definition.camposDelDiseno(definition), ...(options.detail || {})});
  const service = {
    getRelevamientoDetail: async () => ({success: true, detail: detail()}),
    getBecasFormularios: async () => ({records: options.records || []}),
    getFailedOperations: async () => options.failed || [],
    getDiscardedOperations: async () => options.discarded || [],
    countUnsentFormularios: async () => options.sinEnviar || 0,
    evaluarDniDuplicado: async () => options.duplicado || {bloquear: false, avisar: false, estado: null},
    dniYaRelevado: async () => false,
    saveBecasFormulario: async payload => {calls.saved = payload; return {success: true, syncResult: {synced: 1}};},
    restoreDiscardedOperation: async id => {calls.restored.push(id); return {restored: true, syncResult: {}};},
    replaceRejectedAttachment: async (...args) => {calls.replaced.push(args); return {success: true, syncResult: {}};},
  };
  const mocks = {
    react: React, 'react-native': native,
    '../components/FormInput': {__esModule: true, default: native.TextInput, FormInputContainer: native.View},
    '../services/definicionFormulario': runtime.definition,
    '../services/identityLookup': {...runtime.identity, consultarIdentidad: async () => {
      calls.consultar += 1;
      return {origen: 'padron', success: true, data: {dni: '30123456', sexo: 'F', nombre: 'Ana', apellido: 'Prueba', fecha_nacimiento: '1991-03-14'}};
    }},
    '../services/relevamientoService': {__esModule: true, default: service, validateFormularioAttachment: async () => {}},
    '../services/becasApi': {becasRequest: async () => ({})},
    '../theme/statusBadges': {relevamientoBadge: state => ({label: state}), casoBadge: state => ({label: state})},
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../context/ToastContext': {useToast: () => ({showToast: value => alerts.push(value), showAlert: (...args) => alerts.push(args)})},
    '../hooks/useAssignmentClock': {__esModule: true, default: () => new Date()},
    '../utils/dates': runtime.dates,
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '../services/reloj': {ahoraCorregido: () => options.ahora || new Date()},
    '../services/documentPicker': {getDocumentAsync: options.getDocumentAsync || (async () => ({canceled: true}))},
    '../services/imagePicker': {}, '../services/ubicacion': {posicionActual: async () => { throw new Error('sin GPS en tests'); }},
    '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '@react-native-community/netinfo': {__esModule: true, default: {fetch: async () => ({isConnected: true, isInternetReachable: true})}},
    '@react-native-community/datetimepicker': {__esModule: true, default: 'DateTimePicker', DateTimePickerAndroid: {open() {}}},
    '../hooks/useCameraPermissions': {__esModule: true, default: () => [{granted: true}, async () => ({granted: true})]},
    'expo-media-library': {}, 'expo-constants': {},
    '@react-native-async-storage/async-storage': {__esModule: true, default: {getItem: async () => null}},
    'expo-location': {getForegroundPermissionsAsync: async () => ({status: 'denied'}), requestForegroundPermissionsAsync: async () => ({status: 'denied'})},
    'react-native-safe-area-context': {useSafeAreaInsets: () => ({top: 0, bottom: 0})},
    'react-native-svg': {__esModule: true, default: 'Svg', Path: 'Path'},
    'expo-file-system/legacy': {documentDirectory: 'file:///test/'}, 'expo-sharing': {}, 'expo-web-browser': {},
    '../theme': loadTokens(),
  };
  for (const name of ['Banner', 'CameraModal', 'CustomButton', 'AuthVisualBackground', 'WebDateInput']) mocks['../components/' + name] = {__esModule: true, default: name};
  const Screen = loadScreen('src/screens/RelevamientoDetailScreen.js', mocks);
  const ui = await render(Screen, {relevamientoId: 1, onClose() {}});
  const identify = async (sexo = 'F') => {
    const dni = ui.tree.root.findAllByType('TextInput').find(node => ['numeric', 'number-pad'].includes(node.props.keyboardType));
    assert.ok(dni);
    await renderer.act(async () => {dni.props.onChangeText('30123456');});
    await ui.press(sexo, 'Pressable');
    await ui.press('SIGUIENTE');
  };
  return {...ui, alerts, calls, identify};
}

test('P5: DNI duplicado bloquea con el Alert de siempre y no consulta', async () => {
  const ui = await mountDetail({duplicado: {bloquear: true, avisar: false, estado: 'ENVIADO'}});
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    assert.ok(ui.alerts.some(args => args[0] === 'DNI ya relevado'));
    assert.equal(ui.calls.consultar, 0);
  } finally {await ui.close();}
});

test('P5: DNI con caso rechazado o de baja avisa sin bloquear y deja seguir', async () => {
  for (const [estado, palabra] of [['RECHAZADO', 'rechazado'], ['BAJA', 'dado de baja']]) {
    const ui = await mountDetail({duplicado: {bloquear: false, avisar: true, estado}});
    try {
      await ui.press('AGREGAR PERSONA'); await ui.identify();
      const aviso = ui.alerts.find(value => value && value.type === 'warning');
      assert.ok(aviso);
      assert.equal(aviso.message, 'Este DNI tiene un caso ' + palabra + ' en este relevamiento. Podés seguir; el back lo marca para revisión.');
      assert.equal(ui.alerts.some(args => args[0] === 'DNI ya relevado'), false);
      assert.equal(ui.calls.consultar, 1);
      assert.ok(ui.labels().includes('Datos del caso'));
    } finally {await ui.close();}
  }
});

test('P6: Reabrir solo con FINALIZADO y fecha_hasta futura', async () => {
  const visible = async detail => {
    const ui = await mountDetail({detail});
    try {return ui.labels().includes('REABRIR RELEVAMIENTO');} finally {await ui.close();}
  };
  assert.equal(await visible({estado: 'FINALIZADO', fecha_hasta: '2099-12-31T23:59:59-03:00'}), true);
  assert.equal(await visible({estado: 'FINALIZADO', fecha_hasta: '2021-01-01T00:00:00-03:00'}), false);
  assert.equal(await visible({estado: 'FINALIZANDO', fecha_hasta: '2099-12-31T23:59:59-03:00'}), false);
  assert.equal(await visible({estado: 'EN_REVISION', fecha_hasta: '2099-12-31T23:59:59-03:00'}), false);
});

test('P6: puedeReabrir usa la hora corregida que recibe', async () => {
  const {definition} = await setup();
  const detail = {estado: 'FINALIZADO', fecha_hasta: '2026-10-22T12:00:00Z'};
  assert.equal(definition.puedeReabrir(detail, new Date('2026-10-22T11:00:00Z')), true);
  assert.equal(definition.puedeReabrir(detail, new Date('2026-10-22T13:00:00Z')), false);
  assert.equal(definition.puedeReabrir({estado: 'FINALIZADO'}, new Date()), false);
});

test('P7: con sexo X no se consulta la base y pasa a carga manual con aviso', async () => {
  const ui = await mountDetail();
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify('X');
    assert.equal(ui.calls.consultar, 0);
    assert.ok(ui.labels().includes('Datos del caso'));
    assert.ok(ui.alerts.some(value => value && value.message === 'Con sexo X no se consulta la base. Completá los datos a mano; la carga queda pendiente de validación.'));
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.equal(ui.calls.saved.datos_identificacion.sexo, 'X');
    assert.equal(ui.calls.saved.datos_identificacion.origen, 'manual');
    assert.equal(ui.calls.saved.validado_renaper, false);
  } finally {await ui.close();}
});

test('P7: el titular ofrece F, M y X', async () => {
  const ui = await mountDetail();
  try {
    await ui.press('AGREGAR PERSONA');
    const opciones = ui.tree.root.findAllByType('Pressable').map(node => node.findAllByType('Text').map(text).join('')).filter(label => ['F', 'M', 'X'].includes(label));
    assert.deepEqual(opciones, ['F', 'M', 'X']);
  } finally {await ui.close();}
});

test('P8: requiere_gps sin ubicación avisa y guarda igual', async () => {
  const ui = await mountDetail({definition: {requiere_gps: true}});
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.ok(ui.calls.saved);
    assert.ok(ui.alerts.some(value => value && value.message === 'Este relevamiento pide ubicación y no se pudo obtener. La carga se guarda igual y queda observada.'));
  } finally {await ui.close();}
});

test('P8: sin requiere_gps no hay aviso de ubicación', async () => {
  const ui = await mountDetail();
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.equal(ui.alerts.some(value => value && /ubicación/.test(value.message || '')), false);
  } finally {await ui.close();}
});

test('P9: items vacío o ausente usa el camino legacy', async () => {
  const {definition} = await setup();
  assert.equal(definition.usaConstructor({items: []}), false);
  assert.equal(definition.usaConstructor({globales: [], requisitos: []}), false);
  assert.equal(definition.usaConstructor(null), false);
  assert.equal(definition.usaConstructor({items: [{tipo: 'grupo'}]}), true);
  // En pantalla: con items vacío no aparece ningún grupo del constructor.
  const ui = await mountDetail({items: []});
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    assert.equal(ui.labels().includes('Datos del caso'), false);
  } finally {await ui.close();}
});

test('P13: cupo con y sin claves del back', async () => {
  const {definition} = await setup();
  const cupo = definition.cupoCompleto;
  assert.equal(cupo({cupo_maximo: 5, cupo_completo: true, cupo_disponible: 3}, 0, 0), true);
  assert.equal(cupo({cupo_maximo: 5, cupo_completo: false, cupo_disponible: 1}, 0, 0), false);
  assert.equal(cupo({cupo_maximo: 5, cupo_completo: false, cupo_disponible: 1}, 0, 1), true);
  // Disponible 0 sin cupo_completo:true no es confiable (detalle de la versión anterior): cálculo viejo.
  assert.equal(cupo({cupo_maximo: 5, cupo_completo: null, cupo_disponible: 0}, 0, 0), false);
  assert.equal(cupo({cupo_maximo: 5, cupo_completo: null, cupo_disponible: 0}, 5, 0), true);
  // Back viejo: cuenta local contra el máximo.
  assert.equal(cupo({cupo_maximo: 2, cupo_completo: null, cupo_disponible: null}, 2, 0), true);
  assert.equal(cupo({cupo_maximo: 2, cupo_completo: null, cupo_disponible: null}, 1, 0), false);
  assert.equal(cupo({cupo_maximo: 0, cupo_completo: null, cupo_disponible: null}, 9, 0), false);
});

test('P13: la pantalla bloquea cargas con cupo_disponible menos las sin enviar', async () => {
  const aviso = 'Se alcanzó el máximo de 5 personas. No se pueden iniciar nuevas cargas.';
  const con = async options => {
    const ui = await mountDetail(options);
    try {return {aviso: ui.labels().includes(aviso), agregar: ui.labels().includes('AGREGAR PERSONA')};} finally {await ui.close();}
  };
  assert.deepEqual(await con({detail: {cupo_maximo: 5, cupo_disponible: 1, cupo_completo: false}, sinEnviar: 1}), {aviso: true, agregar: false});
  assert.deepEqual(await con({detail: {cupo_maximo: 5, cupo_disponible: 2, cupo_completo: false}, sinEnviar: 1}), {aviso: false, agregar: true});
  assert.deepEqual(await con({detail: {cupo_maximo: 5}, records: Array.from({length: 5}, (_, id) => ({id: id + 1, estado: 'ENVIADO'}))}), {aviso: true, agregar: false});
});

test('P13: el payload guardado lleva _cupo_disponible y _cupo_completo', async () => {
  const ui = await mountDetail({detail: {cupo_maximo: 5, cupo_disponible: 4, cupo_completo: false}});
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.equal(ui.calls.saved._cupo_disponible, 4);
    assert.equal(ui.calls.saved._cupo_completo, false);
    assert.equal(ui.calls.saved._cupo_maximo, 5);
  } finally {await ui.close();}
});

test('P14: descartadas se listan colapsadas y se restauran', async () => {
  const discarded = [{local_id: 'op-1', last_error: 'Descartado', payload: {datos_identificacion: {dni: '111', apellido: 'Perez', nombre: 'Ana'}}}];
  const ui = await mountDetail({discarded});
  try {
    assert.ok(ui.labels().includes('Descartadas (1)'));
    assert.equal(ui.button('Restaurar'), undefined);
    await ui.press('Descartadas (1)');
    assert.ok(ui.labels().includes('Perez Ana'));
    await renderer.act(async () => ui.button('Restaurar').props.onPress());
    assert.deepEqual(ui.calls.restored, ['op-1']);
    assert.ok(ui.alerts.some(value => value && value.type === 'success'));
  } finally {await ui.close();}
});

test('P1: Volver a adjuntar solo para adjuntos REJECTED y reemplaza con el asset elegido', async () => {
  const failed = [{local_id: 'op-2', last_error: 'Adjuntos rechazados', last_error_code: 'ADJUNTOS_RECHAZADOS',
    payload: {datos_identificacion: {dni: '222'}, attachment_results: {
      'pg-foto': {status: 'REJECTED', code: 'x', message: 'Formato no permitido'},
      'pg-viejo': {status: 'DISCARDED', code: 'y', message: 'Descartado'}}}}];
  const asset = {uri: 'file:///cache/nuevo.pdf', name: 'nuevo.pdf', mimeType: 'application/pdf', size: 1234};
  const ui = await mountDetail({failed, getDocumentAsync: async () => ({canceled: false, assets: [asset]})});
  try {
    const botones = ui.tree.root.findAllByType('CustomButton').filter(node => node.props.title === 'Volver a adjuntar');
    assert.equal(botones.length, 1);
    assert.ok(ui.labels().includes('Adjunto rechazado: Formato no permitido'));
    // El selector real se abre con un Alert: se elige «Archivo» y se simula el asset.
    await renderer.act(async () => botones[0].props.onPress());
    const opciones = ui.alerts.find(args => Array.isArray(args) && args[0] === 'Volver a adjuntar')[2];
    assert.equal(opciones.map(o => o.text).join(','), 'Cámara,Galería,Archivo,Cancelar');
    await renderer.act(async () => { await opciones.find(o => o.text === 'Archivo').onPress(); });
    assert.equal(ui.calls.replaced.length, 1);
    const [localId, key, enviado] = ui.calls.replaced[0];
    assert.equal(localId, 'op-2'); assert.equal(key, 'pg-foto');
    assert.equal(enviado.uri, asset.uri); assert.equal(enviado.fileName, 'nuevo.pdf');
  } finally {await ui.close();}
});

test('P12: la lista lee localidad con respaldo subsegmento y EN_REVISION tiene su filtro', async () => {
  const recordsSets = [
    {id: 1, titulo: 'Uno', estado: 'EN_CURSO', localidad: 'Resistencia', fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-12-31T23:59:59-03:00'},
    {id: 2, titulo: 'Dos', estado: 'EN_REVISION', subsegmento: 'Barrio Norte', fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2021-01-01T00:00:00-03:00'},
    {id: 3, titulo: 'Tres', estado: 'EN_CURSO', segmento: 'Segmento 4', localidad: 'Fontana', zona: 'Zona Sur', fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-12-31T23:59:59-03:00'},
  ];
  const runtime = await setup();
  const Screen = loadScreen('src/screens/RelevamientosScreen.js', {
    react: React, 'react-native': native, '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '../theme/statusBadges': loadPure('src/theme/statusBadges.js'),
    '../context/ThemeContext': {useTheme: () => ({theme, typography})},
    '../components/StaggeredItem': {__esModule: true, default: ({children}) => children},
    '../hooks/useAssignmentClock': {__esModule: true, default: () => new Date()},
    '../services/relevamientoService': {__esModule: true, default: {getRelevamientos: async () => ({success: true, records: recordsSets})}},
    '../theme': loadTokens(), '../utils/dates': runtime.dates,
  });
  const ui = await render(Screen, {onOpenRelevamiento() {}});
  try {
    const all = ui.labels();
    assert.ok(all.includes('Resistencia'));
    assert.ok(all.includes('Barrio Norte'));
    // Con segmento y localidad se ven los dos; antes el segmento tapaba la localidad.
    assert.ok(all.includes('Segmento 4 · Fontana'));
    assert.ok(all.includes('En revisión'));
    await ui.press('En revisión', 'Pressable');
    const filtered = ui.labels().join('|');
    assert.match(filtered, /Dos/);
    assert.doesNotMatch(filtered, /Uno/);
  } finally {await ui.close();}
});

function loadPure(relative) {
  const filename = path.join(root, relative);
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs']});
  const module = {exports: {}};
  vm.runInNewContext('(function(module,exports){' + code + '\n})', {})(module, module.exports);
  return module.exports;
}

test('P15: bloqueo por versión mínima, con y sin dato', async () => {
  const {evaluarBloqueoVersion} = loadPure('src/navigation/bloqueoVersion.js');
  const user = {version_minima: '2.0.0'};
  const bloqueado = await evaluarBloqueoVersion({requiereActualizacionGuardada: async () => true, versionActual: () => '1.1.0', getStoredUser: async () => user});
  assert.equal(JSON.stringify(bloqueado), JSON.stringify({minima: '2.0.0', actual: '1.1.0'}));
  assert.equal(await evaluarBloqueoVersion({requiereActualizacionGuardada: async () => false, versionActual: () => '1.1.0', getStoredUser: async () => user}), null);
  assert.equal(await evaluarBloqueoVersion({requiereActualizacionGuardada: async () => { throw new Error('x'); }, versionActual: () => '1.1.0'}), null);
});

test('P15: con la versión real, 1.1.0 contra mínima 1.2.0 bloquea y 1.0.0 no', async () => {
  const runtime = await setup();
  const version = runtime.load('./versionApp');
  assert.equal(version.requiereActualizacion('1.2.0'), true);
  assert.equal(version.requiereActualizacion('1.0.0'), false);
  assert.equal(version.requiereActualizacion(null), false);
});

test('P15 web: actualizar hace update del service worker y recarga; sin red no recarga', async () => {
  const {actualizarPWA} = loadPure('src/navigation/bloqueoVersion.js');
  const eventos = [];
  const nav = {onLine: true, serviceWorker: {getRegistration: async () => ({update: async () => eventos.push('update')})}};
  const loc = {reload: () => eventos.push('reload')};
  assert.equal(await actualizarPWA({nav, loc}), 'recargado');
  assert.deepEqual(eventos, ['update', 'reload']);

  const sinRed = [];
  const fallido = {onLine: true, serviceWorker: {getRegistration: async () => ({update: async () => { throw new TypeError('Failed to fetch'); }})}};
  assert.equal(await actualizarPWA({nav: fallido, loc: {reload: () => sinRed.push('reload')}}), 'sin_conexion');
  assert.deepEqual(sinRed, []);

  assert.equal(await actualizarPWA({nav: {...nav, onLine: false}, loc: {reload: () => sinRed.push('reload')}}), 'sin_conexion');
  assert.deepEqual(sinRed, []);
  // Sin service worker registrado igual recarga (con red el reload ya trae el bundle nuevo).
  assert.equal(await actualizarPWA({nav: {onLine: true}, loc: {reload: () => sinRed.push('reload')}}), 'recargado');
});
