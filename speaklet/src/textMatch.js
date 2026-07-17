/**
 * Text utilities for challenge/enrollment flows: compare what the recognizer
 * heard against what the user was asked to say, tolerating case, accents,
 * punctuation, and spacing differences.
 */

/** Lowercases, strips diacritics and punctuation, and collapses whitespace. */
export function normalizeText(text, { locale = "es-ES" } = {}) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase(locale)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when both texts are non-empty and equal after normalization. */
export function textsMatch(expected, recognized, options) {
  const normalizedExpected = normalizeText(expected, options);
  return (
    normalizedExpected !== "" &&
    normalizedExpected === normalizeText(recognized, options)
  );
}

/**
 * Bag-of-words overlap (0..1): the fraction of the expected words found in
 * the recognized text, counting repeats. Order-insensitive on purpose — it
 * gates "did the user actually read the text" without failing a mostly
 * correct reading over a swapped or dropped word.
 */
export function wordOverlap(expected, recognized, options) {
  const expectedWords = normalizeText(expected, options).split(" ").filter(Boolean);
  if (expectedWords.length === 0) {
    return 0;
  }
  const bag = new Map();
  for (const word of normalizeText(recognized, options).split(" ")) {
    bag.set(word, (bag.get(word) ?? 0) + 1);
  }
  let hits = 0;
  for (const word of expectedWords) {
    const count = bag.get(word) ?? 0;
    if (count > 0) {
      hits += 1;
      bag.set(word, count - 1);
    }
  }
  return hits / expectedWords.length;
}
