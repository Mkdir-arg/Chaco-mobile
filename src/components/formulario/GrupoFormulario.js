import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { useTheme } from '../../context/ThemeContext';
import { fontSizes, radii } from '../../theme';

// Un grupo del constructor: título, textos (con sus enlaces) y campos. Cómo se dibuja
// cada campo lo decide la pantalla con `renderCampo`.
export default function GrupoFormulario({ group, renderCampo, onEnlaceFallido }) {
  const { theme, typography } = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }]}>
      <Text style={[styles.cardTitle, { color: theme.colors.text, fontFamily: typography.bold }]}>{group.titulo}</Text>
      {!!group.subtitulo && <Text style={[styles.personMeta, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>{group.subtitulo}</Text>}
      {group.items.map(item => item.tipo === 'texto' ? (
        <Text key={item.clave} style={[styles.personMeta, { color: theme.colors.text, fontFamily: typography.medium }]}>
          {String(item.texto || '').split(/(https?:\/\/[^\s]+)/g).map((part, index) => /^https?:\/\//.test(part) ? (
            <Text key={index} accessibilityRole="link" style={{ color: theme.colors.primary, textDecorationLine: 'underline' }}
              onPress={() => WebBrowser.openBrowserAsync(part).catch(onEnlaceFallido)}>{part}</Text>
          ) : part)}
        </Text>
      ) : renderCampo(item))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radii.xl,
    borderWidth: 1,
    padding: 14,
    marginBottom: 12,
    shadowColor: '#252F40',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.06,
    shadowRadius: 20,
    elevation: 2,
  },
  cardTitle: { fontSize: fontSizes.base, marginBottom: 8 },
  personMeta: {
    fontSize: fontSizes.xs,
  },
});
