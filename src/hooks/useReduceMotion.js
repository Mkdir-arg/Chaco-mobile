import { useEffect, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

// true si la persona activó «reducir movimiento» en el teléfono (o el navegador).
export default function useReduceMotion() {
    const [reduce, setReduce] = useState(false);

    useEffect(() => {
        let activo = true;
        AccessibilityInfo.isReduceMotionEnabled?.()
            .then((valor) => { if (activo) setReduce(!!valor); })
            .catch(() => {});
        const sub = AccessibilityInfo.addEventListener?.('reduceMotionChanged', (valor) => setReduce(!!valor));
        return () => {
            activo = false;
            sub?.remove?.();
        };
    }, []);

    return reduce;
}
