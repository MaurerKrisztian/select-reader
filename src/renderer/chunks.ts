/** A piece of text to speak, with its position in the full text (for highlighting). */
export interface Chunk {
  text: string;
  start: number;
  end: number;
}

/** Longer sentences are cut at a space; Kokoro can only say so much at once. */
const MAX_SENTENCE_LENGTH = 300;

/**
 * Splits text into chunks of whole sentences: a small first chunk so speech starts
 * quickly, then bigger ones that are generated while the previous one plays.
 */
export function splitIntoChunks(text: string, firstSize: number, nextSize: number): Chunk[] {
  const sentences = splitIntoSentences(text);
  const chunks: Chunk[] = [];
  let size = firstSize;
  for (let i = 0; i < sentences.length; i += size, size = nextSize) {
    const group = sentences.slice(i, i + size);
    const start = group[0].start;
    const end = group[group.length - 1].end;
    chunks.push({ text: text.slice(start, end).replace(/\s+/g, " "), start, end });
  }
  return chunks;
}

export function splitIntoSentences(text: string): Chunk[] {
  const sentences: Chunk[] = [];
  let start = 0;
  // A sentence ends at ".", "!" or "?" followed by whitespace.
  for (const match of text.matchAll(/(?<=[.!?])\s+/g)) {
    addSentence(text, start, match.index, sentences);
    start = match.index + match[0].length;
  }
  addSentence(text, start, text.length, sentences);
  return sentences;
}

function addSentence(text: string, start: number, end: number, sentences: Chunk[]): void {
  [start, end] = trim(text, start, end);
  while (end - start > MAX_SENTENCE_LENGTH) {
    const cut = lastSpaceBefore(text, start, start + MAX_SENTENCE_LENGTH);
    const [pieceStart, pieceEnd] = trim(text, start, cut);
    sentences.push({ text: text.slice(pieceStart, pieceEnd), start: pieceStart, end: pieceEnd });
    [start, end] = trim(text, cut, end);
  }
  if (start < end) sentences.push({ text: text.slice(start, end), start, end });
}

function trim(text: string, start: number, end: number): [number, number] {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return [start, end];
}

function lastSpaceBefore(text: string, start: number, limit: number): number {
  for (let i = limit; i > start; i--) {
    if (/\s/.test(text[i])) return i;
  }
  return limit; // one very long word: cut it anyway
}
