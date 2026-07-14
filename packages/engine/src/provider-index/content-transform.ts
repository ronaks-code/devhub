export const EVENT_PROJECTION_ERROR = "provider event could not be safely projected";
export const HOME_REPLACEMENT = "[PROVIDER_HOME]";

export type ContentTransform = (value: string, providerHome: string) => string;

export function contentEscapeSentinel(providerHome: string): string {
  const unavailable = new Set<string>();
  for (let index = 0; index < providerHome.length; index += 1) {
    unavailable.add(providerHome[index]!);
  }
  for (let index = 0; index < HOME_REPLACEMENT.length; index += 1) {
    unavailable.add(HOME_REPLACEMENT[index]!);
  }
  const ranges = [
    [0xe000, 0xf8ff],
    [0x00a1, 0xd7ff],
    [0xf900, 0xfffd],
  ] as const;
  for (const [start, end] of ranges) {
    for (let codeUnit = start; codeUnit <= end; codeUnit += 1) {
      const candidate = String.fromCharCode(codeUnit);
      if (!unavailable.has(candidate)) return candidate;
    }
  }
  throw new TypeError(EVENT_PROJECTION_ERROR);
}

export function readableContentString(value: string, providerHome: string): string {
  const first = value.indexOf(providerHome);
  if (first < 0) return value;
  let projected = "";
  let cursor = 0;
  let match = first;
  while (match >= 0) {
    projected += `${value.slice(cursor, match)}${HOME_REPLACEMENT}`;
    cursor = match + providerHome.length;
    match = value.indexOf(providerHome, cursor);
  }
  return `${projected}${value.slice(cursor)}`;
}

export function injectiveContentString(value: string, providerHome: string): string {
  const sentinel = contentEscapeSentinel(providerHome);
  // Prefix-decodable tokens: home -> marker, literal marker -> S1, literal S -> S0.
  let projected = "";
  let index = 0;
  while (index < value.length) {
    if (value.startsWith(providerHome, index)) {
      projected += HOME_REPLACEMENT;
      index += providerHome.length;
    } else if (value.startsWith(HOME_REPLACEMENT, index)) {
      projected += `${sentinel}1`;
      index += HOME_REPLACEMENT.length;
    } else if (value[index] === sentinel) {
      projected += `${sentinel}0`;
      index += 1;
    } else {
      projected += value[index]!;
      index += 1;
    }
  }
  return projected;
}
