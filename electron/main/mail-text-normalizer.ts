const WINDOWS_1252_EXTENDED_BYTES = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x2c6, 0x88],
  [0x2030, 0x89],
  [0x160, 0x8a],
  [0x2039, 0x8b],
  [0x152, 0x8c],
  [0x17d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x2dc, 0x98],
  [0x2122, 0x99],
  [0x161, 0x9a],
  [0x203a, 0x9b],
  [0x153, 0x9c],
  [0x17e, 0x9e],
  [0x178, 0x9f]
]);

function countMatches(value: string, pattern: RegExp) {
  return value.match(pattern)?.length ?? 0;
}

export function mojibakeScore(value: string) {
  return (
    countMatches(value, /\uFFFD/gu) * 20 +
    countMatches(value, /[\u0080-\u009F]/gu) * 8 +
    countMatches(value, /(?:Ã|Â)[\u0080-\u00BF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]/gu) * 5 +
    countMatches(value, /â[\u0080-\u00BF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]{1,2}/gu) * 5 +
    countMatches(value, /[äåæçé][\u0080-\u00BF€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ]{2}/gu) * 5 +
    countMatches(value, /(?:ï¿½|锟斤拷)/gu) * 10
  );
}

function encodeSingleByte(value: string, windows1252: boolean) {
  const bytes: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint > 0xff) {
      const extendedByte = windows1252 ? WINDOWS_1252_EXTENDED_BYTES.get(codePoint || 0) : undefined;
      if (extendedByte === undefined) {
        return null;
      }
      bytes.push(extendedByte);
      continue;
    }

    bytes.push(codePoint);
  }
  return Buffer.from(bytes);
}

function decodeUtf8(bytes: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function repairMojibake(value: string) {
  const currentScore = mojibakeScore(value);
  if (currentScore === 0) {
    return value;
  }

  let best = value;
  let bestScore = currentScore;
  for (const windows1252 of [true, false]) {
    const encoded = encodeSingleByte(value, windows1252);
    if (!encoded) {
      continue;
    }
    const candidate = decodeUtf8(encoded);
    if (!candidate || candidate.includes("\uFFFD")) {
      continue;
    }
    const score = mojibakeScore(candidate);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

export function normalizeMailText(value: string | null | undefined) {
  const normalized = (typeof value === "string" ? value : "")
    .replace(/^\uFEFF/u, "")
    .replace(/\u0000/gu, "")
    .normalize("NFC");
  return repairMojibake(normalized).normalize("NFC");
}

export function normalizeMailContentType(value: string | null | undefined): "html" | "text" {
  const token = (typeof value === "string" ? value : "text").split(";", 1)[0].trim().toLowerCase();
  return token === "html" || token === "text/html" ? "html" : "text";
}
