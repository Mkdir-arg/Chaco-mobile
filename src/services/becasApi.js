import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { API_CONFIG } from '../config/apiConfig';
import { apiErrorMessage } from './formularioSync';
import { readWebBlob } from './webAttachments';

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

const storage = {
  getItem: async (key) => {
    if (Platform.OS === 'web') return AsyncStorage.getItem(key);
    try {
      return await SecureStore.getItemAsync(key);
    } catch {
      return AsyncStorage.getItem(key);
    }
  },
  setItem: async (key, value) => {
    if (Platform.OS === 'web') return AsyncStorage.setItem(key, value);
    try {
      return await SecureStore.setItemAsync(key, value);
    } catch {
      return AsyncStorage.setItem(key, value);
    }
  },
  deleteItem: async (key) => {
    if (Platform.OS === 'web') return AsyncStorage.removeItem(key);
    try {
      return await SecureStore.deleteItemAsync(key);
    } catch {
      return AsyncStorage.removeItem(key);
    }
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
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export const clearBecasSession = async () => {
  await Promise.all([
    storage.deleteItem(TOKEN_KEY),
    storage.deleteItem(USER_DATA_KEY),
    storage.deleteItem(USER_ID_KEY),
  ]);
};

const isUnexpectedHtmlResponse = (response, payload) => {
  const contentType = String(response?.headers?.get?.('content-type') || '').toLowerCase();
  const detail = String(payload?.detail || '').trim().toLowerCase();
  return contentType.includes('text/html') || detail.startsWith('<!doctype html') || detail.startsWith('<html');
};

const buildResponseError = (response, payload, fallback) => {
  const unexpectedHtml = isUnexpectedHtmlResponse(response, payload);
  const error = new Error(unexpectedHtml
    ? `El servidor devolvio una pagina HTML inesperada (HTTP ${response.status}).`
    : apiErrorMessage(payload, fallback));
  error.status = response.status;
  error.payload = unexpectedHtml ? null : payload;
  error.unexpectedHtml = unexpectedHtml;
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
  const payload = await parseResponse(response);
  if (!response.ok) {
    throw new Error(payload?.detail || payload?.non_field_errors?.[0] || 'No se pudo iniciar sesion.');
  }

  const user = {
    id: payload.user_id,
    username: payload.username,
    nombre: payload.username,
    grupos: [],
    es_admin: false,
  };
  await Promise.all([
    storage.setItem(TOKEN_KEY, payload.token),
    storage.setItem(USER_ID_KEY, String(payload.user_id)),
    storage.setItem(USER_DATA_KEY, JSON.stringify(user)),
  ]);
  return user;
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

  const response = await fetch(buildUrl(path), {
    method: 'POST',
    credentials: CREDENCIALES,
    headers: {
      Accept: 'application/json',
      ...(token ? { Authorization: `Token ${token}` } : {}),
    },
    body: formData,
  });
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

  const response = await fetch(buildUrl(path), {
    ...options,
    credentials: CREDENCIALES,
    headers,
    body: options.body && typeof options.body !== 'string'
      ? JSON.stringify(options.body)
      : options.body,
  });
  const payload = await parseResponse(response);
  if (!response.ok) {
    if (response.status === 401) await invalidateRejectedSession(token);
    throw buildResponseError(response, payload, `Error HTTP ${response.status}`);
  }
  return payload;
};
