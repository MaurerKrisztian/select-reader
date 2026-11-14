import { Menu, Tray, nativeImage } from "electron";
import type { ReaderState } from "../shared/types.js";

export interface TrayActions {
  readSelection(): void;
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
  update(state: ReaderState, shortcut: string): void {
    const busy = state !== "idle";
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Read selection (${shortcut})`, click: () => this.actions.readSelection() },
        { label: state === "paused" ? "Resume" : "Pause", enabled: busy, click: () => this.actions.togglePause() },
        { label: "Stop", enabled: busy, click: () => this.actions.stop() },
        { type: "separator" },
        { label: "Open Select Reader", click: () => this.actions.showWindow() },
        { label: "Quit", click: () => this.actions.quit() },
      ]),
    );
  }
}
