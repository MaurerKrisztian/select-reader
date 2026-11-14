/** The parts of a keyboard event we need (a KeyboardEvent has all of them). */
export interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "AltGraph", "Meta", "OS", "Super", "Hyper"]);

/** Key names that Electron understands, by KeyboardEvent.key. */
const NAMED_KEYS: Record<string, string> = {
  " ": "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

/**
 * Turns a key press into a shortcut such as "Ctrl+Shift+C".
 * Returns null while only modifier keys are held, or for keys we don't support.
 */
export function shortcutFromKeyPress(press: KeyPress): string | null {
  if (MODIFIER_KEYS.has(press.key)) return null;
  const key = keyName(press);
  if (!key) return null;

  const parts: string[] = [];
  if (press.ctrlKey) parts.push("Ctrl");
  if (press.altKey) parts.push("Alt");
  if (press.shiftKey) parts.push("Shift");
  if (press.metaKey) parts.push("Super");
  parts.push(key);
  return parts.join("+");
}

function keyName({ key, code }: KeyPress): string | null {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase(); // follows the keyboard layout
  if (/^Digit\d$/.test(code)) return code.slice(5); // "1" even when Shift turns it into "!"
  if (/^Key[A-Z]$/.test(code)) return code.slice(3); // a letter that Alt turned into a symbol
  if (/^F\d{1,2}$/.test(key)) return key;
  return NAMED_KEYS[key] ?? null;
}

/**
 * A shortcut needs Ctrl, Alt or Super (or must be a function key), otherwise it
 * would block normal typing in every app.
 */
export function isUsableShortcut(shortcut: string): boolean {
  const parts = shortcut.split("+");
  const key = parts[parts.length - 1];
  return /^F\d{1,2}$/.test(key) || parts.some((part) => ["Ctrl", "Alt", "Super"].includes(part));
}
