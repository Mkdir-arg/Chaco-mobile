import React, { useEffect, useState } from 'react';
import { Modal, View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import CustomButton from './CustomButton';
import { designColors, fontSizes, radii } from '../theme';
import { getInstallationHelp } from '../services/pwaInstallation';

const readHelp = () => getInstallationHelp({
  navigator: window.navigator,
  matchMedia: query => window.matchMedia(query),
});

export default function PwaInstallGuide({ linkStyle }) {
  const { theme, typography, branding } = useTheme();
  const [help, setHelp] = useState(readHelp);
  const [visible, setVisible] = useState(() => !!readHelp());
  useEffect(() => {
    const mode = window.matchMedia('(display-mode: standalone)');
    const minimalMode = window.matchMedia('(display-mode: minimal-ui)');
    const refresh = () => {
      const next = readHelp();
      setHelp(next);
      if (!next) setVisible(false);
    };
    const installed = () => { setHelp(null); setVisible(false); };
    mode.addEventListener('change', refresh);
    minimalMode.addEventListener('change', refresh);
    window.addEventListener('appinstalled', installed);
    return () => {
      mode.removeEventListener('change', refresh);
      minimalMode.removeEventListener('change', refresh);
      window.removeEventListener('appinstalled', installed);
    };
  }, []);
  if (!help) return null;
  return <>
    <Pressable accessibilityRole="button" onPress={() => setVisible(true)} style={styles.link}>
      <Text style={linkStyle}>Cómo instalar la app</Text>
    </Pressable>
    <Modal visible={visible} transparent animationType="fade" onRequestClose={() => setVisible(false)}>
      <View style={styles.overlay}>
        <View accessibilityViewIsModal accessibilityLabel="Instalar DATAÑACH"
          style={[styles.panel, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
          <ScrollView contentContainerStyle={styles.content}>
            <Text accessibilityRole="header" style={[styles.title, {color: theme.colors.text, fontFamily: typography.bold}]}>
              Instalá {branding.applicationName}
            </Text>
            <Text style={[styles.copy, {color: theme.colors.textMuted, fontFamily: typography.regular}]}>
              Seguí estos pasos en {help.device} para abrir la app desde su ícono.
            </Text>
            {help.steps.map((step, index) => <Text key={step}
              style={[styles.step, {color: theme.colors.text, fontFamily: typography.medium}]}>
              {index + 1}. {step}
            </Text>)}
            <Text style={[styles.copy, {color: theme.colors.textMuted, fontFamily: typography.regular}]}>
              Si ya la instalaste, abrila desde su ícono. Para trabajar sin conexión, primero iniciá sesión con internet y descargá tus relevamientos.
            </Text>
            <CustomButton title="Continuar al login" onPress={() => setVisible(false)} />
          </ScrollView>
        </View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  overlay: {flex: 1, backgroundColor: 'rgba(15, 23, 42, 0.38)', alignItems: 'center', justifyContent: 'center', padding: 22},
  panel: {width: '100%', maxWidth: 420, maxHeight: '90%', borderRadius: radii.xl, borderWidth: 1,
    shadowColor: designColors.shadow, shadowOpacity: 0.16, shadowRadius: 16, shadowOffset: {width: 0, height: 8}},
  content: {padding: 20, gap: 14},
  title: {fontSize: fontSizes.xl},
  copy: {fontSize: fontSizes.sm, lineHeight: 21},
  step: {fontSize: fontSizes.sm, lineHeight: 22},
  link: {alignSelf: 'center', paddingVertical: 14},
});
