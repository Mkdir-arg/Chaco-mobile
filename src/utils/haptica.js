import { Platform, Vibration } from 'react-native';

// Toque corto al elegir algo (un día, un filtro). Nunca es la única respuesta: siempre va con
// el cambio visual. En iOS no se usa: Vibration ignora la duración y vibra ~400 ms, y Safari
// (la PWA en iPhone) no tiene vibración. En Android y Chrome son 10 ms.
export const DURACION_SELECCION_MS = 10;

export const vibrarSeleccion = (plataforma = Platform.OS, vibrar = (ms) => Vibration.vibrate(ms)) => {
    if (plataforma === 'ios') return false;
    try {
        vibrar(DURACION_SELECCION_MS);
        return true;
    } catch {
        return false;
    }
};

// Aviso de resultado: un toque corto si salió bien, dos si hubo error. Va junto con el aviso
// en pantalla, nunca solo. Mismas reglas de plataforma que vibrarSeleccion.
const PATRONES_AVISO = { success: 15, error: [0, 25, 70, 25] };

export const vibrarAviso = (tipo, plataforma = Platform.OS, vibrar = (patron) => Vibration.vibrate(patron)) => {
    const patron = PATRONES_AVISO[tipo];
    if (!patron || plataforma === 'ios') return false;
    try {
        vibrar(patron);
        return true;
    } catch {
        return false;
    }
};
