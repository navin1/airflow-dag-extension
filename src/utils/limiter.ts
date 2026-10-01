/**
 * Minimal async concurrency limiter. The batch optimizer uses one per
 * expensive resource (Gemini calls, real-run BigQuery jobs) so cheap stages
 * like dry runs can run ahead for upcoming files without overloading quotas.
 */

export interface Limiter {
  run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}

export function createLimiter(max: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = () => {
    active--;
    waiting.shift()?.();
  };

  const acquire = (signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (active < max) { active++; resolve(); return; }
    const grant = () => {
      signal?.removeEventListener('abort', onAbort);
      active++;
      resolve();
    };
    const onAbort = () => {
      const i = waiting.indexOf(grant);
      if (i >= 0) waiting.splice(i, 1);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    waiting.push(grant);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  return {
    async run(fn, signal) {
      await acquire(signal);
      try { return await fn(); } finally { release(); }
    },
  };
}
