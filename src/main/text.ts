/**
 * The most text read at once: about two hours of speech. Speaking starts after the
 * first sentence however long the text is, so this only guards against huge pastes.
 */
export const MAX_CHARS = 100_000;

/**
 * Tidies text before it's read: trims every line, puts back together words that were
 * split over two lines with a hyphen (common in text copied from PDFs), and caps very
 * long text.
 */
export function cleanText(text: string): string {
  const cleaned = text
    .replaceAll("\0", " ")
    .replaceAll("­", "") // soft hyphens: invisible places where a word may break
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    // "exam-\nple" → "example". Only when the next line goes on in lower case, so
    // "Smith-\nJones" and lists starting with "-" stay as they are.
    .replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2")
    .trim();
  return cleaned.length > MAX_CHARS ? `${cleaned.slice(0, MAX_CHARS).trimEnd()}...` : cleaned;
}
