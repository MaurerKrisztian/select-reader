import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanText, MAX_CHARS } from "./text.js";

test("trims every line", () => {
  assert.equal(cleanText("  Hello  \r\n   world \n"), "Hello\nworld");
});

test("joins words split over two lines with a hyphen", () => {
  assert.equal(cleanText("an exam-\nple of a hyphen-\n  ated word"), "an example of a hyphenated word");
});

test("keeps hyphens before a capital letter or a list", () => {
  assert.equal(cleanText("Smith-\nJones"), "Smith-\nJones");
  assert.equal(cleanText("Items:\n- one\n- two"), "Items:\n- one\n- two");
  assert.equal(cleanText("well-known"), "well-known");
});

test("drops soft hyphens", () => {
  assert.equal(cleanText("hyphen­ation"), "hyphenation");
});

test("caps very long text", () => {
  const long = "word ".repeat(MAX_CHARS);
  const cleaned = cleanText(long);
  assert.ok(cleaned.length <= MAX_CHARS + 3);
  assert.ok(cleaned.endsWith("..."));
});

test("leaves text under the cap alone", () => {
  const text = "a".repeat(20_000);
  assert.equal(cleanText(text), text);
});
