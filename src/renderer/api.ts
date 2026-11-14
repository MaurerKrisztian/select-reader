import type { SelectReaderApi } from "../shared/types.js";

declare global {
  interface Window {
    selectReader: SelectReaderApi;
  }
}

/** Talks to the main process. Defined in src/preload/preload.cts. */
export const api = window.selectReader;
