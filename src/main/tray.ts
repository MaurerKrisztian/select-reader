import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from "electron";
import type { ReaderState, Settings } from "../shared/types.js";

export interface TrayActions {
  readSelection(): void;
  readText(text: string): void;
  togglePause(): void;
  stop(): void;
  showWindow(): void;
  quit(): void;
}

/** The icon next to the clock, so the app keeps running when its window is closed. */
export class AppTray {
  private tray: Tray;

  constructor(iconPath: string, private actions: TrayActions) {
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 24, height: 24 });
    this.tray = new Tray(icon);
    this.tray.setToolTip("Select Reader");
    // Windows and macOS: clicking the icon opens the window. Linux shows the menu instead.
    this.tray.on("click", () => actions.showWindow());
  }

  /** Rebuilds the menu so it matches what the reader is doing. */
  update(state: ReaderState, settings: Settings, history: string[]): void {
    const busy = state !== "idle";
    const recent: MenuItemConstructorOptions = history.length
      ? {
          label: "Read again",
          submenu: history.map((text) => ({ label: menuLabel(text), click: () => this.actions.readText(text) })),
        }
      : { label: "Read again", enabled: false };

    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: withKeys("Read selection", settings.shortcut), click: () => this.actions.readSelection() },
        {
          label: withKeys(state === "paused" ? "Resume" : "Pause", settings.pause_shortcut),
          enabled: busy,
          click: () => this.actions.togglePause(),
        },
        { label: withKeys("Stop", settings.stop_shortcut), enabled: busy, click: () => this.actions.stop() },
        recent,
        { type: "separator" },
        { label: "Open Select Reader", click: () => this.actions.showWindow() },
        { label: "Quit", click: () => this.actions.quit() },
      ]),
    );
  }
}

/** "Pause (Ctrl+Alt+P)", or just "Pause" when it has no shortcut. */
function withKeys(label: string, shortcut: string): string {
  return shortcut ? `${label} (${shortcut})` : label;
}

/** The start of a text, on one short line. "&" is doubled: alone it marks a menu key. */
function menuLabel(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return (line.length > 50 ? `${line.slice(0, 50).trimEnd()}…` : line).replaceAll("&", "&&");
}
