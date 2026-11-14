// The main process: owns the window, the tray icon, the global shortcut and the
// speech worker. The window (src/renderer) plays the audio; this file decides what to read.

import { app, BrowserWindow, globalShortcut, ipcMain, Notification } from "electron";
import path from "node:path";
import type { ReaderState, Settings } from "../shared/types.js";
import { parseCommand, USAGE, type Command } from "./cli.js";
import { startHttpServer } from "./http-server.js";
import { cleanText, getSelectedText } from "./selection.js";
import { cleanSettings, loadSettings, saveSettings } from "./settings.js";
import { SpeechEngine } from "./speech.js";
import { AppTray } from "./tray.js";

const DIST = path.join(import.meta.dirname, "..");
const ICON = path.join(app.getAppPath(), "assets", "icon.png");

let settings: Settings;
let window: BrowserWindow;
let tray: AppTray;
let speech: SpeechEngine;
let shortcutError: string | undefined;
let readerState: ReaderState = "idle";
let lastText = "";
let pendingText = ""; // text to read once the window has loaded
let windowReady = false;
let quitting = false;

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
} else {
  app.on("second-instance", (_event, _argv, _cwd, data) => runCommand(data as Command));
  app.on("before-quit", () => (quitting = true));
  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    speech?.stop();
  });
  app.whenReady().then(() => start(command));
}

async function start(command: Command): Promise<void> {
  settings = loadSettings();

  // Grab the selection before our window opens and takes the focus from the other app.
  if (command.type === "read-selection") pendingText = (await getSelectedText()).text;
  if (command.type === "read-text") pendingText = cleanText(command.text);

  speech = new SpeechEngine(path.join(DIST, "worker", "kokoro-worker.js"), (status) => {
    send("engine-status", status);
  });
  window = createWindow();
  tray = new AppTray(ICON, {
    readSelection: () => void readSelection(),
    togglePause: () => send("toggle-pause"),
    stop: () => send("stop"),
    showWindow,
    quit: () => app.quit(),
  });
  tray.update(readerState, settings.shortcut);
  shortcutError = registerShortcut();
  handleWindowMessages();
  startHttpServer({ read: readText, stop: () => send("stop") });
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 560,
    height: 800,
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
  win.once("ready-to-show", () => win.show());

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

// ---------------------------------------------------------------------------
// Reading

function runCommand(command: Command): void {
  switch (command.type) {
    case "open":
      return showWindow();
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
    registerShortcut();
    // Holding the keys a little too long repeats the shortcut; ignore that.
    setTimeout(() => (busy = false), 400);
  }
}

function readText(text: string): void {
  const cleaned = cleanText(text);
  if (!cleaned) return;
  lastText = cleaned;
  if (windowReady) send("read", cleaned);
  else pendingText = cleaned;
}

/** Makes the read shortcut work in every app. Returns an error message if it can't. */
function registerShortcut(): string | undefined {
  globalShortcut.unregisterAll();
  try {
    if (globalShortcut.register(settings.shortcut, () => void readSelection())) return undefined;
    return `${settings.shortcut} is already used by another app. Pick a different shortcut.`;
  } catch {
    return `"${settings.shortcut}" is not a valid shortcut. Pick a different one.`;
  }
}

/** Shows a message in the window, or as a desktop notification if the window is hidden. */
function notify(message: string): void {
  send("notice", message);
  if (!window.isVisible() && Notification.isSupported()) {
    new Notification({ title: "Select Reader", body: message, icon: ICON, silent: true }).show();
  }
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
    platform: process.platform,
  }));

  ipcMain.handle("update-settings", (_event, changes: Partial<Settings>) => {
    settings = cleanSettings({ ...settings, ...changes });
    saveSettings(settings);
    return settings;
  });

  ipcMain.handle("set-shortcut", (_event, shortcut: string) => {
    const previous = settings.shortcut;
    settings = { ...settings, shortcut };
    const error = registerShortcut();
    if (error) {
      settings = { ...settings, shortcut: previous };
      registerShortcut();
    } else {
      saveSettings(settings);
      tray.update(readerState, settings.shortcut);
    }
    return { settings, error };
  });

  ipcMain.on("pause-shortcut", (_event, paused: boolean) => {
    if (paused) globalShortcut.unregisterAll();
    else registerShortcut();
  });

  ipcMain.handle("synthesize", (_event, text: string, voice: string, speed: number) =>
    speech.synthesize(text, voice, speed).catch((error: Error) => {
      if (error.message !== "cancelled") console.error("Speech failed:", error.message);
      return null;
    }),
  );

  ipcMain.on("cancel-speech", () => speech.cancel());
  ipcMain.on("read-text", (_event, text: string) => readText(text));

  ipcMain.on("reader-state", (_event, state: ReaderState) => {
    readerState = state;
    tray.update(state, settings.shortcut);
  });

  ipcMain.on("window-ready", () => {
    windowReady = true;
    if (pendingText) readText(pendingText);
    pendingText = "";
  });

  ipcMain.on("quit", () => app.quit());
}
