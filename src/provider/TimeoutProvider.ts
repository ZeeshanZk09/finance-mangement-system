// lib/customTimeout.ts
export type ManagedTimerId = number | { [Symbol.toPrimitive]: () => number };

export type TimeoutCallback = () => void;

export type TimeoutProvider<TTimerId extends ManagedTimerId = ManagedTimerId> = {
  setTimeout: (callback: TimeoutCallback, delay: number) => TTimerId;
  clearTimeout: (id: TTimerId | undefined) => void;

  setInterval: (callback: TimeoutCallback, delay: number) => TTimerId;
  clearInterval: (id: TTimerId | undefined) => void;
};

// ✅ Custom provider (example: logs + uses real timers)
export const CustomTimeoutProvider: TimeoutProvider<number> = {
  setTimeout: (cb, delay) => {
    console.log(`⏱ Custom setTimeout: ${delay}ms`);
    return window.setTimeout(cb, delay);
  },
  clearTimeout: (id) => id !== undefined && window.clearTimeout(id),

  setInterval: (cb, delay) => {
    console.log(`⏱ Custom setInterval: ${delay}ms`);
    return window.setInterval(cb, delay);
  },
  clearInterval: (id) => id !== undefined && window.clearInterval(id),
};
