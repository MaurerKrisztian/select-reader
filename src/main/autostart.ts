import { app } from "electron";
import fs from "node:fs";
import path from "node:path";

/** Passed when started at login: open in the tray, without the window. */
const HIDDEN_FLAG = "--hidden";

/**
 * Starting Select Reader when the user logs in.
 *
 * Linux: a launcher in ~/.config/autostart, which every desktop reads.
 * Windows and macOS: the system's own list of login items.
 */
export function isStartOnLogin(): boolean {
  if (process.platform === "linux") return fs.existsSync(autostartFile());
  return app.getLoginItemSettings({ args: [HIDDEN_FLAG] }).openAtLogin;
}

export function setStartOnLogin(enabled: boolean): void {
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: enabled, args: [HIDDEN_FLAG] });
  } else if (enabled) {
    fs.mkdirSync(path.dirname(autostartFile()), { recursive: true });
    fs.writeFileSync(autostartFile(), desktopEntry());
  } else {
    fs.rmSync(autostartFile(), { force: true });
  }
}

/** macOS can't pass --hidden to login items, but it can tell us we were started by one. */
export function wasStartedByLoginItem(): boolean {
  return process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin;
}

function autostartFile(): string {
  // appData is $XDG_CONFIG_HOME, or ~/.config.
  return path.join(app.getPath("appData"), "autostart", "select-reader.desktop");
}

function desktopEntry(): string {
  const [program, ...args] = launchCommand();
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Name=Select Reader",
    "Comment=Reads selected text aloud",
    `Exec=${[program, ...args, HIDDEN_FLAG].map(quoteArgument).join(" ")}`,
    // If the app is uninstalled, the desktop skips this file instead of failing to start it.
    `TryExec=${program}`,
    "Icon=select-reader",
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** The command that starts this copy of Select Reader. */
function launchCommand(): string[] {
  // An AppImage runs from a new temporary folder each time: start the .AppImage file itself.
  if (process.env.APPIMAGE) return [process.env.APPIMAGE];
  // Not installed (npm start): Electron, plus the app's folder.
  if (!app.isPackaged) return [process.execPath, app.getAppPath()];
  return [process.execPath];
}

/**
 * Quotes one argument of an Exec line, following the Desktop Entry spec: escape the
 * characters that are special inside quotes, then escape backslashes once more for
 * the file format, and double "%" (which starts a field code like %U).
 */
function quoteArgument(argument: string): string {
  const quoted = `"${argument.replace(/["`$\\]/g, "\\$&")}"`;
  return quoted.replaceAll("\\", "\\\\").replaceAll("%", "%%");
}
