import { clipboard } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const MAX_CHARS = 5000;

export interface SelectedText {
  text: string;
  /** Set when the selection couldn't be copied and the user can fix that. */
  hint?: string;
}

/** The command that presses "copy" in the focused app. */
const COPY_COMMANDS: Record<string, string[]> = {
  // Ctrl+Insert is "copy" in nearly every Linux app and, unlike Ctrl+C, it can't stop a
  // program running in a terminal. --clearmodifiers ignores the shortcut keys still held.
  linux: ["xdotool", "key", "--clearmodifiers", "ctrl+Insert"],
  win32: [
    "powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
    "(New-Object -ComObject WScript.Shell).SendKeys('^c')",
  ],
  darwin: ["osascript", "-e", 'tell application "System Events" to keystroke "c" using command down'],
};

/**
 * Returns the text the user selected in the focused app.
 *
 * Presses the app's copy shortcut and reads what lands on the clipboard. If nothing
 * does (a terminal, say), Linux can still give us the highlighted text directly: the
 * "primary selection". We don't start with that, because some apps don't update it.
 */
export async function getSelectedText(): Promise<SelectedText> {
  const linux = process.platform === "linux";
  // Read these first: copying changes both. (On Linux, writing the clipboard also
  // replaces the highlighted text.)
  const previousClipboard = await clipboard.readText();
  const highlighted = linux ? await clipboard.selection.readText() : "";

  const command = COPY_COMMANDS[process.platform] ?? COPY_COMMANDS.linux;
  if (!commandExists(command[0])) {
    return {
      text: cleanText(highlighted),
      hint: "Install xdotool so Select Reader can copy the selected text in every app: sudo apt install xdotool",
    };
  }

  const copied = await copySelection(command);
  if (copied) return { text: cleanText(copied) };

  // Nothing was copied: put things back the way they were.
  await clipboard.writeText(previousClipboard);
  if (linux) await clipboard.selection.writeText(highlighted);
  return { text: cleanText(highlighted) };
}

/**
 * Presses copy in the focused app and returns the text it copied, or "" if it copied
 * nothing. The clipboard is emptied first, so old clipboard text can't be mistaken for
 * the selection.
 */
async function copySelection([command, ...args]: string[]): Promise<string> {
  clipboard.clear();
  // Give the user a moment to let go of the shortcut keys.
  await sleep(250);
  await new Promise((resolve) => execFile(command, args, { timeout: 3000, windowsHide: true }, resolve));
  return waitForClipboardText(1000);
}

/** Waits up to `ms` milliseconds for the app to put text on the clipboard. */
async function waitForClipboardText(ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const text = await clipboard.readText();
    if (text) return text;
    await sleep(50);
  }
  return "";
}

/** Trims every line and caps very long text. */
export function cleanText(text: string): string {
  const cleaned = text
    .replaceAll("\0", " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .join("\n")
    .trim();
  return cleaned.length > MAX_CHARS ? `${cleaned.slice(0, MAX_CHARS).trimEnd()}...` : cleaned;
}

function commandExists(name: string): boolean {
  const folders = (process.env.PATH ?? "").split(path.delimiter);
  return folders.some((folder) => folder && fs.existsSync(path.join(folder, name)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
