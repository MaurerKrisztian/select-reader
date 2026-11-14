import assert from "node:assert/strict";
import { test } from "node:test";
import { applyPronunciations } from "./pronunciations.js";

test("replaces whole words, ignoring case", () => {
  const list = [{ from: "kubectl", to: "cube control" }];
  assert.equal(applyPronunciations("Run Kubectl, then kubectl.", list), "Run cube control, then cube control.");
});

test("leaves the word alone inside longer words", () => {
  const list = [{ from: "SQL", to: "sequel" }];
  assert.equal(applyPronunciations("SQL and MySQL and SQL_x", list), "sequel and MySQL and SQL_x");
});

test("handles words with symbols, and $ in the replacement", () => {
  const list = [
    { from: "C++", to: "C plus plus" },
    { from: "USD", to: "$ dollars $1" },
  ];
  assert.equal(applyPronunciations("I like C++ (and USD).", list), "I like C plus plus (and $ dollars $1).");
});

test("an empty replacement skips the word", () => {
  assert.equal(applyPronunciations("Water[1] is wet.", [{ from: "[1]", to: "" }]), "Water is wet.");
});

test("works with letters outside English", () => {
  assert.equal(applyPronunciations("Árvíztűrő tükörfúrógép", [{ from: "árvíztűrő", to: "flood-proof" }]), "flood-proof tükörfúrógép");
});
