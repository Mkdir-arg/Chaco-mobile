import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { nextAssignmentRefreshMs } from '../utils/dates';

export default function useAssignmentClock(assignments) {
  const [now, setNow] = useState(() => new Date());
  const scheduleKey = assignments.map((item) => `${item.fecha_asignada}/${item.fecha_hasta}`).join('|');
  useEffect(() => { setNow(new Date()); }, [scheduleKey]);
  useEffect(() => {
    const refresh = () => setNow(new Date());
    const timer = setTimeout(refresh, nextAssignmentRefreshMs(assignments, new Date()));
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh();
    });
    return () => { clearTimeout(timer); subscription.remove(); };
  }, [scheduleKey, now]);
  return now;
}
