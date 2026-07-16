/**
 * WCAG 2.x relative-luminance contrast ratio between two sRGB hex colors.
 *
 * Plain words: this is the same math a browser accessibility auditor (axe-core,
 * Lighthouse) uses to decide "can most people read this text against this
 * background". `4.5:1` is the WCAG AA threshold for normal-size text.
 */
export function relativeLuminance(hex: string): number {
  const clean = hex.replace("#", "");
  const parts = clean.match(/.{2}/g);
  if (!parts || parts.length !== 3) {
    throw new Error(`relativeLuminance: expected a 6-digit hex color, got "${hex}"`);
  }
  const [r, g, b] = parts.map((h) => parseInt(h, 16) / 255) as [number, number, number];
  const linear = (v: number) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const [hi, lo] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (hi + 0.05) / (lo + 0.05);
}
