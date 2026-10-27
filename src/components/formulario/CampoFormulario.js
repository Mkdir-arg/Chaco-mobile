import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import TextInput from '../FormInput';
import { useTheme } from '../../context/ThemeContext';
import { fontSizes, radii } from '../../theme';
import { errorDelCampo, esCampoEmail, esCampoDniApoderado } from '../../services/definicionFormulario';

export const parseOpciones = (options) => {
  if (Array.isArray(options)) return options;
  try {
    const parsed = JSON.parse(options || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Un campo del formulario del constructor. Lo usan Becas y Dispositivos: la pantalla
// decide de dónde sale el valor y qué hacer con los archivos y las fechas, el campo
// solo dibuja.
export default function CampoFormulario({
  field,
  value,
  onChange,
  readOnly = false,
  busqueda = '',
  onBuscar,
  renderFecha,
  onAbrirArchivo,
  onQuitarArchivo,
  onVerArchivo,
}) {
  const { theme, typography } = useTheme();
  const options = parseOpciones(field.opciones).filter(option => !busqueda
    || String(option).toLocaleLowerCase().includes(busqueda.toLocaleLowerCase()));
  if (readOnly) return (
    <View style={styles.formGroup}>
      <Text style={[styles.inputLabel, { color: theme.colors.text, fontFamily: typography.semibold }]}>{field.etiqueta}</Text>
      <View style={[styles.identityReadOnlyBox, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt }]}>
        <Text style={[styles.identityReadOnlyText, { color: theme.colors.text, fontFamily: typography.bold }]}>{String(value || '-')}</Text>
      </View>
    </View>
  );
  const searchInput = field.presentacion === 'BUSCADOR' ? (
    <TextInput value={busqueda} onChangeText={onBuscar}
      accessibilityLabel={'Buscar opciones de ' + field.etiqueta} placeholder="Buscar opciones"
      placeholderTextColor={theme.colors.textSoft}
      style={[styles.textInput, { color: theme.colors.text, borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]} />
  ) : null;
  const tipo = String(field.tipo || '').toUpperCase();
  const isInteger = ['INT', 'NUMERO'].includes(tipo);
  const isEmail = esCampoEmail(field);
  const isDni = esCampoDniApoderado(field);
  const fieldError = String(value ?? '').trim() ? errorDelCampo(field, value) : '';
  const isObservationField = /observaci[oó]n|observaciones/i.test(String(field.etiqueta || field.texto || ''));

  if (['SELECTOR', 'SELECT', 'CHOICE'].includes(tipo)) {
    return (
      <View style={styles.formGroup}>
        <Text style={[styles.inputLabel, { color: theme.colors.text, fontFamily: typography.semibold }]}>
          {field.etiqueta}{field.requerido ? ' *' : ''}
        </Text>
        {searchInput}
        <View style={styles.optionWrap}>
          {options.map((option) => {
            const selected = value === option;
            return (
              <Pressable
                key={option}
                onPress={() => onChange(option)}
                style={[
                  styles.optionChip,
                  { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
                  selected && { borderColor: theme.colors.primary, backgroundColor: `${theme.colors.primary}18` },
                ]}
              >
                <Text style={[styles.optionText, { color: selected ? theme.colors.primary : theme.colors.text, fontFamily: selected ? typography.bold : typography.medium }]}>
                  {option}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  if (['SELECTOR_MULTIPLE', 'MULTISELECT', 'MULTIPLE'].includes(tipo)) {
    const selectedValues = Array.isArray(value) ? value : [];
    return (
      <View style={styles.formGroup}>
        <Text style={[styles.inputLabel, { color: theme.colors.text, fontFamily: typography.semibold }]}>
          {field.etiqueta}{field.requerido ? ' *' : ''}
        </Text>
        {searchInput}
        <View style={styles.optionWrap}>
          {options.map((option) => {
            const selected = selectedValues.includes(option);
            return (
              <Pressable
                key={option}
                onPress={() => onChange(selected
                  ? selectedValues.filter((item) => item !== option)
                  : [...selectedValues, option])}
                style={[
                  styles.optionChip,
                  { borderColor: theme.colors.border, backgroundColor: theme.colors.surface },
                  selected && { borderColor: theme.colors.primary, backgroundColor: `${theme.colors.primary}18` },
                ]}
              >
                <Ionicons name={selected ? 'checkbox' : 'square-outline'} size={17} color={selected ? theme.colors.primary : theme.colors.icon} />
                <Text style={[styles.optionText, { color: selected ? theme.colors.primary : theme.colors.text, fontFamily: selected ? typography.bold : typography.medium }]}>{option}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }

  if (['DATE', 'FECHA'].includes(tipo)) {
    return (
      <View style={styles.formGroup}>
        <Text style={[styles.inputLabel, { color: theme.colors.text, fontFamily: typography.semibold }]}>{field.etiqueta}{field.requerido ? ' *' : ''}</Text>
        {renderFecha({
          pickerKey: `dynamic-${field.id}`,
          label: field.etiqueta,
          value,
          onSelect: onChange,
          required: field.requerido,
        })}
      </View>
    );
  }

  if (tipo === 'ARCHIVO') {
    const fileValue = value;
    const isImageFile = String(fileValue?.mimeType || '').startsWith('image/');
    return (
      <View style={styles.formGroup}>
        <Text style={[styles.inputLabel, { color: theme.colors.text, fontFamily: typography.semibold }]}>
          {field.etiqueta}{field.requerido ? ' *' : ''}
        </Text>
        {fileValue?.uri || fileValue?.dataUri ? (
          <View style={[styles.dynamicImageBox, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt }]}>
            {isImageFile ? (
              <TouchableOpacity activeOpacity={0.86} onPress={() => onVerArchivo(field)} style={styles.dynamicImagePreviewWrap}>
                <Image source={{ uri: fileValue.uri || fileValue.dataUri }} style={styles.dynamicImagePreview} resizeMode="cover" />
              </TouchableOpacity>
            ) : (
              <View style={styles.dynamicImagePreviewWrap}>
                <Ionicons name="document-text-outline" size={42} color={theme.colors.icon} />
                <Text style={[styles.filePlaceholderText, { color: theme.colors.text, fontFamily: typography.medium }]} numberOfLines={2}>
                  {fileValue.fileName || 'Documento adjunto'}
                </Text>
              </View>
            )}
            <View style={styles.dynamicImageActions}>
              <TouchableOpacity onPress={() => onAbrirArchivo(field)} style={[styles.dynamicImageAction, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
                <Ionicons name="swap-horizontal-outline" size={16} color={theme.colors.text} />
                <Text style={[styles.dynamicImageActionText, { color: theme.colors.text, fontFamily: typography.bold }]}>CAMBIAR</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => onQuitarArchivo(field)} style={[styles.dynamicImageAction, styles.dynamicImageDeleteAction, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface }]}>
                <Ionicons name="trash-outline" size={16} color={theme.colors.danger} />
              </TouchableOpacity>
            </View>
          </View>
        ) : (
          <TouchableOpacity
            activeOpacity={0.86}
            onPress={() => onAbrirArchivo(field)}
            style={[styles.filePlaceholder, { borderColor: theme.colors.border, backgroundColor: theme.colors.surfaceAlt }]}
          >
            <Ionicons name="image-outline" size={24} color={theme.colors.icon} />
            <Text style={[styles.filePlaceholderText, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>
              Tocar para sacar una foto o elegir un archivo
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }

  return (
    <View style={styles.formGroup}>
      <Text style={[styles.inputLabel, { color: theme.colors.text, fontFamily: typography.semibold }]}>
        {field.etiqueta}{field.requerido ? ' *' : ''}
      </Text>
      <TextInput
        value={String(value ?? '')}
        onChangeText={onChange}
        multiline={!isInteger && !isEmail && (tipo === 'TEXTAREA' || isObservationField)}
        maxLength={isDni ? 8 : undefined}
        keyboardType={isEmail ? 'email-address' : isInteger || isDni ? 'numeric' : 'default'}
        inputMode={isEmail ? 'email' : isInteger || isDni ? 'numeric' : 'text'}
        autoCapitalize={isEmail ? 'none' : 'sentences'}
        autoCorrect={!isEmail}
        accessibilityLabel={field.etiqueta || field.texto}
        accessibilityHint={isEmail ? 'Ingresá un correo electrónico, por ejemplo nombre@dominio.com.' : isInteger ? 'Ingresá un número entero, sin letras ni decimales.' : 'Ingresá texto.'}
        aria-invalid={Boolean(fieldError)}
        style={[
          styles.textInput,
          !isInteger && !isEmail && (tipo === 'TEXTAREA' || isObservationField) && styles.textArea,
          { color: theme.colors.text, borderColor: fieldError ? theme.colors.danger : theme.colors.border, backgroundColor: theme.colors.surface },
        ]}
        placeholderTextColor={theme.colors.textSoft}
        placeholder={isEmail ? 'nombre@dominio.com' : isInteger ? 'Ej.: 12' : 'Ingresá texto'}
      />
      <Text accessibilityRole={fieldError ? 'alert' : undefined}
        style={{ color: fieldError ? theme.colors.danger : theme.colors.textSoft, fontFamily: typography.medium, fontSize: fontSizes.xs }}>
        {fieldError || (isEmail ? 'Correo electrónico. Ej.: nombre@dominio.com' : isInteger ? 'Número entero, sin letras ni decimales.' : 'Texto.')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  formGroup: {
    marginBottom: 14,
  },
  inputLabel: {
    fontSize: fontSizes.sm,
    marginBottom: 7,
  },
  identityReadOnlyBox: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    justifyContent: 'center',
  },
  identityReadOnlyText: {
    fontSize: fontSizes.sm,
  },
  textInput: {
    minHeight: 46,
    borderWidth: 1,
    borderRadius: radii.lg,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: fontSizes.sm,
  },
  textArea: {
    minHeight: 96,
    textAlignVertical: 'top',
  },
  optionWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionChip: {
    borderWidth: 1,
    borderRadius: radii.full,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  optionText: {
    fontSize: fontSizes.xs,
  },
  dynamicImageBox: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: 8,
  },
  dynamicImagePreviewWrap: {
    width: '100%',
    aspectRatio: 4 / 3,
    borderRadius: radii.md,
    overflow: 'hidden',
  },
  dynamicImagePreview: {
    width: '100%',
    height: '100%',
  },
  filePlaceholder: {
    minHeight: 74,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
  },
  filePlaceholderText: {
    fontSize: fontSizes.xs,
    marginTop: 6,
    textAlign: 'center',
  },
  dynamicImageActions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
  },
  dynamicImageAction: {
    flex: 1,
    minHeight: 34,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: 10,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
  },
  dynamicImageDeleteAction: {
    flex: 0,
    width: 44,
    paddingHorizontal: 0,
  },
  dynamicImageActionText: {
    fontSize: fontSizes.xxs,
    marginLeft: 6,
  },
});
