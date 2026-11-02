/**
 * The link: one WebSocket per device, `ws(s)://<core>/satellites/{device_id}/link`, that carries
 * every message. Browsers and Node (22 and later) have a standard `WebSocket`; the interfaces below
 * are the part of it the SDK uses, kept structural so that no platform typing leaks into the public
 * API.
 */

export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

/** `WebSocket.OPEN`. */
export const OPEN = 1;

/** Why the core closes a link, and what the device does about it. */
export const LINK_CLOSE = {
  /** The core is stopping: reconnect. */
  stopping: 1001,
  /** `hello` late, off-contract or for another device: reconnect. */
  offContract: 4400,
  /** The token is refused: forget it and pair again. */
  tokenRefused: 4401,
  /** A newer link of this device replaced this one: stop. */
  replaced: 4409,
} as const;

/** The link's address under the core's base URL: `ws://` for `http`, `wss://` for `https`. */
export function linkUrl(core: string, deviceId: string): string {
  const url = new URL(`${core.replace(/\/+$/, "")}/satellites/${encodeURIComponent(deviceId)}/link`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

/** The platform's `WebSocket`, or `undefined` where there is none. */
export function platformWebSocket(): WebSocketConstructor | undefined {
  return (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
}
