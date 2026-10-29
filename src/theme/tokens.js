export const designColors = {
    white: '#FFFFFF',
    black: '#111827',
    shadow: '#000000',
    brand: '#5059BC',
    brandStrong: '#4338CA',
    pink: '#F98DFF',
    accent: '#C8D29C',
    textHeading: '#252F40',
    textBody: '#4B5563',
    textBodySubtle: '#6B7280',
    borderBase: '#E5E7EB',
    borderDark: '#4B5563',
    bgPrimary: '#FFFFFF',
    bgSecondary: '#F9FAFB',
    bgTertiary: '#F3F4F6',
    bgQuaternary: '#E5E7EB',
    // Tintes del índigo de marca (#5059BC). Antes eran rosas del perfil viejo.
    bgBrandSofter: '#F6F7FD',
    bgBrandSoft: '#EEF0FB',
    bgBrandMedium: '#CDD1F3',
    textBrand: '#3B43A0',
    success: '#007A55',
    successSoft: '#ECFDF5',
    successMedium: '#D0FAE5',
    danger: '#C70036',
    dangerSoft: '#FEF0F2',
    dangerMedium: '#FFE4E6',
    warning: '#FF5A1F',
    warningSoft: '#FFF8F1',
    warningMedium: '#FEECDC',
    warningStrong: '#9A3412', // texto naranja legible sobre warningSoft (AA)
    disabledBg: '#F3F4F6',
    disabledText: '#9CA3AF',
    darkBgPrimary: '#030712',
    darkBgSecondary: '#111827',
    darkBgTertiary: '#1F2937',
    darkTextHeading: '#FFFFFF',
    darkTextBody: '#9CA3AF',
    darkBorder: '#1F2937',
};

export const fontSizes = {
    xxs: 8,
    xs: 12,
    sm: 14,
    base: 16,
    lg: 18,
    xl: 20,
    '2xl': 24,
    '3xl': 30,
    '4xl': 36,
    '5xl': 48,
    '6xl': 60,
};

export const radii = {
    none: 0,
    sm: 2,
    base: 4,
    md: 6,
    lg: 8,
    xl: 12,
    '2xl': 16,
    '3xl': 24,
    full: 9999,
};

export const spacing = {
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 20,
    '2xl': 24,
    '3xl': 32,
};

export const gradients = {
    brand: [designColors.brand, designColors.pink],
    buttonPrimary: [designColors.brand, designColors.pink],
    buttonPrimaryPressedOverlay: 'rgba(0, 0, 0, 0.20)',
};

// Sombras como boxShadow (iOS, Android con new arch y web). Reemplazan a shadowOpacity/elevation.
export const shadows = {
    card: '0 1px 2px rgba(30, 35, 64, 0.06), 0 4px 12px -4px rgba(30, 35, 64, 0.08)',
    raised: '0 6px 16px -6px rgba(30, 35, 64, 0.18)',
    overlay: '0 12px 28px -8px rgba(30, 35, 64, 0.28)',
};

// Duraciones en ms y resortes compartidos, para que todas las animaciones se sientan iguales.
export const motion = {
    fast: 150,
    base: 250,
    slow: 400,
    spring: { damping: 18, stiffness: 220, mass: 0.8 },
    pressScale: 0.97,
};
