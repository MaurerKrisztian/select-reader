// Types shared by the main process, the window and the speech worker.

/** Kokoro produces 24 kHz mono audio. */
export const SAMPLE_RATE = 24_000;

/** A word the voice says wrong, and what to say instead ("" skips the word). */
export interface Pronunciation {
  from: string;
  to: string;
}

/**
 * Saved in config.json. The key names match the old Python version of the app,
 * so its settings carry over.
 */
export interface Settings {
  kokoro_voice: string;
  /** 1 is normal speed. */
  speed: number;
  /** From 0 (silent) to 1 (full volume). */
  volume: number;
  /** Reads the selected text. Electron accelerator, e.g. "Ctrl+Shift+C". */
  shortcut: string;
  /** Pauses or resumes reading. "" when not set. */
  pause_shortcut: string;
  /** Stops reading. "" when not set. */
  stop_shortcut: string;
  /** Start speaking after the first few sentences instead of waiting for the whole text. */
  stream_chunks: boolean;
  first_chunk_sentences: number;
  next_chunk_sentences: number;
  pronunciations: Pronunciation[];
}

/** The settings that hold a global shortcut. */
export type ShortcutSetting = "shortcut" | "pause_shortcut" | "stop_shortcut";

export type ReaderState = "idle" | "reading" | "paused";

/** Whether the Kokoro voice model is ready to speak. */
export interface EngineStatus {
  state: "loading" | "ready" | "error";
  message: string;
  /** 0–100 while the model is downloading. */
  progress?: number;
}

export interface AppInfo {
  settings: Settings;
  engine: EngineStatus;
  /** Set when a shortcut could not be registered. */
  shortcutError?: string;
  /** Whether Select Reader starts when the user logs in. */
  startOnLogin: boolean;
  /** Texts read recently, newest first. Kept until the app quits. */
  history: string[];
  platform: string;
  /** Linux on Wayland, where global shortcuts and reading the selection are limited. */
  wayland: boolean;
}

export interface ShortcutResult {
  settings: Settings;
  error?: string;
}

/** What the preload script gives the window as `window.selectReader`. */
export interface SelectReaderApi {
  getAppInfo(): Promise<AppInfo>;
  updateSettings(changes: Partial<Settings>): Promise<Settings>;
  /** Sets a global shortcut. "" turns the pause or stop shortcut off. */
  setShortcut(setting: ShortcutSetting, shortcut: string): Promise<ShortcutResult>;
  /** Turns the global shortcuts off while the user records a new one. */
  pauseShortcut(paused: boolean): void;
  /** Turns starting at login on or off. Returns whether it is on now. */
  setStartOnLogin(enabled: boolean): Promise<boolean>;
  /** Turns text into audio samples, or null if it was cancelled or failed. */
  synthesize(text: string, voice: string, speed: number): Promise<Float32Array | null>;
  /** Drops speech that is still being generated. */
  cancelSpeech(): void;
  /** Asks where to save the audio of `text`. Returns the file name, or null if the user cancelled. */
  beginAudioFile(text: string): Promise<string | null>;
  /** Adds audio to the end of the file. */
  writeAudio(samples: Float32Array): Promise<void>;
  /** Finishes the audio file, or deletes it if `keep` is false. */
  endAudioFile(keep: boolean): Promise<void>;
  /** Asks the main process to read some text (pasted text, or a recent one). */
  readText(text: string): void;
  clearHistory(): void;
  reportState(state: ReaderState): void;
  /** Tells the main process the window is set up and can receive "read" messages. */
  windowReady(): void;
  quit(): void;

  onRead(callback: (text: string) => void): void;
  onStop(callback: () => void): void;
  onTogglePause(callback: () => void): void;
  onEngineStatus(callback: (status: EngineStatus) => void): void;
  onNotice(callback: (message: string) => void): void;
  onHistory(callback: (history: string[]) => void): void;
}

/** Messages from the main process to the Kokoro worker. */
export type WorkerRequest =
  | { type: "synthesize"; id: number; text: string; voice: string; speed: number }
  | { type: "cancel" };

/** Messages from the Kokoro worker to the main process. */
export type WorkerReply =
  | { type: "status"; status: EngineStatus }
  | { type: "audio"; id: number; samples: Float32Array }
  | { type: "failed"; id: number; message: string };
