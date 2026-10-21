import * as Location from 'expo-location';

// En web, expo-location pide la posicion con `maximumAge: Infinity`: el navegador
// puede contestar con una posicion guardada de cualquier antiguedad, y el alta se
// quedaba con las coordenadas de la casa anterior sin ningun error a la vista. Y sin
// `timeout` la espera no termina nunca bajo techo o sin senal. Las dos opciones se
// esparcen despues de las de expo-location, asi que estas mandan. En nativo
// `timeout` no existe: la carrera contra el reloj cubre las dos plataformas.
const ANTIGUEDAD_MAXIMA_MS = 30 * 1000;
const ESPERA_MAXIMA_MS = 20 * 1000;

export const UBICACION_DEMORADA = 'UBICACION_DEMORADA';

export const posicionActual = (accuracy) => {
  let reloj;
  const demora = new Promise((_, reject) => {
    reloj = setTimeout(() => {
      const error = new Error('No se pudo obtener la ubicacion a tiempo. Proba al aire libre y revisa que el GPS este prendido.');
      error.code = UBICACION_DEMORADA;
      reject(error);
    }, ESPERA_MAXIMA_MS);
  });
  return Promise.race([
    Location.getCurrentPositionAsync({ accuracy, maximumAge: ANTIGUEDAD_MAXIMA_MS, timeout: ESPERA_MAXIMA_MS }),
    demora,
  ]).finally(() => clearTimeout(reloj));
};
