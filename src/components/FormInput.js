import React, { createContext, forwardRef, useContext, useState } from 'react';
import { Platform, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';

// A grouped field owns its outer border; its input must not draw a second one.
const FieldFocusContext = createContext(null);
const hasError = (style, colors) => style.borderColor === colors.danger;

export function FormInputContainer({ style, children, ...props }) {
  const { theme } = useTheme();
  const [focused, setFocused] = useState(false);
  return <FieldFocusContext.Provider value={setFocused}>
    <View {...props} style={[style, focused && !hasError(StyleSheet.flatten(style) || {}, theme.colors)
      && { borderColor: theme.colors.primary }]}>{children}</View>
  </FieldFocusContext.Provider>;
}

const FormInput = forwardRef(({style, onFocus, onBlur, selectionColor, editable = true, readOnly = false, ...props}, ref) => {
  const { theme } = useTheme();
  const setContainerFocused = useContext(FieldFocusContext);
  const [focused, setFocused] = useState(false);
  const canEdit = editable && !readOnly;
  const inputStyle = StyleSheet.flatten(style) || {};
  const focus = focused && canEdit && !setContainerFocused && !hasError(inputStyle, theme.colors);
  return <TextInput {...props} ref={ref} editable={editable} readOnly={readOnly}
    selectionColor={selectionColor ?? theme.colors.primary}
    underlineColorAndroid="transparent"
    style={[style, Platform.OS === 'web' && {outlineStyle: 'none', fontSize: Math.max(16, Number(inputStyle.fontSize) || 16)},
      focus && {borderColor: theme.colors.primary}]}
    onFocus={event => {
      if (canEdit) {setFocused(true); setContainerFocused?.(true);}
      onFocus?.(event);
    }}
    onBlur={event => {
      setFocused(false); setContainerFocused?.(false); onBlur?.(event);
    }} />;
});
export default FormInput;
