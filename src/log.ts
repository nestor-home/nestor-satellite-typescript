/** Where the SDK says what happens; `console` fits, and so does any structured logger. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
}

/** Warnings only, on the console: what a driver should see by default. */
export const quietLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (message) => console.warn(`[nestor-satellite] ${message}`),
};

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
