import React, { useState } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import Banner from '../components/Banner';
import CustomButton from '../components/CustomButton';
import SettingsPanel from '../components/SettingsPanel';
import { fontSizes } from '../theme';

// Módulo Dispositivos. No importa nada de Becas: comparte solo sesión, tema y
// componentes genéricos. Las pantallas de relevamientos edilicios llegan con el
// contrato del back.
export default function DispositivosApp({ onCambiarModulo }) {
  const { theme, typography } = useTheme();
  const { user, logout } = useAuth();
  const [settingsVisible, setSettingsVisible] = useState(false);
  const displayName = user?.username || user?.nombre || 'Usuario';

  return (
    <>
      <Banner title={`Hola, ${displayName}`} />
      <View style={styles.content}>
        <Text style={[styles.text, { color: theme.colors.textMuted, fontFamily: typography.medium }]}>
          Tus relevamientos edilicios asignados van a aparecer acá.
        </Text>
        <CustomButton title="Menú" variant="secondary" iconLeft="menu" onPress={() => setSettingsVisible(true)} />
      </View>
      <SettingsPanel
        visible={!!settingsVisible}
        onClose={() => setSettingsVisible(false)}
        onCambiarModulo={onCambiarModulo && (() => {
          setSettingsVisible(false);
          onCambiarModulo();
        })}
        onLogout={() => {
          setSettingsVisible(false);
          logout();
        }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    gap: 16,
  },
  text: {
    fontSize: fontSizes.base,
    textAlign: 'center',
  },
});
