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
