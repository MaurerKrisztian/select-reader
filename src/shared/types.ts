// Types shared by the main process, the window and the speech worker.

/** Kokoro produces 24 kHz mono audio. */
export const SAMPLE_RATE = 24_000;

/**
 * Saved in config.json. The key names match the old Python version of the app,
 * so its settings carry over.
 */
export interface Settings {
  kokoro_voice: string;
  /** 1 is normal speed. */
  speed: number;
  /** Electron accelerator, e.g. "Ctrl+Shift+C". */
  shortcut: string;
  /** Start speaking after the first few sentences instead of waiting for the whole text. */
  stream_chunks: boolean;
  first_chunk_sentences: number;
  next_chunk_sentences: number;
}

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
  /** Set when the read shortcut could not be registered. */
  shortcutError?: string;
  platform: string;
}

export interface ShortcutResult {
  settings: Settings;
  error?: string;
}

/** What the preload script gives the window as `window.selectReader`. */
export interface SelectReaderApi {
  getAppInfo(): Promise<AppInfo>;
  updateSettings(changes: Partial<Settings>): Promise<Settings>;
  setShortcut(shortcut: string): Promise<ShortcutResult>;
  /** Turns the global shortcut off while the user records a new one. */
  pauseShortcut(paused: boolean): void;
  /** Turns text into audio samples, or null if it was cancelled or failed. */
  synthesize(text: string, voice: string, speed: number): Promise<Float32Array | null>;
  /** Drops speech that is still being generated. */
  cancelSpeech(): void;
  /** Asks the main process to read some text (used for pasted text). */
  readText(text: string): void;
  reportState(state: ReaderState): void;
  /** Tells the main process the window is set up and can receive "read" messages. */
  windowReady(): void;
  quit(): void;

  onRead(callback: (text: string) => void): void;
  onStop(callback: () => void): void;
  onTogglePause(callback: () => void): void;
  onEngineStatus(callback: (status: EngineStatus) => void): void;
  onNotice(callback: (message: string) => void): void;
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
