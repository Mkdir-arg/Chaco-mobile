import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

// Lo que Emergencia deja en el teléfono con datos de personas y no tiene que sobrevivir a la sesión:
// - los borradores de la ficha individual (M2, `emergenciaLlegadas`), con datos personales y de salud;
// - los envíos de la puerta sin resultado («Ingresar igual» / «Avisar a la mesa», M2-6): el uuid con el
//   DNI de la familia y el Formulario 1 tipeado, para reintentar el mismo pedido.
// Sin dependencias de red ni de sesión: lo usan el logout (AuthContext) y la entrada al módulo.
//
// Un envío de la puerta sin resultado NO se borra entero: su uuid es lo único que evita un segundo
// caso si el primero había llegado (el back busca el uuid ANTES de validar el Formulario 1, así que el
// reenvío con solo el uuid devuelve el caso). Al limpiar se borra lo tipeado y queda
// { uuid, accion, dispositivo, creado_en } bajo PREFIJO_PUERTA_UUID, por usuario, con la clave
// `huellaPuerta` (SHA-256 de dispositivo y DNI: el DNI no queda en claro) y 7 días de vida.
// Los uuid pendientes de «Agregar persona» y «Confirmar persona» tampoco se borran: no tienen datos de
// nadie y son los que evitan que un reintento duplique.
export const PREFIJO_BORRADOR_FICHA = 'emergencia_llegadas_ficha:';
export const PREFIJO_PUERTA = 'emergencia_llegadas_puerta:';
export const PREFIJO_PUERTA_UUID = 'emergencia_llegadas_puerta_uuid:';
export const VIDA_BORRADOR_MS = 48 * 60 * 60 * 1000;
export const VIDA_UUID_PUERTA_MS = 7 * 24 * 60 * 60 * 1000;
const PREFIJOS = [PREFIJO_BORRADOR_FICHA, PREFIJO_PUERTA];
const ACCIONES = ['ingresar', 'avisar'];

// La cola de escrituras de lo que Emergencia guarda por usuario en AsyncStorage (los borradores y los
// uuid pendientes de `emergenciaLlegadas`, y la depuración de acá): de a una, en orden, así una
// lectura-modificación-escritura no pisa a otra.
let cola = Promise.resolve();
export const enOrdenGuardado = (tarea) => {
  const resultado = cola.then(tarea, tarea);
  cola = resultado.catch(() => {});
  return resultado;
};

// La clave de un envío de la puerta sin lo tipeado: dispositivo y DNI, sin el DNI en claro. Es una
// seudonimización: con 10^8 DNI posibles, quien tenga el teléfono la puede revertir por fuerza bruta.
export const huellaPuerta = async (dispositivoId, dni) => String(await Crypto.digestStringAsync(
  Crypto.CryptoDigestAlgorithm.SHA256, `${dispositivoId}:${String(dni ?? '').replace(/\D/g, '')}`)).toLowerCase();

export const leerJson = async (clave) => {
  try {
    const valor = JSON.parse(await AsyncStorage.getItem(clave) || '{}');
    return valor && typeof valor === 'object' && !Array.isArray(valor) ? valor : {};
  } catch {
    return {};
  }
};
export const escribirJson = async (clave, todas) => {
  if (Object.keys(todas).length) await AsyncStorage.setItem(clave, JSON.stringify(todas));
  else await AsyncStorage.removeItem(clave);
};

export const creadoEn = (p) => Number(p?.creado_en || p?.guardado_en || 0);
export const uuidVigente = (p, ahora = Date.now()) => !!p && typeof p === 'object' && ACCIONES.includes(p.accion)
  && typeof p.uuid === 'string' && ahora - creadoEn(p) < VIDA_UUID_PUERTA_MS;

const prefijoDe = (clave) => (typeof clave === 'string' ? PREFIJOS.find((prefijo) => clave.startsWith(prefijo)) : undefined);
const todasLasClaves = async () => {
  const todas = typeof AsyncStorage.getAllKeys === 'function' ? await AsyncStorage.getAllKeys() : [];
  return (todas || []).filter((clave) => typeof clave === 'string');
};

// Pasa a la tienda sin datos los envíos de la puerta de `clave` que cumplan `pasar` y deja el resto.
// Si no se puede calcular la huella (sin crypto), ese uuid se pierde: es lo de antes.
const pasarASinDatos = async (clave, pasar, ahora) => {
  const owner = clave.slice(PREFIJO_PUERTA.length);
  const todas = await leerJson(clave);
  const claveUuid = `${PREFIJO_PUERTA_UUID}${owner}`;
  const sinDatos = await leerJson(claveUuid);
  for (const [id, p] of Object.entries(todas)) {
    if (!pasar(p)) continue;
    delete todas[id];
    if (!uuidVigente(p, ahora)) continue;
    const separador = id.indexOf(':');
    const dispositivo = id.slice(0, separador);
    try {
      sinDatos[await huellaPuerta(dispositivo, id.slice(separador + 1))] = { uuid: p.uuid, accion: p.accion, dispositivo, creado_en: creadoEn(p) };
    } catch {
      // Sin huella no se guarda: el DNI no queda en claro.
    }
  }
  await escribirJson(claveUuid, sinDatos);
  await escribirJson(clave, todas);
};

// Los uuid sin datos vencidos (7 días) se borran.
const depurarSinDatos = async (clave, ahora) => {
  const todas = await leerJson(clave);
  Object.keys(todas).forEach((huella) => { if (!uuidVigente(todas[huella], ahora)) delete todas[huella]; });
  await escribirJson(clave, todas);
};

// Logout, sesión vencida o sin el módulo: se borran los borradores de ficha y lo tipeado en la puerta de
// todos los usuarios del teléfono; de la puerta queda solo el uuid sin datos.
export const limpiarDatosLocalesEmergencia = (ahora = Date.now()) => enOrdenGuardado(async () => {
  for (const clave of await todasLasClaves()) {
    const prefijo = prefijoDe(clave);
    if (prefijo === PREFIJO_PUERTA) await pasarASinDatos(clave, () => true, ahora);
    else if (prefijo) await AsyncStorage.removeItem(clave);
  }
});

// Al abrir el módulo: los borradores de otro usuario se borran enteros (de la puerta queda el uuid sin
// datos), y de los del actual, los vencidos (48 h). Los uuid sin datos vencen a los 7 días.
export const depurarBorradoresFicha = (ownerActual, ahora = Date.now()) => enOrdenGuardado(async () => {
  const owner = ownerActual == null ? null : String(ownerActual);
  for (const clave of await todasLasClaves()) {
    if (clave.startsWith(PREFIJO_PUERTA_UUID)) {
      await depurarSinDatos(clave, ahora);
      continue;
    }
    const prefijo = prefijoDe(clave);
    if (!prefijo) continue;
    const propia = clave === `${prefijo}${owner}`;
    const vencido = (b) => !(b && typeof b === 'object' && ahora - Number(b.guardado_en || 0) < VIDA_BORRADOR_MS);
    if (prefijo === PREFIJO_PUERTA) {
      await pasarASinDatos(clave, propia ? vencido : () => true, ahora);
      continue;
    }
    if (!propia) {
      await AsyncStorage.removeItem(clave);
      continue;
    }
    const todas = await leerJson(clave);
    Object.keys(todas).forEach((k) => { if (vencido(todas[k])) delete todas[k]; });
    await escribirJson(clave, todas);
  }
});
