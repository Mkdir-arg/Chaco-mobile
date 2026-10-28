import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PERMISOS, consultarPermiso, pedirPermiso, observarPermiso, alVolverAlFrente,
} from '../services/permisos';

const INICIAL = { estado: 'unknown', canAskAgain: true };
// Si el diálogo del permiso se ignora, el botón no puede quedar colgado para siempre.
export const ESPERA_PEDIDO_MS = 15000;
const VENCIDO = Symbol('vencido');

// Estado de los permisos del dispositivo. Se refresca al abrir el panel (activo),
// al volver la app al frente y cuando el navegador avisa un cambio. Nunca toca el estado
// después de desmontarse (cerrar el perfil mientras se pide un permiso).
export default function usePermisos(activo, { esperaMs = ESPERA_PEDIDO_MS } = {}) {
  const [permisos, setPermisos] = useState({ ubicacion: INICIAL, camara: INICIAL });
  const [pidiendo, setPidiendo] = useState({});
  const montado = useRef(true);

  useEffect(() => {
    montado.current = true;
    return () => { montado.current = false; };
  }, []);

  const refrescar = useCallback(async () => {
    const lista = await Promise.all(PERMISOS.map((clave) => consultarPermiso(clave)));
    if (!montado.current) return;
    setPermisos(Object.fromEntries(PERMISOS.map((clave, i) => [clave, lista[i]])));
  }, []);

  const pedir = useCallback(async (clave) => {
    setPidiendo((previo) => ({ ...previo, [clave]: true }));
    let temporizador;
    try {
      const vencido = new Promise((resolve) => { temporizador = setTimeout(() => resolve(VENCIDO), esperaMs); });
      let nuevo = await Promise.race([pedirPermiso(clave), vencido]);
      // Venció la espera: se vuelve a consultar el estado y se libera el botón.
      if (nuevo === VENCIDO) nuevo = await consultarPermiso(clave);
      if (montado.current) setPermisos((previo) => ({ ...previo, [clave]: nuevo }));
    } finally {
      clearTimeout(temporizador);
      if (montado.current) setPidiendo((previo) => ({ ...previo, [clave]: false }));
    }
  }, [esperaMs]);

  useEffect(() => {
    if (!activo) return undefined;
    refrescar();
    const bajas = [alVolverAlFrente(refrescar), ...PERMISOS.map((clave) => observarPermiso(clave, refrescar))];
    return () => bajas.forEach((baja) => baja());
  }, [activo, refrescar]);

  return { permisos, pidiendo, pedir };
}
