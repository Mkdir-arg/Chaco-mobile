const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { transformSync } = require('@babel/core');

async function setup(platform = 'android') {
  const values = new Map([['becas_auth_token', 'old-token'], ['user_data', JSON.stringify({id: 7})]]);
  const storage = {
    getItem: async key => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async key => values.delete(key),
  };
  const sql = new DatabaseSync(':memory:');
  const db = {
    execAsync: async query => sql.exec(query),
    runAsync: async (query, ...args) => sql.prepare(query).run(...args),
    getAllAsync: async (query, ...args) => sql.prepare(query).all(...args),
    getFirstAsync: async (query, ...args) => sql.prepare(query).get(...args),
    withTransactionAsync: async task => { sql.exec('BEGIN'); try { await task(); sql.exec('COMMIT'); } catch (e) {sql.exec('ROLLBACK'); throw e;} },
  };
  let online = true;
  let fetchHandler = async () => response(401, {detail: 'Invalid token.'});
  let locationHandler = async () => ({coords: {latitude: -27.45, longitude: -58.98}});
  let currentTime = null;
  let appVersion = '1.1.0';
  let fileInfoHandler = async () => ({exists: true, size: 100});
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : currentTime == null ? [] : [currentTime])); }
    static now() { return currentTime == null ? Date.now() : currentTime; }
  }
  const context = vm.createContext({
    Date: ClockDate,
    console: { log() {}, warn() {} }, setTimeout, clearTimeout,
    // En web, igual que el navegador bajo la CSP de ECOM (`connect-src` sin blob: ni
    // data:): un fetch a una URL local se rechaza. Antes este mock la aceptaba y los
    // tests pasaban mientras cada adjunto real moria en el navegador.
    fetch: (...args) => !/^(file:|blob:|data:)/.test(String(args[0])) ? fetchHandler(...args)
      : platform === 'web' ? Promise.reject(new TypeError('Refused to connect: violates Content Security Policy'))
      : Promise.resolve({ok: true, blob: async () => new Blob(['image'], {type: 'image/jpeg'})}),
    atob, btoa, Blob, FormData: class {constructor() {this.fields = [];} append(...args) {this.fields.push(args);}},
  });
  const mocks = {
    '@react-native-async-storage/async-storage': {default: storage},
    'expo-secure-store': {getItemAsync: storage.getItem, setItemAsync: storage.setItem, deleteItemAsync: storage.removeItem},
    'react-native': {Platform: {OS: platform}},
    '../config/apiConfig': {API_CONFIG: {djangoBaseUrl: 'https://example.test'}},
    '@react-native-community/netinfo': {default: {fetch: async () => ({isConnected: online, isInternetReachable: online})}},
    'expo-file-system/legacy': {documentDirectory: 'file:///test/', getInfoAsync: (...args) => fileInfoHandler(...args), copyAsync: async () => {}, makeDirectoryAsync: async () => {}, EncodingType: {Base64: 'base64'}, readAsStringAsync: async () => 'aW1hZ2U='},
    'expo-sqlite': {openDatabaseAsync: async () => db},
    'expo-location': {getCurrentPositionAsync: (...args) => locationHandler(...args)},
    'expo-crypto': {randomUUID: () => require('node:crypto').randomUUID()},
    'expo-constants': {default: {get expoConfig() { return {version: appVersion}; }}},
  };
  const modules = new Map();
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    const file = `${name.replace(/^\.\//, '')}.js`;
    const filename = path.join(__dirname, '../../src/services', file);
    const {code} = transformSync(fs.readFileSync(filename, 'utf8'), {
      filename, babelrc: false, configFile: false,
      plugins: ['@babel/plugin-transform-modules-commonjs'],
    });
    const module = {exports: {}};
    modules.set(name, module.exports);
    const requireMock = specifier => {
      if (specifier.startsWith('./') || specifier.startsWith('../utils/')) return load(specifier);
      assert.ok(mocks[specifier], `Missing mock ${specifier}`);
      return {__esModule: true, ...mocks[specifier]};
    };
    const execute = vm.runInContext(`(function(require, module, exports) {${code}\n})`, context, {filename});
    execute(requireMock, module, module.exports);
    return module.exports;
  }
  const api = load('./becasApi');
  const service = load('./relevamientoService').default;
  await service.getPendingCount();
  const campaign = {id: 1, backend: 'django_becas', source: 'asignado', _owner_user_id: '7',
    fecha_asignada: '2020-01-01T00:00:00-03:00', fecha_hasta: '2099-12-31T23:59:59-03:00',
    estado: 'EN_CURSO', definicion_formulario: {version: 3, globales: [], requisitos: []}};
  sql.prepare(`INSERT INTO local_relevamientos (local_id,remote_id,created_at,updated_at,payload_json,synced)
    VALUES ('remote_django_becas_1','1','now','now',?,1)`).run(JSON.stringify(campaign));
  const setPeriod = (start, end) => sql.prepare("UPDATE local_relevamientos SET payload_json=? WHERE local_id='remote_django_becas_1'")
    .run(JSON.stringify({...campaign, fecha_asignada: start, fecha_hasta: end}));
  return {definition: load('./definicionFormulario'), attachments: load('./webAttachments'), images: load('./webImages'), location: load('./ubicacion'), conditions: load('./condiciones'), identity: load('./identityLookup'), api, service, dates: load('../utils/dates'), values, sql, setPeriod,
    setNow: value => {currentTime = new Date(value).getTime();}, setOnline: value => {online = value;}, setFetch: handler => {fetchHandler = handler;}, setLocation: handler => {locationHandler = handler;},
    setAppVersion: value => {appVersion = value;}, setFileInfo: handler => {fileInfoHandler = handler;}, load};
}
// `headers` permite simular `Date` o `Retry-After`; sin él solo responde content-type,
// como antes (cualquier otro header devuelve null, igual que fetch).
function response(status, payload, headers = {}) {
  const all = Object.fromEntries(Object.entries({'content-type': 'application/json', ...headers}).map(([k, v]) => [k.toLowerCase(), v]));
  return {status, ok: status >= 200 && status < 300, headers: {get: name => all[String(name).toLowerCase()] ?? null}, text: async () => JSON.stringify(payload)};
}

module.exports = {setup, response};
