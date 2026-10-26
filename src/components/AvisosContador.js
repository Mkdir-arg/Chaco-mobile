import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { designColors, fontSizes, radii } from '../theme';

// Globo con la cantidad de avisos sin leer. No dibuja nada si no hay.
export default function AvisosContador({ cantidad = 0, style }) {
    const { typography } = useTheme();
    if (!(cantidad > 0)) return null;
    return (
        <View
            accessibilityLabel={`${cantidad} avisos sin leer`}
            style={[styles.globo, style]}
        >
            <Text style={[styles.texto, { fontFamily: typography.bold }]}>{cantidad > 99 ? '99+' : cantidad}</Text>
        </View>
    );
}

const styles = StyleSheet.create({
    globo: {
        minWidth: 20,
        height: 20,
        paddingHorizontal: 6,
        borderRadius: radii.full,
        backgroundColor: designColors.danger,
        alignItems: 'center',
        justifyContent: 'center',
    },
    texto: {
        color: designColors.white,
        fontSize: fontSizes.xs,
        lineHeight: 15,
    },
});
