/** A valid ISBN-13 for either ISBN format, or an empty string for other identifiers. */
export function canonicalIsbn(value: unknown): string {
  if (typeof value !== "string") return "";
  const digits = value.normalize("NFKC").trim().replace(/^isbn(?:-1[03])?\s*:?\s*/i, "")
    .replace(/[\s\p{Pd}]/gu, "").toUpperCase();
  let stem: string;
  if (/^\d{9}[\dX]$/.test(digits)) {
    const sum = [...digits].reduce((total, digit, i) => total + (10 - i) * (digit === "X" ? 10 : Number(digit)), 0);
    if (sum % 11 !== 0) return "";
    stem = "978" + digits.slice(0, 9);
  } else if (/^97[89]\d{10}$/.test(digits)) {
    stem = digits.slice(0, 12);
  } else {
    return "";
  }
  const sum = [...stem].reduce((total, digit, i) => total + Number(digit) * (i % 2 === 0 ? 1 : 3), 0);
  const isbn = stem + ((10 - sum % 10) % 10);
  return digits.length === 10 || digits === isbn ? isbn : "";
}
