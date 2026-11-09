import { useCallback, useEffect, useRef, useState } from 'react';

export function usePolling<T>(loader: () => Promise<T>, intervalMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const result = await loaderRef.current();
      setData(result);
      setError(null);
    } catch (cause) {
      setError(cause as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    if (!intervalMs) return;
    const timer = window.setInterval(() => void reload(true), intervalMs);
    return () => window.clearInterval(timer);
  }, [reload, intervalMs]);

  return { data, error, loading, reload };
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = `${title} · OpsWeave`;
  }, [title]);
}
