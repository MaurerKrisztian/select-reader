// The main process: owns the window, the tray icon, the global shortcuts and the
// speech worker. The window (src/renderer) plays the audio; this file decides what to read.

import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Notification } from "electron";
import path from "node:path";
import { applyPronunciations } from "../shared/pronunciations.js";
import { SAMPLE_RATE, type ReaderState, type Settings, type ShortcutSetting } from "../shared/types.js";
import { isStartOnLogin, setStartOnLogin, wasStartedByLoginItem } from "./autostart.js";
import { parseCommand, USAGE, type Command } from "./cli.js";
import { startHttpServer } from "./http-server.js";
import { getSelectedText } from "./selection.js";
import { cleanSettings, loadSettings, saveSettings } from "./settings.js";
import { SpeechEngine } from "./speech.js";
import { cleanText } from "./text.js";
import { AppTray } from "./tray.js";
import { WavFile } from "./wav.js";

const DIST = path.join(import.meta.dirname, "..");
const ICON = path.join(app.getAppPath(), "assets", "icon.png");
/** How many recently read texts to remember (until the app quits). */
const HISTORY_SIZE = 10;

let settings: Settings;
let window: BrowserWindow;
let tray: AppTray;
let speech: SpeechEngine;
let shortcutError: string | undefined;
let readerState: ReaderState = "idle";
let lastText = "";
let history: string[] = [];
let pendingText = ""; // text to read once the window has loaded
let windowReady = false;
let quitting = false;
let audioFile: WavFile | null = null;

// ---------------------------------------------------------------------------
// Startup

const command = parseCommand(process.argv.slice(1));

if (command === "help") {
  console.log(USAGE);
  process.exit(0);
}

// Only one Select Reader runs at a time. Starting it again, for example with
// `select-reader --read` from a desktop shortcut, passes the command to the running
// app (the "second-instance" event below) and exits.
if (!app.requestSingleInstanceLock(command)) {
  console.log("Sent to the running Select Reader.");
  app.quit();
} else if (command.type === "stop" || command.type === "toggle-pause") {
  console.log("Select Reader is not running.");
  app.quit();
} else if (restartOnX11()) {
  app.releaseSingleInstanceLock(); // so the restarted app can take it
  app.exit(0);
} else {
  app.on("second-instance", (_event, _argv, _cwd, data) => runCommand(data as Command));
  app.on("before-quit", () => (quitting = true));
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    speech?.stop();
    audioFile?.discard();
  });
  app.whenReady().then(() => start(command));
}

/**
 * On Wayland desktops, starts again through XWayland (X11) when it's there, and returns
 * true. Wayland only lets the app that has the keyboard focus read the selection, so a
 * native Wayland window never sees what was selected in another app; the desktop does
 * share it with X11 apps. Electron picks Wayland or X11 before this file runs, so
 * switching takes a restart with --ozone-platform=x11.
 */
function restartOnX11(): boolean {
  const onWayland = process.platform === "linux" && !!process.env.WAYLAND_DISPLAY;
  // process.argv, not app.commandLine: Electron adds the platform it picked to the latter.
  const platformChosen = process.argv.some((arg) => arg.startsWith("--ozone-platform"));
  if (!onWayland || !process.env.DISPLAY || platformChosen) return false;
  app.relaunch({
    // An AppImage's files go away when it exits: start the .AppImage file itself.
    execPath: process.env.APPIMAGE ?? process.execPath,
    args: [...process.argv.slice(1), "--ozone-platform=x11"],
  });
  return true;
}

async function start(command: Command): Promise<void> {
  settings = loadSettings();

  // Grab the selection before our window opens and takes the focus from the other app.
  if (command.type === "read-selection") pendingText = (await getSelectedText()).text;
  if (command.type === "read-text") pendingText = cleanText(command.text);

  speech = new SpeechEngine(path.join(DIST, "worker", "kokoro-worker.js"), (status) => {
    send("engine-status", status);
  });
  // Started at login: wait in the tray without opening the window.
  const hidden = (command.type === "open" && command.hidden) || wasStartedByLoginItem();
  window = createWindow(!hidden);
  tray = new AppTray(ICON, {
    readSelection: () => void readSelection(),
    readText,
    togglePause: () => send("toggle-pause"),
    stop: () => send("stop"),
    showWindow,
    quit: () => app.quit(),
  });
  updateTray();
  shortcutError = registerShortcuts();
  handleWindowMessages();
  startHttpServer({ read: readText, togglePause: () => send("toggle-pause"), stop: () => send("stop") });
}

function createWindow(show: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 860,
    minWidth: 440,
    minHeight: 560,
    title: "Select Reader",
    icon: ICON,
    backgroundColor: "#0b0d12",
    show: false,
    webPreferences: {
      preload: path.join(DIST, "preload", "preload.cjs"),
      // Keep reading aloud while the window is hidden.
      backgroundThrottling: false,
    },
  });
  if (process.platform !== "darwin") win.removeMenu();
  win.loadFile(path.join(DIST, "renderer", "index.html"));
  if (show) win.once("ready-to-show", () => win.show());

  // Closing the window keeps the app running in the tray, ready for the shortcut.
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}

function showWindow(): void {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function updateTray(): void {
  // A command from a second `select-reader` can arrive before the tray exists.
  tray?.update(readerState, settings, history);
}

// ---------------------------------------------------------------------------
// Reading

function runCommand(command: Command): void {
  switch (command.type) {
    case "open":
      return command.hidden ? undefined : showWindow();
    case "read-selection":
      return void readSelection();
    case "read-text":
      return readText(command.text);
    case "toggle-pause":
      return send("toggle-pause");
    case "stop":
      return send("stop");
  }
}

let busy = false;
let hintShown = false;

/** Reads the text selected in the focused app. Pressing the shortcut again on the same text stops. */
async function readSelection(): Promise<void> {
  if (busy) return;
  busy = true;
  // Our own copy key press must not trigger the shortcut again.
  globalShortcut.unregisterAll();
  try {
    const { text, hint } = await getSelectedText();
    if (!text) {
      notify(hint ?? "No text selected. Select some text, then press the shortcut.");
    } else if (readerState !== "idle" && text === lastText) {
      send("stop");
    } else {
      readText(text);
      if (hint && !hintShown) notify(hint);
      hintShown ||= !!hint;
    }
  } finally {
    registerShortcuts();
    // Holding the keys a little too long repeats the shortcut; ignore that.
    setTimeout(() => (busy = false), 400);
  }
}

function readText(text: string): void {
  const cleaned = cleanText(text);
  if (!cleaned) return;
  lastText = cleaned;
  remember(cleaned);
  if (windowReady) send("read", cleaned);
  else pendingText = cleaned;
}

/** Puts `text` at the top of the recent list. */
function remember(text: string): void {
  history = [text, ...history.filter((old) => old !== text)].slice(0, HISTORY_SIZE);
  send("history", history);
  updateTray();
}

// ---------------------------------------------------------------------------
// Global shortcuts

const SHORTCUT_ACTIONS: Record<ShortcutSetting, () => void> = {
  shortcut: () => void readSelection(),
  pause_shortcut: () => send("toggle-pause"),
  stop_shortcut: () => send("stop"),
};

const SHORTCUT_NAMES: Record<ShortcutSetting, string> = {
  shortcut: "read",
  pause_shortcut: "pause",
  stop_shortcut: "stop",
};

/** Makes the shortcuts work in every app. Returns an error message if one of them can't. */
function registerShortcuts(): string | undefined {
  globalShortcut.unregisterAll();
  const errors = Object.entries(SHORTCUT_ACTIONS).map(([setting, action]) => {
    const shortcut = settings[setting as ShortcutSetting];
    if (!shortcut) return undefined;
    try {
      if (globalShortcut.register(shortcut, action)) return undefined;
      return `${shortcut} is already used by another app. Pick a different shortcut.`;
    } catch {
      return `"${shortcut}" is not a valid shortcut. Pick a different one.`;
    }
  });
  return errors.filter(Boolean).join(" ") || undefined;
}

/** Changes one shortcut. Returns an error message, and keeps the old one, if it can't be used. */
function changeShortcut(setting: ShortcutSetting, shortcut: string): string | undefined {
  if (!(setting in SHORTCUT_ACTIONS)) return "Unknown shortcut.";
  if (!shortcut && setting === "shortcut") return "The read shortcut can't be turned off.";
  const taken = (Object.keys(SHORTCUT_ACTIONS) as ShortcutSetting[]).find(
    (other) => other !== setting && shortcut && settings[other] === shortcut,
  );
  if (taken) return `${shortcut} is already the ${SHORTCUT_NAMES[taken]} shortcut.`;

  const previous = settings[setting];
  settings = { ...settings, [setting]: shortcut };
  globalShortcut.unregisterAll();
  let error: string | undefined;
  try {
    if (shortcut && !globalShortcut.register(shortcut, SHORTCUT_ACTIONS[setting])) {
      error = `${shortcut} is already used by another app. Pick a different shortcut.`;
    }
  } catch {
    error = `"${shortcut}" is not a valid shortcut. Pick a different one.`;
  }
  if (error) settings = { ...settings, [setting]: previous };
  else saveSettings(settings);
  registerShortcuts();
  updateTray();
  return error;
}

/** Shows a message in the window, or as a desktop notification if the window is hidden. */
function notify(message: string): void {
  send("notice", message);
  if (!window.isVisible() && Notification.isSupported()) {
    new Notification({ title: "Select Reader", body: message, icon: ICON, silent: true }).show();
  }
}

// ---------------------------------------------------------------------------
// Saving audio files

/** Asks where to save the audio of `text`, and opens that file. Returns its name, or null. */
async function beginAudioFile(text: string): Promise<string | null> {
  audioFile?.discard();
  audioFile = null;
  const result = await dialog.showSaveDialog(window, {
    title: "Save as audio file",
    defaultPath: path.join(app.getPath("downloads"), `${audioFileName(text)}.wav`),
    filters: [{ name: "WAV audio", extensions: ["wav"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const file = path.extname(result.filePath) ? result.filePath : `${result.filePath}.wav`;
  audioFile = new WavFile(file, SAMPLE_RATE);
  return path.basename(file);
}

/** The first few words of the text: "Hello, world! It's…" → "Hello world It s". */
function audioFileName(text: string): string {
  const words = text.replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").slice(0, 6).join(" ");
  return words || "Select Reader";
}

// ---------------------------------------------------------------------------
// Talking to the window (see src/preload/preload.cts for the other side)

function send(channel: string, ...args: unknown[]): void {
  if (window && !window.isDestroyed()) window.webContents.send(channel, ...args);
}

function handleWindowMessages(): void {
  ipcMain.handle("app-info", () => ({
    settings,
    engine: speech.status,
    shortcutError,
    startOnLogin: isStartOnLogin(),
    history,
    platform: process.platform,
    wayland: process.platform === "linux" && process.env.XDG_SESSION_TYPE === "wayland",
  }));

  ipcMain.handle("update-settings", (_event, changes: Partial<Settings>) => {
    settings = cleanSettings({ ...settings, ...changes });
    saveSettings(settings);
    return settings;
  });

  ipcMain.handle("set-shortcut", (_event, setting: ShortcutSetting, shortcut: string) => {
    const error = changeShortcut(setting, shortcut);
    return { settings, error };
  });

  ipcMain.on("pause-shortcut", (_event, paused: boolean) => {
    if (paused) globalShortcut.unregisterAll();
    else registerShortcuts();
  });

  ipcMain.handle("set-start-on-login", (_event, enabled: boolean) => {
    try {
      setStartOnLogin(enabled);
    } catch (error) {
      console.error("Could not change starting at login:", (error as Error).message);
    }
    return isStartOnLogin();
  });

  ipcMain.handle("synthesize", (_event, text: string, voice: string, speed: number) =>
    speech.synthesize(applyPronunciations(text, settings.pronunciations), voice, speed).catch((error: Error) => {
      if (error.message !== "cancelled") console.error("Speech failed:", error.message);
      return null;
    }),
  );

  ipcMain.on("cancel-speech", () => speech.cancel());

  ipcMain.handle("begin-audio-file", (_event, text: string) => beginAudioFile(text));
  ipcMain.handle("write-audio", (_event, samples: Float32Array) => audioFile?.write(samples));
  ipcMain.handle("end-audio-file", (_event, keep: boolean) => {
    if (keep) audioFile?.finish();
    else audioFile?.discard();
    audioFile = null;
  });

  ipcMain.on("read-text", (_event, text: string) => readText(text));

  ipcMain.on("clear-history", () => {
    history = [];
    send("history", history);
    updateTray();
  });

  ipcMain.on("reader-state", (_event, state: ReaderState) => {
    readerState = state;
    updateTray();
  });

  ipcMain.on("window-ready", () => {
    windowReady = true;
    if (pendingText) readText(pendingText);
    pendingText = "";
  });

  ipcMain.on("quit", () => app.quit());
}
