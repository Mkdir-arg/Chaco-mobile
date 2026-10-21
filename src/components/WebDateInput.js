import React, { useState } from 'react';
import { View } from 'react-native';
import { useTheme } from '../context/ThemeContext';

// Dates stay calendar dates: never convert through UTC (which can change the day).
export default function WebDateInput({ value, onSelect, label, required, maximumDate, style }) {
  const { theme, typography, isDark } = useTheme();
  const [focused, setFocused] = useState(false);
  const max = maximumDate instanceof Date && !Number.isNaN(maximumDate.getTime())
    ? `${maximumDate.getFullYear()}-${String(maximumDate.getMonth() + 1).padStart(2, '0')}-${String(maximumDate.getDate()).padStart(2, '0')}`
    : undefined;
  return (
    <View style={[style, { backgroundColor: theme.colors.surface,
      borderColor: focused ? theme.colors.primary : theme.colors.border, justifyContent: 'center' }]}>
      <input type="date" value={value} max={max} required={required}
        aria-label={`${label}${required ? ', obligatorio' : ''}`}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onChange={event => {
          const iso = event.target.value;
          if (!iso) { onSelect(''); return; }
          if (!event.target.validity.valid || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
          const [year, month, day] = iso.split('-');
          onSelect(`${day}/${month}/${year}`);
        }}
        style={{ width: '100%', minWidth: 0, minHeight: 24, boxSizing: 'border-box',
          border: 0, padding: 0, outline: 'none', background: 'transparent',
          color: theme.colors.text, colorScheme: isDark ? 'dark' : 'light',
          fontFamily: typography.medium, fontSize: 16 }} />
    </View>
  );
}
