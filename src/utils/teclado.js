import { Platform } from 'react-native';

// react-native-web cierra el teclado en CUALQUIER evento de scroll, incluido el que hace
// Chrome al abrirlo (achica la ventana y desplaza el input a la vista). Por eso en web el
// ScrollView no debe cerrar el teclado al scrollear; en nativo se mantiene el modo pedido.
export const keyboardDismissModeFor = (nativeMode = 'on-drag') =>
  (Platform.OS === 'web' ? 'none' : nativeMode);
