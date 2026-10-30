import React from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import AuthVisualBackground from '../components/AuthVisualBackground';
import CustomButton from '../components/CustomButton';
import { useAuth } from '../context/AuthContext';
import { useTheme } from '../context/ThemeContext';
import { NOMBRE_MODULO } from '../services/modulos';
import { designColors, fontSizes, radii } from '../theme';

const ICONO_MODULO = { becas: 'school-outline', dispositivos: 'business-outline' };

// Solo la ve quien tiene más de un módulo: con uno se entra directo.
export default function ModuloSelectorScreen() {
  const { theme, typography } = useTheme();
  const { user, modulos, elegirModulo, logout } = useAuth();
  const displayName = user?.nombre || user?.username || 'Usuario';

  return (
    <AuthVisualBackground>
      <ScrollView contentContainerStyle={styles.scrollContent} bounces={false}>
        <View style={[styles.card, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
          <Text style={[styles.title, { fontFamily: typography.bold }]}>Hola, {displayName}</Text>
          <Text style={[styles.subtitle, { fontFamily: typography.regular, color: theme.colors.textMuted }]}>
            {modulos.length ? '¿Con qué vas a trabajar?' : 'Tu usuario no tiene acceso a ningún módulo de la app.'}
          </Text>
          {modulos.map((modulo) => (
            <CustomButton
              key={modulo}
              title={NOMBRE_MODULO[modulo]}
              iconLeft={ICONO_MODULO[modulo]}
              size="L"
              style={styles.option}
              onPress={() => elegirModulo(modulo)}
            />
          ))}
          <CustomButton title="Cerrar sesión" variant="tertiary" iconLeft="log-out-outline" onPress={logout} />
        </View>
      </ScrollView>
    </AuthVisualBackground>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    flexGrow: 1,
    padding: 24,
    justifyContent: 'center',
  },
  card: {
    width: '100%',
    borderWidth: 1,
    borderRadius: radii.xl,
    padding: 18,
  },
  title: {
    fontSize: fontSizes['2xl'],
    marginBottom: 8,
    textAlign: 'center',
    color: designColors.textHeading,
  },
  subtitle: {
    fontSize: fontSizes.sm,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 18,
  },
  option: {
    marginBottom: 12,
  },
});
