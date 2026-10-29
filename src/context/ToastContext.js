import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './ThemeContext';
import useReduceMotion from '../hooks/useReduceMotion';
import { vibrarAviso } from '../utils/haptica';
import { shadows } from '../theme';

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

const ToastContext = createContext(null);

const TYPES = {
  error: { icon: 'alert-circle', label: 'Revisá los datos' },
  warning: { icon: 'warning', label: 'Atención' },
  success: { icon: 'checkmark-circle', label: 'Listo' },
  info: { icon: 'information-circle', label: 'Información' },
};

export function ToastProvider({ children }) {
  const { theme, typography } = useTheme();
  const [toast, setToast] = useState(null);
  const visibility = useRef(new Animated.Value(0)).current;
  const iconScale = useRef(new Animated.Value(1)).current;
  const timerRef = useRef(null);
  const reduceMotion = useReduceMotion();

  const hideToast = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    Animated.timing(visibility, { toValue: 0, duration: 150, easing: EASE_OUT, useNativeDriver: true })
      .start(() => setToast(null));
  }, [visibility]);

  const showToast = useCallback(({ message, type = 'info', title, duration = 0, actions }) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setToast({ message, type, title, actions: actions?.length ? actions : [{ text: 'OK' }] });
    visibility.setValue(0);
    Animated.timing(visibility, { toValue: 1, duration: 220, easing: EASE_OUT, useNativeDriver: true }).start();
    // El tilde de éxito entra con un rebote chico; los demás íconos aparecen quietos.
    const rebote = type === 'success' && !reduceMotion;
    iconScale.setValue(rebote ? 0.5 : 1);
    if (rebote) {
      Animated.spring(iconScale, { toValue: 1, delay: 80, damping: 9, stiffness: 240, mass: 0.7, useNativeDriver: true }).start();
    }
    vibrarAviso(type);
    if (duration > 0) timerRef.current = setTimeout(hideToast, duration);
  }, [hideToast, visibility, iconScale, reduceMotion]);

  const showAlert = useCallback((title, message, buttons = [{ text: 'OK' }]) => {
    const value = `${title || ''} ${message || ''}`.toLowerCase();
    const type = /(error|no se pudo|faltan|requerido|ya relevado|no encontr)/.test(value)
      ? 'error'
      : /(sin conex|pendiente|permiso|límite|limite|atenci)/.test(value)
        ? 'warning'
        : /(complet|iniciado|finalizado|agregad|reabierto|guardado)/.test(value)
          ? 'success'
          : 'info';
    showToast({ title, message, type, actions: buttons });
  }, [showToast]);

  useEffect(() => () => timerRef.current && clearTimeout(timerRef.current), []);

  const config = TYPES[toast?.type] || TYPES.info;
  const accent = toast?.type === 'error'
    ? theme.colors.danger
    : toast?.type === 'warning'
      ? theme.colors.warning
      : toast?.type === 'success'
        ? theme.colors.success
        : theme.colors.primary;

  return (
    <ToastContext.Provider value={{ showToast, showAlert, hideToast }}>
      {children}
      {toast ? (
        <Animated.View style={[styles.host, { opacity: visibility }]}>
          <Animated.View
            style={[
              styles.toast,
              { backgroundColor: theme.colors.surfaceRaised, borderColor: theme.colors.border, borderLeftColor: accent },
              !reduceMotion && {
                transform: [
                  { translateY: visibility.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
                  { scale: visibility.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
                ],
              },
            ]}
            accessibilityRole="alert"
          >
            <View style={styles.content}>
              <Animated.View style={[styles.icon, { backgroundColor: `${accent}18`, transform: [{ scale: iconScale }] }]}>
                <Ionicons name={config.icon} size={24} color={accent} />
              </Animated.View>
              <View style={styles.copy}>
                <Text style={[styles.title, { color: theme.colors.text, fontFamily: typography.bold }]}>
                  {toast.title || config.label}
                </Text>
                <Text style={[styles.message, { color: theme.colors.textSoft, fontFamily: typography.medium }]}>
                  {toast.message}
                </Text>
              </View>
            </View>
            <View style={styles.actions}>
              {toast.actions.map((action, index) => {
                const isCancel = action.style === 'cancel';
                const isDestructive = action.style === 'destructive';
                const buttonColor = isDestructive ? theme.colors.danger : accent;
                return (
                  <Pressable
                    key={`${action.text || 'OK'}-${index}`}
                    onPress={() => {
                      hideToast();
                      if (action.onPress) setTimeout(action.onPress, 200);
                    }}
                    style={[
                      styles.okButton,
                      isCancel
                        ? { backgroundColor: theme.colors.surfaceAlt, borderColor: theme.colors.border, borderWidth: 1 }
                        : { backgroundColor: buttonColor },
                    ]}
                    accessibilityRole="button"
                  >
                    <Text style={[styles.okText, { color: isCancel ? theme.colors.text : '#FFFFFF', fontFamily: typography.bold }]}>
                      {action.text || 'OK'}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </Animated.View>
        </Animated.View>
      ) : null}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

const styles = StyleSheet.create({
  host: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999,
    elevation: 30,
    backgroundColor: 'rgba(15, 23, 42, 0.38)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  toast: {
    width: '100%',
    maxWidth: 420,
    minHeight: 76,
    borderRadius: 18,
    borderWidth: 1,
    borderLeftWidth: 5,
    padding: 14,
    boxShadow: shadows.overlay,
  },
  content: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  copy: { flex: 1, gap: 3 },
  title: { fontSize: 14 },
  message: { fontSize: 13, lineHeight: 18 },
  actions: { marginTop: 14, flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8 },
  okButton: { minWidth: 72, borderRadius: 11, paddingVertical: 9, paddingHorizontal: 18, alignItems: 'center' },
  okText: { color: '#FFFFFF', fontSize: 13 },
});
