import AsyncStorage from '@react-native-async-storage/async-storage';
import { becasRequest, getBecasToken, getStoredBecasUser } from './becasApi';
import { esSinModulo, notificarSinModulo } from './sinModulo';

// Perfil del módulo Emergencia: qué accesos muestra la pantalla inicial. Se guarda para poder
// arrancar sin red.
export const MODULO = 'emergencia';
export const PERFIL_PATH = '/api/emergencia/perfil/';
// Una clave por usuario. La clave sin usuario (`emergencia_perfil`) es de la primera versión:
// no se lee y se borra al guardar o al cerrar sesión.
const CACHE_KEY_VIEJA = 'emergencia_perfil';
const cacheKey = (owner) => `${CACHE_KEY_VIEJA}:${owner}`;

// Sin tiempo máximo, un pedido colgado deja «Reintentar», el pull-to-refresh y el sincronizar
// del Banner esperando la misma promesa para siempre. Mutable solo para los tests.
export const LIMITES = { perfilMs: 15000 };

export const ACCESOS = [
  { clave: 'relevar', titulo: 'Ingreso de familias', icono: 'people-outline' },
  { clave: 'llegadas', titulo: 'Llegada de familias', icono: 'home-outline' },
  { clave: 'kits', titulo: 'Recepción de kits', icono: 'cube-outline' },
];

const listeners = new Set();
// { token, promesa }: solo se comparte con quien pide con el mismo token.
let pedidoEnCurso = null;

// El back suma `llegadas` y `kits` sin sacar `dispositivo`: si no vienen, `dispositivo`
// habilita los dos, como dice el contrato.
const bandera = (valor, respaldo) => (typeof valor === 'boolean' ? valor : !!respaldo);
export const normalizarPerfil = (payload) => {
  const datos = payload && typeof payload === 'object' ? payload : {};
  return {
    relevar: datos.relevar === true,
    llegadas: bandera(datos.llegadas, datos.dispositivo === true),
    kits: bandera(datos.kits, datos.dispositivo === true),
  };
};

export const accesosDelPerfil = (perfil) => (perfil ? ACCESOS.filter(({ clave }) => perfil[clave]) : []);

// El listener recibe el perfil normalizado cada vez que el back contesta uno nuevo.
export const subscribePerfil = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const avisarPerfil = (perfil) => listeners.forEach((listener) => {
  try {
    listener(perfil);
  } catch (error) {
    console.warn('[EMERGENCIA][PERFIL][LISTENER]', error?.message);
  }
});

const ownerActual = async () => {
  const user = await getStoredBecasUser();
  return user?.id != null ? String(user.id) : null;
};

// Solo el perfil del usuario con sesión: el teléfono puede ser compartido.
export const getPerfilGuardado = async (dueno) => {
  try {
    const owner = dueno ?? await ownerActual();
    const raw = owner ? await AsyncStorage.getItem(cacheKey(owner)) : null;
    const guardado = raw ? JSON.parse(raw) : null;
    if (!guardado || guardado.owner_user_id !== owner) return null;
    return normalizarPerfil(guardado.perfil);
  } catch {
    return null;
  }
};

const guardarPerfil = async (owner, perfil) => {
  if (!owner) return;
  try {
    await AsyncStorage.setItem(cacheKey(owner), JSON.stringify({
      owner_user_id: owner, perfil, guardado_en: new Date().toISOString(),
    }));
    await AsyncStorage.removeItem(CACHE_KEY_VIEJA);
  } catch {
    // Sin poder guardar, el próximo arranque sin red no tiene perfil: no es bloqueante.
  }
};

// Al cerrar sesión (AuthContext) y ante el 403 SIN_MODULO. No tira nunca.
export const olvidarPerfilGuardado = async (owner) => {
  try {
    await Promise.allSettled([
      owner != null ? AsyncStorage.removeItem(cacheKey(String(owner))) : null,
      AsyncStorage.removeItem(CACHE_KEY_VIEJA),
    ]);
  } catch {
    // Nada que hacer.
  }
};

// Corta el pedido a los LIMITES.perfilMs: becasRequest aborta el fetch y sale con un error
// `network` + `timeout`, aunque el fetch no respete la señal.
const pedirConLimite = (path) => becasRequest(path, { timeoutMs: LIMITES.perfilMs });

// La respuesta de un pedido hecho con otra sesión no es de quien está ahora: no se guarda, no se
// avisa y no se usa lo guardado.
const errorObsoleto = () => Object.assign(new Error('La sesión cambió mientras se pedía el perfil.'),
  { obsoleto: true });

// Pide el perfil. Devuelve { perfil, desdeCache, sinRed }.
// - 200: lo guarda y avisa a quien escucha.
// - 403 SIN_MODULO: el usuario ya no entra al módulo; se avisa la señal común (AuthContext saca
//   el módulo y muestra el `detail` si era el último) y el error sale con `sinModulo: true`.
// - 401: becasRequest ya invalidó la sesión; el error sale.
// - Otra falla (sin red, tiempo agotado, 5xx, WAF): lo guardado, si hay, con `sinRed` cuando fue
//   la red; si no, el error sale.
// - La sesión cambió mientras tanto: el error sale con `obsoleto: true`.
// Pedidos simultáneos con la misma sesión comparten la misma respuesta. Token y dueño se toman al
// empezar: si se tomaran al llegar la respuesta, el perfil de un usuario quedaría a nombre del
// siguiente que entra en el mismo teléfono.
export const cargarPerfil = async () => {
  const token = await getBecasToken();
  if (pedidoEnCurso && pedidoEnCurso.token === token) return pedidoEnCurso.promesa;
  const promesa = (async () => {
    const owner = await ownerActual();
    const sigueLaSesion = async () => (await getBecasToken()) === token;
    try {
      const perfil = normalizarPerfil(await pedirConLimite(PERFIL_PATH));
      if (!await sigueLaSesion()) throw errorObsoleto();
      await guardarPerfil(owner, perfil);
      avisarPerfil(perfil);
      return { perfil, desdeCache: false, sinRed: false };
    } catch (error) {
      if (error?.obsoleto) throw error;
      if (esSinModulo(error)) {
        await olvidarPerfilGuardado(owner);
        notificarSinModulo(MODULO, error?.requestToken ?? null, error?.payload?.detail);
        throw Object.assign(error, { sinModulo: true });
      }
      if (Number(error?.status) === 401) throw error;
      if (!await sigueLaSesion()) throw errorObsoleto();
      const guardado = await getPerfilGuardado(owner);
      if (guardado) return { perfil: guardado, desdeCache: true, sinRed: !!error?.network && !error?.timeout };
      throw error;
    }
  })();
  const actual = { token, promesa };
  pedidoEnCurso = actual;
  promesa.finally(() => { if (pedidoEnCurso === actual) pedidoEnCurso = null; }).catch(() => {});
  return promesa;
};

// Para las pantallas del módulo: ante un 403 SIN_MODULO de cualquier pedido de Emergencia se
// vuelve a pedir el perfil, porque el código también significa «falta un permiso parcial»
// (agente, kits o llegadas). Solo si el perfil también da 403 SIN_MODULO se saca el módulo;
// si da 200, se actualizan los accesos. Devuelve 'quitado', 'actualizado', 'sin_verificar'
// (no se pudo pedir el perfil) o null si el error no era SIN_MODULO.
export const verificarSinModulo = async (error) => {
  if (!esSinModulo(error)) return null;
  try {
    const { desdeCache } = await cargarPerfil();
    return desdeCache ? 'sin_verificar' : 'actualizado';
  } catch (fallo) {
    return fallo?.sinModulo ? 'quitado' : 'sin_verificar';
  }
};
