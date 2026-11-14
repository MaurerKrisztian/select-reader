import type { Pronunciation } from "./types.js";

/**
 * Swaps words the voice says wrong for how they should sound, e.g. "kubectl" →
 * "cube control". Matches whole words, ignoring case.
 */
export function applyPronunciations(text: string, pronunciations: Pronunciation[]): string {
  for (const { from, to } of pronunciations) {
    if (!from) continue;
    // A whole word: no letter, digit or "_" right before or after it. Only checked at
    // ends that are themselves letters or digits, so "[1]" in "Water[1]" still matches.
    const before = isWordCharacter(from[0]) ? `(?<!${WORD_CHARACTER})` : "";
    const after = isWordCharacter(from.at(-1)!) ? `(?!${WORD_CHARACTER})` : "";
    const word = new RegExp(before + escapeRegExp(from) + after, "giu");
    text = text.replace(word, () => to); // a function, so "$" in `to` is kept as is
  }
  return text;
}

const WORD_CHARACTER = "[\\p{L}\\p{N}_]";

function isWordCharacter(character: string): boolean {
  return new RegExp(WORD_CHARACTER, "u").test(character);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
