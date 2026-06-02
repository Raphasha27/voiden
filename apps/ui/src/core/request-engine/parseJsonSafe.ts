import { parse, stringify, LosslessNumber } from 'lossless-json';

// Integers beyond Number.MAX_SAFE_INTEGER lose precision with JSON.parse/stringify.
// We wrap them in LosslessNumber so lossless-json's stringify can round-trip them as
// numeric literals (no quotes), while toString() still yields the full-precision string
// for template variable resolution.
function numberParser(value: string): number | LosslessNumber {
  if (/^-?\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) {
      return new LosslessNumber(value);
    }
    return n;
  }
  return Number(value);
}

export function parseJsonSafe(text: string): unknown {
  try {
    return parse(text, undefined, numberParser);
  } catch {
    return JSON.parse(text);
  }
}

export function stringifyJsonSafe(value: unknown, indent?: number): string {
  try {
    return stringify(value, undefined, indent) ?? JSON.stringify(value, null, indent);
  } catch {
    return JSON.stringify(value, null, indent);
  }
}
