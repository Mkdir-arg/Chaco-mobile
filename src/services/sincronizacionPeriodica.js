import { AppState } from 'react-native';

// Cada cuánto se sincroniza de fondo mientras la app está en primer plano. Al volver la red o la
// app al frente se sincroniza en el momento, así que no hace falta preguntar más seguido: cada
// pasada baja la lista completa de relevamientos, y en campo eso es batería y datos móviles.
export const SYNC_INTERVAL_MS = 60 * 1000;

// Corre `tarea` cada `cadaMs` solo con la app activa. En segundo plano (o con la pestaña oculta,
// en la PWA) se frena; al volver al frente corre en el momento y retoma el intervalo.
// Devuelve la función para dejar de repetir.
export const repetirMientrasActiva = (tarea, cadaMs = SYNC_INTERVAL_MS) => {
  let timer = null;
  const arrancar = () => {
    if (timer == null) timer = setInterval(tarea, cadaMs);
  };
  const frenar = () => {
    if (timer != null) clearInterval(timer);
    timer = null;
  };
  if (AppState.currentState !== 'background') arrancar();
  const sub = AppState.addEventListener('change', (estado) => {
    if (estado === 'active') {
      if (timer == null) {
        tarea();
        arrancar();
      }
    } else if (estado === 'background') {
      frenar();
    }
  });
  return () => {
    frenar();
    sub?.remove?.();
  };
};
