import React, { useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { useToast } from '../context/ToastContext';
import Banner from '../components/Banner';
import CustomButton from '../components/CustomButton';
import SettingsPanel from '../components/SettingsPanel';
import EmergenciaInicioScreen from '../screens/EmergenciaInicioScreen';

// Módulo Emergencia: por ahora solo la pantalla inicial con los accesos que habilita el perfil.
// Como Dispositivos, no importa nada de los otros módulos: comparte sesión, tema y componentes.
export default function EmergenciaApp({ onCambiarModulo }) {
  const { theme } = useTheme();
  const { showAlert } = useToast();
  const { user, logout } = useAuth();
  const displayName = user?.nombre || user?.username || 'Usuario';
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [recarga, setRecarga] = useState(0);
  const [cargando, setCargando] = useState(false);

  const abrir = (acceso) => showAlert('Próximamente',
    `«${acceso.titulo}» va a estar disponible en una próxima versión de la app.`, [{ text: 'Entendido' }]);

  return (
    <>
      <Banner title={`Hola, ${displayName}`} syncStatus={cargando ? 'syncing' : 'synced'}
        onSyncPress={() => setRecarga((valor) => valor + 1)} />
      <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
        <EmergenciaInicioScreen onAbrir={abrir} recarga={recarga} onCargando={setCargando} />
      </View>
      <View style={styles.barra}>
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
  barra: { padding: 12, alignItems: 'center' },
});
