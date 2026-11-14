import { parseArgs } from "node:util";

/** What the app was asked to do on the command line, e.g. `select-reader --read`. */
export type Command =
  | { type: "open" }
  | { type: "read-selection" }
  | { type: "read-text"; text: string }
  | { type: "toggle-pause" }
  | { type: "stop" };

export const USAGE = `Usage: select-reader [option]

  -r, --read         Read the text selected in the focused app
  -t, --text <text>  Read the given text
  -p, --pause        Pause or resume reading
  -s, --stop         Stop reading
  -h, --help         Show this help

If Select Reader is already running, the command is passed to it.`;

export function parseCommand(args: string[]): Command | "help" {
  const { values } = parseArgs({
    args,
    // Electron and Chromium add their own flags, so ignore anything we don't know.
    strict: false,
    allowPositionals: true,
    options: {
      read: { type: "boolean", short: "r" },
      text: { type: "string", short: "t" },
      pause: { type: "boolean", short: "p" },
      stop: { type: "boolean", short: "s" },
      help: { type: "boolean", short: "h" },
    },
  });

  if (values.help) return "help";
  if (values.stop) return { type: "stop" };
  if (values.pause) return { type: "toggle-pause" };
  if (typeof values.text === "string") return { type: "read-text", text: values.text };
  if (values.read) return { type: "read-selection" };
  return { type: "open" };
}
