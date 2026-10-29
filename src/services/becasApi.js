import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_CONFIG } from '../config/apiConfig';
import { apiErrorMessage } from './formularioSync';
import { normalizarModulos } from './modulos';
import { readWebBlob } from './webAttachments';
import { ahoraCorregido, registrarHoraServidor } from './reloj';

// En el navegador no mandamos cookies. Si el usuario tiene sesion abierta en el
// backoffice del mismo dominio, el navegador adjunta su `sessionid`, DRF autentica con
// SessionAuthentication y entonces exige CSRF en los POST: la llamada muere con 403
// "CSRF Failed: CSRF token missing" antes de que nadie mire las credenciales. La app
// autentica con Token, asi que las cookies no le aportan nada. En nativo se mantienen
// porque ahi sostienen la sesion de Client Management de FortiWeb.
const CREDENCIALES = Platform.OS === 'web' ? 'omit' : 'include';

const TOKEN_KEY = 'becas_auth_token';
const USER_DATA_KEY = 'user_data';
const USER_ID_KEY = 'user_id';
const MODULO_ACTIVO_KEY = 'modulo_activo';
const sessionExpiredListeners = new Set();
let sessionInvalidation = null;

export const subscribeBecasSessionExpired = (listener) => {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
};

// Una respuesta vieja no debe borrar el token de un login más reciente.
const invalidateRejectedSession = async (token) => {
  if (sessionInvalidation) {
    await sessionInvalidation;
    return;
  }
  sessionInvalidation = (async () => {
    if (await getBecasToken() !== token) return;
    try {
      await clearBecasSession();
    } finally {
      sessionExpiredListeners.forEach((listener) => listener());
    }
  })();
  try {
    await sessionInvalidation;
  } finally {
    sessionInvalidation = null;
  }
};

// En nativo, si SecureStore falla al guardar, el valor queda en AsyncStorage como respaldo
// bajo `respaldo_<clave>`, y se lee de ahí cuando SecureStore no tiene nada (antes solo se
// leía si SecureStore tiraba error, y la sesión se perdía al reiniciar).
// Las versiones anteriores guardaban el respaldo con la clave sin prefijo y el logout no lo
// borraba: puede quedar la sesión vieja de otro relevador. Esa clave solo se lee si SecureStore
// tira error (como antes), para no revivir esa sesión, y se limpia en el próximo login o logout.
const respaldoKey = (key) => `respaldo_${key}`;

const storage = {
  getItem: async (key) => {
    if (Platform.OS === 'web') return AsyncStorage.getItem(key);
    let value;
    try {
      value = await SecureStore.getItemAsync(key);
    } catch {
      return (await AsyncStorage.getItem(respaldoKey(key))) ?? AsyncStorage.getItem(key);
    }
    if (value != null) return value;
    return AsyncStorage.getItem(respaldoKey(key));
  },
  setItem: async (key, value) => {
    if (Platform.OS === 'web') return AsyncStorage.setItem(key, value);
    try {
      await SecureStore.setItemAsync(key, value);
    } catch {
      // Un valor cifrado anterior ganaría en la lectura frente al respaldo nuevo.
      await Promise.allSettled([SecureStore.deleteItemAsync(key)]);
      return AsyncStorage.setItem(respaldoKey(key), value);
    }
    await Promise.allSettled([AsyncStorage.removeItem(respaldoKey(key)), AsyncStorage.removeItem(key)]);
    return undefined;
  },
  deleteItem: async (key) => {
    if (Platform.OS === 'web') return AsyncStorage.removeItem(key);
    await Promise.allSettled([
      SecureStore.deleteItemAsync(key),
      AsyncStorage.removeItem(respaldoKey(key)),
      AsyncStorage.removeItem(key),
    ]);
    return undefined;
  },
};

const buildUrl = (path) => {
  const base = API_CONFIG.djangoBaseUrl.replace(/\/+$/, '');
  const cleanPath = String(path || '').replace(/^\/+/, '');
  return `${base}/${cleanPath}`;
};

const parseResponse = async (response) => {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { detail: text };
  }
};

export const getBecasToken = () => storage.getItem(TOKEN_KEY);

export const getStoredBecasUser = async () => {
  const raw = await storage.getItem(USER_DATA_KEY);
  if (!raw) return null;
  try {
    const user = JSON.parse(raw);
    return user && { ...user, modulos: normalizarModulos(user.modulos) };
  } catch {
    return null;
  }
};

export const getModuloActivo = () => storage.getItem(MODULO_ACTIVO_KEY);

export const setModuloActivo = (modulo) => storage.setItem(MODULO_ACTIVO_KEY, modulo);

// El back dejó de admitir un módulo (403 SIN_MODULO): se saca del usuario guardado y, si era
// el activo, del módulo activo. Devuelve el usuario actualizado, o null si no hay sesión.
export const quitarModuloLocal = async (modulo) => {
  const user = await getStoredBecasUser();
  if (!user) return null;
  const next = { ...user, modulos: user.modulos.filter((item) => item !== modulo) };
  await storage.setItem(USER_DATA_KEY, JSON.stringify(next));
  if (await getModuloActivo() === modulo) await storage.deleteItem(MODULO_ACTIVO_KEY);
  return next;
};

export const clearBecasSession = async () => {
  await Promise.all([
    storage.deleteItem(TOKEN_KEY),
    storage.deleteItem(USER_DATA_KEY),
    storage.deleteItem(USER_ID_KEY),
    storage.deleteItem(MODULO_ACTIVO_KEY),
  ]);
};

const isUnexpectedHtmlResponse = (response, payload) => {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const detail = String(payload?.detail || '').trim().toLowerCase();
  return contentType.includes('text/html') || detail.startsWith('<!doctype html') || detail.startsWith('<html');
};

// `Retry-After` llega en segundos o como fecha HTTP. Se devuelve en milisegundos desde
// ahora (hora corregida), o null si falta o no se entiende.
const parseRetryAfter = (response) => {
  const raw = String(response?.headers?.get?.('Retry-After') || '').trim();
  if (!raw) return null;
  const ms = /^\d+$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - ahoraCorregido().getTime();
  return Number.isFinite(ms) ? Math.min(Math.max(ms, 1000), 60 * 60 * 1000) : null;
};

const buildResponseError = (response, payload, fallback) => {
  const unexpectedHtml = isUnexpectedHtmlResponse(response, payload);
  const error = new Error(unexpectedHtml
    ? `El servidor devolvio una pagina HTML inesperada (HTTP ${response.status}).`
    : apiErrorMessage(payload, fallback));
  error.status = response.status;
  error.payload = unexpectedHtml ? null : payload;
  error.unexpectedHtml = unexpectedHtml;
  error.retryAfter = parseRetryAfter(response);
  return error;
};

const initializeWafSession = async () => {
  // Inutil en el navegador: va contra `/` y el CORS del backend solo cubre `/api/`, con
  // lo cual la respuesta se descarta y la cookie nunca llega. Sin cookies, menos todavia.
  if (Platform.OS === 'web') return;
  try {
    const response = await fetch(buildUrl('/'), {
      method: 'GET',
      headers: { Accept: 'text/html,application/json' },
      credentials: CREDENCIALES,
    });
    await response.text();
  } catch {
    // El login posterior conserva el error real si el servidor no es alcanzable.
  }
};

export const loginBecas = async ({ username, password }) => {
  if (sessionInvalidation) await sessionInvalidation;
  // FortiWeb crea cookiesession1 en el primer acceso. Inicializarla antes del
  // POST evita que Client Management trate el login nativo como una sesión nueva.
  await initializeWafSession();
  const response = await fetch(buildUrl('/api/becas/auth/token/'), {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    credentials: CREDENCIALES,
    body: JSON.stringify({ username, password }),
  });
  registrarHoraServidor(response.headers?.get?.('Date'));
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.non_field_errors?.[0] || 'No se pudo iniciar sesion.');
  }

  const modulos = normalizarModulos(payload.modulos);
  if (!modulos.length) {
    const error = new Error('Tu usuario no tiene acceso a ningun modulo de la app.');
    error.code = 'SIN_MODULOS';
    throw error;
  }
  const user = {
    id: payload.user_id,
    username: payload.username,
    nombre: payload.username,
    grupos: [],
    es_admin: false,
    modulos,
    version_minima: payload.app?.version_minima || null,
  };
  await Promise.all([
    storage.setItem(TOKEN_KEY, payload.token),
    storage.setItem(USER_ID_KEY, String(payload.user_id)),
    storage.setItem(USER_DATA_KEY, JSON.stringify(user)),
  ]);
  return user;
};

// Safari/iOS rechaza el fetch con TypeError('Load failed') o «The Internet connection
// appears to be offline.», y un 502/504 sin CORS también llega como TypeError: se marca
// `network` para que la cola lo trate como falla de red y no como rechazo permanente.
const fetchConRedMarcada = async (url, init) => {
  try {
    return await fetch(url, init);
  } catch (e) {
    throw Object.assign(new Error(`Network request failed: ${e?.message || e}`), { network: true, cause: e });
  }
};

// Sube un archivo real (multipart) a un endpoint de la API de Becas — a diferencia
// de becasRequest, no serializa el body a JSON: FormData con {uri, name, type}
// es el formato que espera fetch de React Native para adjuntar un archivo local.
export const becasUploadFile = async (path, { fileUri, fileField = 'archivo', fileName, mimeType = 'image/jpeg', fields = {} } = {}) => {
  const token = await getBecasToken();
  const formData = new FormData();
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== null && value !== undefined) formData.append(key, String(value));
  });
  const name = fileName || 'archivo.jpg';
  if (Platform.OS === 'web') {
    formData.append(fileField, await readWebBlob(fileUri), name);
  } else {
    formData.append(fileField, { uri: fileUri, name, type: mimeType });
  }

  const response = await fetchConRedMarcada(buildUrl(path), {
    method: 'POST',
    credentials: CREDENCIALES,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Token ${token}` } : {}),
    },
    body: formData,
  });
  registrarHoraServidor(response.headers?.get?.('Date'));
  const payload = await parseResponse(response);
  if (!response.ok) {
    if (response.status === 401) await invalidateRejectedSession(token);
    throw buildResponseError(response, payload, `Error HTTP ${response.status}`);
  }
  return payload;
};

export const becasRequest = async (path, options = {}) => {
  const token = await getBecasToken();
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(token ? { Authorization: `Token ${token}` } : {}),
    ...(options.headers || {}),
  };

  const response = await fetchConRedMarcada(buildUrl(path), {
    ...options,
    credentials: CREDENCIALES,
    headers,
    body: options.body && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body,
  });
  registrarHoraServidor(response.headers?.get?.('Date'));
  const payload = await parseResponse(response);
  if (!response.ok) {
    if (response.status === 401) await invalidateRejectedSession(token);
    throw buildResponseError(response, payload, `Error HTTP ${response.status}`);
  }
  return payload;
};
