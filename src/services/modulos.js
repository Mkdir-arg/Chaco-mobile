// En el orden en que los manda el login y se muestran en el selector.
export const MODULOS = ['becas', 'dispositivos', 'emergencia'];

export const NOMBRE_MODULO = { becas: 'Becas', dispositivos: 'Dispositivos', emergencia: 'Emergencia' };

// Una sesión guardada antes de que el login devolviera `modulos` es de Becas: es lo
// único que la app hacía entonces.
export const normalizarModulos = (modulos) => (
  Array.isArray(modulos) ? MODULOS.filter((modulo) => modulos.includes(modulo)) : ['becas']
);

// Con un solo módulo se entra directo. Con varios, el último elegido, o null para que
// la persona elija.
export const moduloInicial = (modulos, guardado) => {
  if (modulos.includes(guardado)) return guardado;
  return modulos.length === 1 ? modulos[0] : null;
};
