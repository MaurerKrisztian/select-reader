import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import type { Settings } from "../shared/types.js";
import { DEFAULT_VOICE, VOICES } from "../shared/voices.js";

export const DEFAULT_SETTINGS: Settings = {
  kokoro_voice: DEFAULT_VOICE,
  speed: 1,
  shortcut: "Ctrl+Shift+C",
  stream_chunks: true,
  first_chunk_sentences: 1,
  next_chunk_sentences: 3,
};

/**
 * ~/.config/select-reader/config.json on Linux (the same file the old Python version
 * used, so settings carry over), %APPDATA%\select-reader\config.json on Windows.
 */
function settingsFile(): string {
  return path.join(app.getPath("appData"), "select-reader", "config.json");
}

function readSettingsFile(): Record<string, unknown> {
  try {
    const data = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return typeof data === "object" && data !== null ? data : {};
  } catch {
    return {};
  }
}

export function loadSettings(): Settings {
  const saved = readSettingsFile();
  const settings = { ...DEFAULT_SETTINGS };
  // Use a saved value only if it has the right type.
  for (const key of Object.keys(settings) as (keyof Settings)[]) {
    if (typeof saved[key] === typeof settings[key]) {
      Object.assign(settings, { [key]: saved[key] });
    }
  }
  return cleanSettings(settings);
}

export function saveSettings(settings: Settings): void {
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Keep keys we don't know about instead of deleting them.
  const data = { ...readSettingsFile(), ...settings };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Fixes values that are out of range. */
export function cleanSettings(settings: Settings): Settings {
  return {
    ...settings,
    kokoro_voice: VOICES.includes(settings.kokoro_voice) ? settings.kokoro_voice : DEFAULT_VOICE,
    speed: clamp(settings.speed, 0.5, 2, 1),
    first_chunk_sentences: Math.round(clamp(settings.first_chunk_sentences, 1, 4, 1)),
    next_chunk_sentences: Math.round(clamp(settings.next_chunk_sentences, 1, 8, 3)),
  };
}

function clamp(value: number, min: number, max: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
