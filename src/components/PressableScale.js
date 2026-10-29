import React, { useRef } from 'react';
import { Animated, Easing, Pressable } from 'react-native';
import { motion } from '../theme';
import useReduceMotion from '../hooks/useReduceMotion';
import { vibrarSeleccion } from '../utils/haptica';

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);

// Pressable que se achica al apoyar el dedo y vuelve al soltar. La escala arranca en
// onPressIn (la respuesta se ve antes de que termine el toque). `haptic` agrega un toque
// corto al elegir; usarlo solo en selecciones (días, filtros), no en cada tarjeta.
// `containerStyle` va en la vista que escala (márgenes, flex); `style` va al Pressable.
export default function PressableScale({
    scale = motion.pressScale,
    haptic = false,
    containerStyle,
    disabled,
    onPressIn,
    onPressOut,
    onPress,
    ...props
}) {
    const valor = useRef(new Animated.Value(1)).current;
    const reduceMotion = useReduceMotion();

    const animar = (toValue, duration) => {
        if (reduceMotion) return;
        Animated.timing(valor, { toValue, duration, easing: EASE_OUT, useNativeDriver: true }).start();
    };

    return (
        <Animated.View style={[containerStyle, { transform: [{ scale: valor }] }]}>
            <Pressable
                {...props}
                disabled={disabled}
                pressRetentionOffset={{ top: 12, left: 12, right: 12, bottom: 12 }}
                onPressIn={(event) => {
                    if (!disabled) animar(scale, motion.fast - 30);
                    onPressIn?.(event);
                }}
                onPressOut={(event) => {
                    animar(1, motion.fast);
                    onPressOut?.(event);
                }}
                onPress={(event) => {
                    if (haptic) vibrarSeleccion();
                    onPress?.(event);
                }}
            />
        </Animated.View>
    );
}
