import { useEffect } from 'react';
import { mentionTotal } from '../store/selectors.js';
import { useApp } from '../store/store.js';

export function useDocumentTitle(): void {
  const channels = useApp((state) => state.channels);
  const total = mentionTotal(Object.values(channels));
  useEffect(() => {
    document.title = total > 0 ? `(${String(total)}) Harmony` : 'Harmony';
  }, [total]);
}
