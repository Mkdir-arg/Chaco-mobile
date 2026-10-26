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

const field = (clave, texto, extra = {}) => ({tipo_item: 'campo', clave, texto, tipo: 'STRING', origen: 'pregunta', ...extra});
const group = (clave, titulo, items, extra = {}) => ({tipo: 'grupo', clave, titulo, items, ...extra});

async function mount(items, options = {}) {
  const runtime = await setup();
  let definition = {items, version: 3, acepta_respuestas: true};
  let submitted;
  const alerts = [];
  const detail = () => ({id: 1, estado: 'EN_CURSO', source: 'asignado', backend: 'django_becas',
    nombre: 'QA', fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-12-31T23:59:59-03:00',
    definicion_formulario: definition, campos_definicion: runtime.definition.camposDelDiseno(definition)});
  const service = {
    getRelevamientoDetail: async () => ({success: true, detail: detail()}),
    getBecasFormularios: async () => ({records: []}), getFailedOperations: async () => options.failedOperation ? [options.failedOperation] : [], dniYaRelevado: async () => false,
    correctFailedFormulario: async (id, payload) => {assert.equal(id, options.failedOperation.local_id); submitted = payload; return {success: true, syncResult: {synced: 1}};},
    saveBecasFormulario: async payload => {submitted = payload; return {success: true, syncResult: {synced: 1}};},
  };
  const native = Object.fromEntries(['View','Text','ScrollView','TouchableOpacity','ActivityIndicator','Image','Pressable',
    'Modal','TextInput','KeyboardAvoidingView','FlatList'].map(name => [name, name]));
  Object.assign(native, {Platform: {OS: 'web'}, StyleSheet: {create: value => value, absoluteFillObject: {}}, Alert: {alert() {}}});
  const theme = {colors: new Proxy({}, {get: () => '#5059BC'})};
  const mocks = {
    react: React, 'react-native': native,
    '../components/FormInput': {__esModule:true, default:native.TextInput, FormInputContainer:native.View},
    '../services/definicionFormulario': runtime.definition,
    '../services/identityLookup': {...runtime.identity, consultarIdentidad: async () => {if (options.identityError) throw options.identityError; return {origen: 'padron', success: true,
      data: {dni: '30123456', sexo: 'F', nombre: 'Ana', apellido: 'Prueba', fecha_nacimiento: '1991-03-14'}};}},
    '../services/relevamientoService': {__esModule: true, default: service, validateFormularioAttachment: async () => {}},
    '../services/becasApi': {becasRequest: async () => ({})},
    '../theme/statusBadges': {relevamientoBadge: state => ({label: state}), casoBadge: state => ({label: state})},
    '../context/ThemeContext': {useTheme: () => ({theme, typography: {bold: 'Manrope', medium: 'Manrope', semibold: 'Manrope', regular: 'Manrope'}})},
    '../context/ToastContext': {useToast: () => ({showToast: value => alerts.push(value), showAlert: (...args) => alerts.push(args)})},
    '../hooks/useAssignmentClock': {__esModule: true, default: () => new Date()},
    '../utils/dates': runtime.dates,
    '../utils/teclado': {keyboardDismissModeFor: () => 'on-drag'},
    '@expo/vector-icons': {Ionicons: 'Ionicons'},
    '@react-native-community/netinfo': {__esModule: true, default: {fetch: async () => ({isConnected: true, isInternetReachable: true})}},
    '@react-native-community/datetimepicker': {__esModule: true, default: 'DateTimePicker', DateTimePickerAndroid: {open() {}}},
    '../hooks/useCameraPermissions': {__esModule:true, default: () => [{granted: true}, async () => ({granted: true})]},
    'expo-media-library': {}, '../services/imagePicker': {}, 'expo-constants': {},
    '@react-native-async-storage/async-storage': {__esModule: true, default: {getItem: async () => null}},
    '../services/reloj': {ahoraCorregido: () => new Date()}, '../services/documentPicker': {}, '../services/ubicacion': {posicionActual: async () => { throw new Error('sin GPS en tests'); }},
    'expo-location': {getForegroundPermissionsAsync: async () => ({status: 'denied'}), requestForegroundPermissionsAsync: async () => ({status: 'denied'})},
    'react-native-safe-area-context': {useSafeAreaInsets: () => ({top: 0, bottom: 0})},
    'react-native-svg': {__esModule: true, default: 'Svg', Path: 'Path'},
    'expo-file-system/legacy': {documentDirectory: 'file:///test/'}, 'expo-sharing': {}, 'expo-web-browser': {},
  };
  for (const name of ['Banner','CameraModal','CustomButton','AuthVisualBackground','WebDateInput']) mocks['../components/' + name] = {__esModule: true, default: name};
  const root = path.join(__dirname, '..');
  const tokenExports = {};
  const tokenCode = transformSync(fs.readFileSync(path.join(root, 'src/theme/tokens.js'), 'utf8'), {
    babelrc: false, configFile: false, plugins: ['@babel/plugin-transform-modules-commonjs'],
  }).code;
  vm.runInNewContext(tokenCode, {exports: tokenExports});
  mocks['../theme'] = tokenExports;
  const filename = path.join(root, 'src/screens/RelevamientoDetailScreen.js');
  const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
    filename, babelrc: false, configFile: false,
    plugins: ['@babel/plugin-transform-react-jsx', '@babel/plugin-transform-modules-commonjs'],
  });
  const module = {exports: {}};
  const context = vm.createContext({console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {},
    requestAnimationFrame: () => 0, cancelAnimationFrame() {}});
  vm.runInContext('(function(require,module,exports){' + code + '\n})', context)((name) => {
    assert.ok(mocks[name], 'Missing screen mock: ' + name); return mocks[name];
  }, module, module.exports);
  let tree;
  await renderer.act(async () => {tree = renderer.create(React.createElement(module.exports.default, {relevamientoId: 1, onClose() {}}));});
  const text = node => node.children.map(value => typeof value === 'string' ? value : typeof value === 'number' ? String(value) : text(value)).join('');
  const labels = () => tree.root.findAllByType('Text').map(text);
  const press = async (label, type = 'TouchableOpacity') => {
    const button = tree.root.findAllByType(type).find(node => node.findAllByType('Text').some(child => text(child) === label));
    assert.ok(button, 'Missing button ' + label);
    await renderer.act(async () => {await button.props.onPress();});
  };
  const identify = async () => {
    const dni = tree.root.findAllByType('TextInput').find(node => ['numeric', 'number-pad'].includes(node.props.keyboardType));
    assert.ok(dni);
    await renderer.act(async () => {dni.props.onChangeText('30123456');});
    await press('F', 'Pressable');
    await press('SIGUIENTE');
  };
  return {tree, labels, press, identify, alerts, submitted: () => submitted,
    replaceDefinition: next => {definition = next;}, close: async () => renderer.act(async () => tree.unmount())};
}

test('screen refreshes the design for a new case and renders reordered groups and questions', async () => {
  const first = group('g-first', 'Grupo primero', [field('pg-1', 'Pregunta primera', {orden: 99}), field('rn-2', 'Pregunta segunda', {orden: 0})]);
  const second = group('g-second', 'Grupo segundo', [field('cp-extra', 'Campo propio')]);
  const ui = await mount([first, second]);
  try {
    ui.replaceDefinition({version: 4, acepta_respuestas: true, items: [second, {...first, items: [...first.items].reverse()}]});
    await ui.press('AGREGAR PERSONA');
    const labels = ui.labels();
    assert.ok(labels.indexOf('Grupo segundo') < labels.indexOf('Grupo primero'));
    await ui.identify();
    assert.ok(ui.labels().includes('Campo propio'));
    await ui.press('SIGUIENTE');
    const fields = ui.labels();
    assert.ok(fields.indexOf('Pregunta segunda') < fields.indexOf('Pregunta primera'));
    assert.equal(fields.includes('Preguntas globales'), false);
  } finally {await ui.close();}
});

test('screen evaluates live conditions and sends only visible answers on confirmation', async () => {
  const ui = await mount([group('g-data', 'Datos', [field('pg-1', 'Nivel', {tipo: 'SELECTOR', opciones: ['Sí','No']}),
    field('cp-hidden', 'Detalle condicional', {obligatorio: true, condicion: {reglas: [{fuente: 'pg-1', op: 'es', valor: 'Sí'}]}})])]);
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    assert.equal(ui.labels().includes('Detalle condicional *'), false);
    await ui.press('Sí', 'Pressable');
    assert.equal(ui.labels().includes('Detalle condicional *'), true);
    await ui.press('SIGUIENTE');
    assert.ok(ui.alerts.some(args => args[0] === 'Revisá los datos'));
    await ui.press('No', 'Pressable');
    assert.equal(ui.labels().includes('Detalle condicional *'), false);
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.ok(ui.submitted());
    assert.equal(ui.submitted().respuestas['pg-1'], 'No');
    assert.equal(Object.hasOwn(ui.submitted().respuestas, 'cp-hidden'), false);
    assert.equal(ui.submitted().version_capturada, 3);
  } finally {await ui.close();}
});


test('verified identity is read-only while linked contact remains editable', async () => {
  const ui = await mount([group('g-datos', 'Datos personales', [
    field('pg-1', 'Nombre acreditado', {origen: 'legajo', vinculo: 'nombre'}),
    field('pg-2', 'Correo de contacto', {origen: 'legajo', vinculo: 'email'})])]);
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    assert.ok(ui.labels().includes('Ana'));
    const inputs = ui.tree.root.findAllByType('TextInput');
    assert.equal(inputs.some(node => node.props.value === 'Ana'), false);
    const contact = inputs.find(node => node.props.accessibilityLabel === 'Correo de contacto');
    assert.ok(contact);
    await renderer.act(async () => contact.props.onChangeText('qa@example.com'));
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.equal(ui.submitted().respuestas['pg-1'], 'Ana');
    assert.equal(ui.submitted().respuestas['pg-2'], 'qa@example.com');
  } finally {await ui.close();}
});

test('deceased identity still blocks constructor navigation and submission', async () => {
  const error = Object.assign(new Error('Fallecido'), {status: 404, payload: {fallecido: true}});
  const ui = await mount([group('g-datos', 'Datos', [field('pg-1', 'Pregunta')])], {identityError: error});
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    assert.ok(ui.labels().includes('La persona figura como fallecida en la Base de Personas'));
    const groupButton = ui.tree.root.findAllByType('TouchableOpacity').find(node =>
      node.findAllByType('Text').some(child => child.children.includes('Datos')));
    assert.equal(groupButton.props.disabled, true);
    assert.equal(ui.submitted(), undefined);
  } finally {await ui.close();}
});


test('integer fields explain the type, show inline errors and block continuing until corrected', async () => {
  const ui = await mount([group('g-numeros', 'Datos', [field('cp-num', 'Cantidad', {tipo: 'INT'})])]);
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    const input = () => ui.tree.root.findAllByType('TextInput').find(n => n.props.placeholder === 'Ej.: 12');
    assert.ok(input());
    assert.equal(input().props.inputMode, 'numeric');
    assert.ok(ui.labels().includes('Número entero, sin letras ni decimales.'));
    await renderer.act(async () => input().props.onChangeText('12abc'));
    assert.equal(input().props['aria-invalid'], true);
    assert.ok(ui.labels().includes('Ingresá un número entero, sin letras ni decimales.'));
    await ui.press('SIGUIENTE');
    assert.ok(ui.alerts.some(args => args[0] === 'Revisá los datos' && args[1].includes('Cantidad: Ingresá un número entero')));
    await renderer.act(async () => input().props.onChangeText('0'));
    assert.equal(input().props['aria-invalid'], false);
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.equal(ui.submitted().respuestas['cp-num'], '0');
  } finally { await ui.close(); }
});


test('correction opens rejected email step and preserves captured identity and other answers', async () => {
  const items = [group('g-persona', 'Persona', [
    field('cp-nombre', 'Nombre', {origen: 'legajo', vinculo: 'nombre'}),
    field('cp-apellido', 'Apellido', {origen: 'legajo', vinculo: 'apellido'}),
  ]), group('g-contacto', 'Contacto', [
    field('cp-email', 'Correo', {origen: 'legajo', vinculo: 'email'}),
    field('cp-otro', 'Otra respuesta'),
  ])];
  const operation = {local_id: 'original-local-id', last_error_code: 'ALTA_INVALIDA',
    last_error: 'email_contacto: Introduzca una dirección de correo electrónico válida.',
    payload: {definicion_formulario: {items, version: 3, acepta_respuestas: true},
      datos_identificacion: {dni: '24459124', sexo: 'F', origen: 'manual'},
      respuestas: {'cp-nombre': 'Ana', 'cp-apellido': 'Prueba', 'cp-email': 'mal', 'cp-otro': 'Respuesta guardada'},
      email_contacto: 'mal', capturado_en: '2026-10-20T15:00:00Z'}};
  const ui = await mount(items, {failedOperation: operation});
  try {
    const correct = ui.tree.root.findAllByType('CustomButton').find(n => n.props.title === 'Corregir');
    assert.ok(correct);
    await renderer.act(async () => correct.props.onPress());
    assert.equal(ui.labels().includes('Identificacion'), false);
    const email = () => ui.tree.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'Correo');
    assert.equal(email().props.value, 'mal');
    assert.equal(email().props.inputMode, 'email');
    assert.equal(email().props.autoCapitalize, 'none');
    assert.ok(ui.labels().some(t => t.includes('Ingresá un correo electrónico válido')));
    await ui.press('SIGUIENTE');
    assert.ok(ui.alerts.some(args => args[1].includes('Correo: Ingresá un correo electrónico válido')));
    await renderer.act(async () => email().props.onChangeText('qa@example.com'));
    assert.equal(email().props['aria-invalid'], false);
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    const payload = ui.submitted();
    assert.ok(payload);
    assert.equal(payload.datos_identificacion.nombre, 'Ana');
    assert.equal(payload.datos_identificacion.apellido, 'Prueba');
    assert.equal(payload.datos_identificacion.dni, '24459124');
    assert.equal(payload.respuestas['cp-otro'], 'Respuesta guardada');
    assert.equal(payload.email_contacto, 'qa@example.com');
    assert.equal(payload.capturado_en, operation.payload.capturado_en);
  } finally { await ui.close(); }
});


test('DNI del apoderado: input numérico de 8 caracteres, error inline y bloqueo hasta corregir', async () => {
  const ui = await mount([group('g-apoderado', 'Apoderado', [field('pg-9', 'DNI del apoderado', {origen: 'persona_vinculada', vinculo: 'dni'})])]);
  try {
    await ui.press('AGREGAR PERSONA'); await ui.identify();
    const input = () => ui.tree.root.findAllByType('TextInput').find(n => n.props.accessibilityLabel === 'DNI del apoderado');
    assert.equal(input().props.maxLength, 8);
    assert.equal(input().props.inputMode, 'numeric');
    await renderer.act(async () => input().props.onChangeText('343.333.333'));
    assert.equal(input().props.value, '34333333');
    await renderer.act(async () => input().props.onChangeText('343333333'));
    assert.equal(input().props.value, '34333333');
    await renderer.act(async () => input().props.onChangeText('3433'));
    assert.ok(ui.labels().includes('Ingresá un DNI válido de 7 u 8 dígitos.'));
    await ui.press('SIGUIENTE');
    assert.ok(ui.alerts.some(args => args[0] === 'Revisá los datos' && args[1].includes('DNI del apoderado: Ingresá un DNI válido')));
    await renderer.act(async () => input().props.onChangeText('34.333.333'));
    await ui.press('SIGUIENTE'); await ui.press('CONFIRMAR CASO');
    assert.equal(ui.submitted().apoderado_dni, '34333333');
    assert.equal(ui.submitted().respuestas['pg-9'], '34333333');
  } finally { await ui.close(); }
});

test('la tarjeta de envíos fallidos muestra cuándo fue el último intento', async () => {
  const items = [group('g', 'G', [field('cp-1', 'Algo')])];
  const operation = {local_id: 'x', last_error_code: 'ALTA_INVALIDA', last_error: 'apoderado_dni: DNI inválido',
    updated_at: '2026-10-22T21:05:00Z', payload: {definicion_formulario: {items, version: 3, acepta_respuestas: true}}};
  const ui = await mount(items, {failedOperation: operation});
  try {
    assert.ok(ui.labels().some(t => t.startsWith('Último intento: ') && /2026|22/.test(t)), ui.labels().join('|'));
  } finally { await ui.close(); }
});
