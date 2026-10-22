import { useCallback, useEffect, useState } from 'react';
import {
  PERMISOS, consultarPermiso, pedirPermiso, observarPermiso, alVolverAlFrente,
} from '../services/permisos';

const INICIAL = { estado: 'unknown', canAskAgain: true };

// Estado de los permisos del dispositivo. Se refresca al abrir el panel (activo),
// al volver la app al frente y cuando el navegador avisa un cambio.
export default function usePermisos(activo) {
  const [permisos, setPermisos] = useState({ ubicacion: INICIAL, camara: INICIAL });

  const refrescar = useCallback(async () => {
    const lista = await Promise.all(PERMISOS.map((clave) => consultarPermiso(clave)));
    setPermisos(Object.fromEntries(PERMISOS.map((clave, i) => [clave, lista[i]])));
  }, []);

  const pedir = useCallback(async (clave) => {
    const nuevo = await pedirPermiso(clave);
    setPermisos((previo) => ({ ...previo, [clave]: nuevo }));
  }, []);

  useEffect(() => {
    if (!activo) return undefined;
    refrescar();
    const bajas = [alVolverAlFrente(refrescar), ...PERMISOS.map((clave) => observarPermiso(clave, refrescar))];
    return () => bajas.forEach((baja) => baja());
  }, [activo, refrescar]);

  return { permisos, pedir };
}
