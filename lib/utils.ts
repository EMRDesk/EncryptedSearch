export const chunk = <T,>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

export const now = (): number =>
  typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
