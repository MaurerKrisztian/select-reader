import assert from "node:assert/strict";
import { test } from "node:test";
import { isUsableShortcut, shortcutFromKeyPress, type KeyPress } from "./keys.js";

const press = (key: string, code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  key,
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test("builds shortcuts with modifiers in a fixed order", () => {
  assert.equal(shortcutFromKeyPress(press("C", "KeyC", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+C");
  assert.equal(shortcutFromKeyPress(press(" ", "Space", { altKey: true })), "Alt+Space");
  assert.equal(shortcutFromKeyPress(press("r", "KeyR", { metaKey: true })), "Super+R");
  assert.equal(shortcutFromKeyPress(press("F8", "F8")), "F8");
});

test("waits while only modifiers are held", () => {
  assert.equal(shortcutFromKeyPress(press("Control", "ControlLeft", { ctrlKey: true })), null);
  assert.equal(shortcutFromKeyPress(press("Shift", "ShiftLeft", { shiftKey: true, ctrlKey: true })), null);
});

test("uses the letter from the keyboard layout", () => {
  // On a German/Hungarian keyboard the key in the QWERTY "Z" spot types "y".
  assert.equal(shortcutFromKeyPress(press("y", "KeyZ", { ctrlKey: true })), "Ctrl+Y");
});

test("digits stay digits with Shift", () => {
  assert.equal(shortcutFromKeyPress(press("!", "Digit1", { ctrlKey: true, shiftKey: true })), "Ctrl+Shift+1");
});

test("rejects shortcuts that would block typing", () => {
  assert.equal(isUsableShortcut("Ctrl+Shift+C"), true);
  assert.equal(isUsableShortcut("Super+R"), true);
  assert.equal(isUsableShortcut("F8"), true);
  assert.equal(isUsableShortcut("Shift+A"), false);
  assert.equal(isUsableShortcut("A"), false);
});
