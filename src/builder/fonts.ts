/** Find a Google Fonts CSS2 family parameter that actually works (axis support differs per font). */
export async function resolveFontParam(family: string): Promise<string | null> {
  const name = family.trim().replace(/\s+/g, "+");
  if (!/^[A-Za-z0-9+]+$/.test(name)) return null;
  const candidates = [
    `${name}:ital,wght@0,100..900;1,100..900`,
    `${name}:wght@100..900`,
    `${name}:ital,wght@0,400;0,700;1,400;1,700`,
    `${name}:wght@400;700`,
    name,
  ];
  for (const c of candidates) {
    try {
      const r = await fetch(`https://fonts.googleapis.com/css2?family=${c}&display=swap`, { signal: AbortSignal.timeout(8000) });
      if (r.ok) return c;
    } catch {
      return name; // offline or blocked: can't verify, assume it exists
    }
  }
  return null;
}

export const fontsUrl = (params: string[]) =>
  `https://fonts.googleapis.com/css2?${params.map((p) => `family=${p}`).join("&")}&display=swap`;
