import AsyncStorage from '@react-native-async-storage/async-storage';

// Lo que Emergencia deja en el teléfono con datos de personas y no tiene que sobrevivir a la sesión:
// - los borradores de la ficha individual (M2, `emergenciaLlegadas`), con datos personales y de salud;
// - los envíos de la puerta sin resultado («Ingresar igual» / «Avisar a la mesa», M2-6): el uuid con el
//   DNI de la familia y el Formulario 1 tipeado, para reintentar el mismo pedido.
// Sin dependencias de red ni de sesión: lo usan el logout (AuthContext) y la entrada al módulo.
// Los uuid pendientes de «Agregar persona» y «Confirmar persona» NO se borran acá: no tienen datos de
// nadie y son los que evitan que un reintento duplique.
export const PREFIJO_BORRADOR_FICHA = 'emergencia_llegadas_ficha:';
export const PREFIJO_PUERTA = 'emergencia_llegadas_puerta:';
export const VIDA_BORRADOR_MS = 48 * 60 * 60 * 1000;
const PREFIJOS = [PREFIJO_BORRADOR_FICHA, PREFIJO_PUERTA];

// La cola de escrituras de lo que Emergencia guarda por usuario en AsyncStorage (los borradores y los
// uuid pendientes de `emergenciaLlegadas`, y la depuración de acá): de a una, en orden, así una
// lectura-modificación-escritura no pisa a otra.
let cola = Promise.resolve();
export const enOrdenGuardado = (tarea) => {
  const resultado = cola.then(tarea, tarea);
  cola = resultado.catch(() => {});
  return resultado;
};

const prefijoDe = (clave) => (typeof clave === 'string' ? PREFIJOS.find((prefijo) => clave.startsWith(prefijo)) : undefined);
const claves = async () => {
  const todas = typeof AsyncStorage.getAllKeys === 'function' ? await AsyncStorage.getAllKeys() : [];
  return (todas || []).filter((clave) => !!prefijoDe(clave));
};

// Logout: se borran los borradores de ficha y los envíos de la puerta de todos los usuarios del teléfono.
export const limpiarDatosLocalesEmergencia = () => enOrdenGuardado(async () => {
  for (const clave of await claves()) await AsyncStorage.removeItem(clave);
});

// Al abrir el módulo: los de otro usuario se borran enteros, y de los del actual, los vencidos (48 h).
export const depurarBorradoresFicha = (ownerActual, ahora = Date.now()) => enOrdenGuardado(async () => {
  const owner = ownerActual == null ? null : String(ownerActual);
  for (const clave of await claves()) {
    if (clave !== `${prefijoDe(clave)}${owner}`) {
      await AsyncStorage.removeItem(clave);
      continue;
    }
    let todas = {};
    try {
      todas = JSON.parse(await AsyncStorage.getItem(clave) || '{}') || {};
    } catch {
      todas = {};
    }
    const vigentes = Object.fromEntries(Object.entries(todas)
      .filter(([, b]) => b && typeof b === 'object' && ahora - Number(b.guardado_en || 0) < VIDA_BORRADOR_MS));
    if (Object.keys(vigentes).length) await AsyncStorage.setItem(clave, JSON.stringify(vigentes));
    else await AsyncStorage.removeItem(clave);
  }
});
