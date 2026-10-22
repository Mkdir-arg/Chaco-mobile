import React, { useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../context/ThemeContext';
import CustomButton from './CustomButton';
import { actualizarPWA, MENSAJE_SIN_CONEXION } from '../navigation/bloqueoVersion';

// Bloqueo cuando el back pide una versión mínima mayor a la instalada. Reemplaza toda
// la navegación; «Cerrar sesión» deja volver a entrar con otro usuario.
export default function ActualizarAppScreen({ actual, minima, onLogout }) {
  const { theme, typography } = useTheme();
  const [actualizando, setActualizando] = useState(false);
  const [aviso, setAviso] = useState('');
  const esWeb = Platform.OS === 'web';

  const actualizar = async () => {
    setActualizando(true);
    setAviso('');
    const resultado = await actualizarPWA({ nav: navigator, loc: window.location });
    if (resultado === 'sin_conexion') {
      setAviso(MENSAJE_SIN_CONEXION);
      setActualizando(false);
    }
  };

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.background }]}>
      <Ionicons name="cloud-download-outline" size={56} color={theme.colors.primary} />
      <Text style={[styles.title, { color: theme.colors.text, fontFamily: typography.bold }]}>Actualizá la app</Text>
      <Text style={[styles.text, { color: theme.colors.textSoft, fontFamily: typography.regular }]}>
        {esWeb
          ? 'Hay una versión nueva disponible. Actualizá para seguir usando la app.'
          : 'Tu versión de la app ya no es compatible. Instalá la versión nueva para seguir usándola.'}
      </Text>
      <Text style={[styles.text, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>
        Versión instalada: {actual || '-'}{minima ? `\nVersión mínima: ${minima}` : ''}
      </Text>
      {aviso ? <Text accessibilityRole="alert" style={[styles.text, { color: theme.colors.danger, fontFamily: typography.semibold }]}>{aviso}</Text> : null}
      {esWeb ? <CustomButton title="Actualizar" iconLeft="refresh-outline" onPress={actualizar} loading={actualizando} disabled={actualizando} /> : null}
      <CustomButton title="Cerrar sesión" iconLeft="log-out-outline" variant="tertiary" onPress={onLogout} disabled={actualizando} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 14 },
  title: { fontSize: 22, textAlign: 'center' },
  text: { fontSize: 15, textAlign: 'center', lineHeight: 22 },
});
