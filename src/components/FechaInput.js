import React, { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { useTheme } from '../context/ThemeContext';
import { fontSizes, radii } from '../theme';
import WebDateInput from './WebDateInput';

// Fecha de un campo del formulario. El valor circula como DD/MM/AAAA, igual que en Becas.
const aIso = (texto) => {
  const partes = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(texto || '').trim());
  return partes ? `${partes[3]}-${partes[2]}-${partes[1]}` : '';
};
const aTexto = (fecha) => `${String(fecha.getDate()).padStart(2, '0')}/${String(fecha.getMonth() + 1).padStart(2, '0')}/${fecha.getFullYear()}`;

export default function FechaInput({ label, value, onSelect, required = false }) {
  const { theme, typography } = useTheme();
  const [abierto, setAbierto] = useState(false);
  const caja = [styles.input, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }];

  if (Platform.OS === 'web') {
    return <WebDateInput value={aIso(value)} onSelect={onSelect} label={label} required={required} style={styles.input} />;
  }

  const iso = aIso(value);
  const inicial = iso ? new Date(`${iso}T12:00:00`) : new Date();
  const abrir = () => {
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: inicial,
        mode: 'date',
        display: 'calendar',
        onChange: (event, elegida) => {
          if (event.type !== 'dismissed' && elegida) onSelect(aTexto(elegida));
        },
      });
    } else {
      setAbierto((actual) => !actual);
    }
  };

  return (
    <View>
      <Pressable accessibilityRole="button" accessibilityLabel={`${label}${required ? ', obligatorio' : ''}`}
        onPress={abrir} style={caja}>
        <Text style={{ color: value ? theme.colors.text : theme.colors.textSoft, fontFamily: typography.medium }}>
          {value || 'Seleccionar fecha'}
        </Text>
      </Pressable>
      {abierto && Platform.OS === 'ios' ? (
        <DateTimePicker value={inicial} mode="date" display="inline"
          onChange={(event, elegida) => { if (event.type !== 'dismissed' && elegida) onSelect(aTexto(elegida)); }} />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: fontSizes.sm,
    justifyContent: 'center',
  },
});
