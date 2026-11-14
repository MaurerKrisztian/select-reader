import assert from "node:assert/strict";
import { test } from "node:test";
import { splitIntoChunks, splitIntoSentences } from "./chunks.js";

test("splits sentences and remembers where they are", () => {
  const text = "  Hello there! How are you?\nFine. ";
  const sentences = splitIntoSentences(text);
  assert.deepEqual(
    sentences.map((s) => s.text),
    ["Hello there!", "How are you?", "Fine."],
  );
  for (const sentence of sentences) {
    assert.equal(text.slice(sentence.start, sentence.end), sentence.text);
  }
});

test("first chunk is small, the rest are bigger", () => {
  const text = "One. Two. Three. Four. Five. Six.";
  const chunks = splitIntoChunks(text, 1, 3);
  assert.deepEqual(
    chunks.map((c) => c.text),
    ["One.", "Two. Three. Four.", "Five. Six."],
  );
});

test("everything in one chunk when sizes are unlimited", () => {
  const text = "One.\nTwo. Three.";
  const chunks = splitIntoChunks(text, Infinity, Infinity);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].text, "One. Two. Three.");
  assert.deepEqual([chunks[0].start, chunks[0].end], [0, text.length]);
});

test("very long sentences are cut at spaces", () => {
  const text = "word ".repeat(200).trim();
  const sentences = splitIntoSentences(text);
  assert.ok(sentences.length > 1);
  for (const sentence of sentences) {
    assert.ok(sentence.text.length <= 300);
    assert.ok(!sentence.text.startsWith(" ") && !sentence.text.endsWith(" "));
  }
  assert.equal(sentences.map((s) => s.text).join(" "), text);
});

test("empty text gives no chunks", () => {
  assert.deepEqual(splitIntoChunks("   ", 1, 3), []);
});

test("can start from the sentence a position is in", () => {
  const text = "One. Two three. Four.";
  const fromTwo = splitIntoChunks(text, 1, 3, text.indexOf("three"));
  assert.deepEqual(
    fromTwo.map((c) => c.text),
    ["Two three.", "Four."],
  );
  assert.equal(fromTwo[0].start, text.indexOf("Two"));
  assert.deepEqual(splitIntoChunks(text, 1, 3, text.length), []);
});
