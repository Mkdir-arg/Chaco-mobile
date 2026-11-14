import AsyncStorage from '@react-native-async-storage/async-storage';
import { becasRequest, getStoredBecasUser } from './becasApi';
import { esSinModulo, notificarSinModulo } from './sinModulo';

// Perfil del módulo Emergencia: qué accesos muestra la pantalla inicial. Se guarda para poder
// arrancar sin red.
export const MODULO = 'emergencia';
export const PERFIL_PATH = '/api/emergencia/perfil/';
const CACHE_KEY = 'emergencia_perfil';

export const ACCESOS = [
  { clave: 'relevar', titulo: 'Ingreso de familias', icono: 'people-outline' },
  { clave: 'llegadas', titulo: 'Llegada de familias', icono: 'home-outline' },
  { clave: 'kits', titulo: 'Recepción de kits', icono: 'cube-outline' },
];

const listeners = new Set();
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
export const getPerfilGuardado = async () => {
  try {
    const owner = await ownerActual();
    const raw = owner ? await AsyncStorage.getItem(CACHE_KEY) : null;
    const guardado = raw ? JSON.parse(raw) : null;
    if (!guardado || guardado.owner_user_id !== owner) return null;
    return normalizarPerfil(guardado.perfil);
  } catch {
    return null;
  }
};

const guardarPerfil = async (perfil) => {
  try {
    const owner = await ownerActual();
    if (!owner) return;
    await AsyncStorage.setItem(CACHE_KEY, JSON.stringify({
      owner_user_id: owner, perfil, guardado_en: new Date().toISOString(),
    }));
  } catch {
    // Sin poder guardar, el próximo arranque sin red no tiene perfil: no es bloqueante.
  }
};

const borrarPerfil = async () => {
  try {
    await AsyncStorage.removeItem(CACHE_KEY);
  } catch {
    // Nada que hacer.
  }
};

// Pide el perfil. Devuelve { perfil, desdeCache }.
// - 200: lo guarda y avisa a quien escucha.
// - 403 SIN_MODULO: el usuario ya no entra al módulo; se avisa la señal común (AuthContext saca
//   el módulo) y el error sale con `sinModulo: true`.
// - 401: becasRequest ya invalidó la sesión; el error sale.
// - Otra falla (sin red, 5xx, WAF): lo guardado, si hay; si no, el error sale.
// Pedidos simultáneos comparten la misma respuesta.
export const cargarPerfil = () => {
  if (pedidoEnCurso) return pedidoEnCurso;
  pedidoEnCurso = (async () => {
    try {
      const perfil = normalizarPerfil(await becasRequest(PERFIL_PATH));
      await guardarPerfil(perfil);
      avisarPerfil(perfil);
      return { perfil, desdeCache: false };
    } catch (error) {
      if (esSinModulo(error)) {
        await borrarPerfil();
        notificarSinModulo(MODULO, error?.requestToken ?? null);
        throw Object.assign(error, { sinModulo: true });
      }
      if (Number(error?.status) === 401) throw error;
      const guardado = await getPerfilGuardado();
      if (guardado) return { perfil: guardado, desdeCache: true };
      throw error;
    }
  })();
  const actual = pedidoEnCurso;
  actual.finally(() => { if (pedidoEnCurso === actual) pedidoEnCurso = null; }).catch(() => {});
  return actual;
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
