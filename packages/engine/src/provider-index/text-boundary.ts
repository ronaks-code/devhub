export const MAX_PROVIDER_INDEX_EVENT_JSON_CHARS = 8_388_608;

/**
 * Count SQLite TEXT characters without allocating UTF-8 storage.
 * SQLite length(TEXT) counts Unicode code points, while JavaScript length counts UTF-16 units.
 * A null result means either the bound was exceeded or the UTF-16 input was not canonical.
 */
export function sqliteTextLengthAtMost(value: string, maximum: number): number | null {
  if (!Number.isSafeInteger(maximum) || maximum < 0) return null;
  let count = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return null;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return null;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return null;
    }
    count += 1;
    if (count > maximum) return null;
  }
  return count;
}

export function hasCanonicalUnicode(value: string): boolean {
  return sqliteTextLengthAtMost(value, Number.MAX_SAFE_INTEGER) !== null;
}
