/**
 * Pairing: ask the core, show the code, wait for a household member to confirm it, get the token.
 *
 *     POST /satellites/pair             manifest → 201 {pairing_id, code, expires_at}
 *     GET  /satellites/pair/{id}                 → {status: pending | approved | claimed | expired, token?}
 *
 * The token comes once, with the first `approved` answer. A code that expires (or a pairing
 * claimed by someone else) is replaced by a new one.
 */

import { describe, type Logger, quietLogger } from "./log.js";
import type { Manifest } from "./protocol.js";

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** The core answered with an unexpected HTTP status. */
export class HttpError extends Error {
  override name = "HttpError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface PairOptions {
  readonly core: string;
  readonly manifest: Manifest;
  /** Show the 6-digit code to the person who will confirm it. */
  readonly onCode: (code: string) => void;
  readonly pollMs?: number;
  readonly fetch?: Fetch;
  readonly signal?: AbortSignal;
  readonly logger?: Logger;
}

export function showCode(code: string): void {
  console.log(`Pairing code: ${code} — confirm it in Nestor (admin, or \`nestor satellites approve ${code}\`)`);
}

/** Pair until a household member confirms a code; resolves with the token. */
export async function pair(options: PairOptions): Promise<string> {
  const { core, manifest, onCode, pollMs = 1000, signal, logger = quietLogger } = options;
  const http = options.fetch ?? globalThis.fetch.bind(globalThis);
  for (;;) {
    const ticket = await json(
      await http(`${core}/satellites/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(manifest.toJSON()),
        ...(signal ? { signal } : {}),
      }),
      "pairing request",
    );
    const { pairing_id: pairingId, code } = ticket;
    if (typeof pairingId !== "string" || typeof code !== "string" || !/^\d{6}$/.test(code)) {
      throw new HttpError(502, "the core answered the pairing request without a pairing id and code");
    }
    try {
      onCode(code);
    } catch (error) {
      logger.warn(`could not show the pairing code: ${describe(error)}`);
    }
    for (;;) {
      const state = await json(
        await http(`${core}/satellites/pair/${encodeURIComponent(pairingId)}`, signal ? { signal } : {}),
        "pairing poll",
      );
      if (state.status === "approved") {
        if (typeof state.token !== "string" || state.token.length === 0) {
          throw new HttpError(502, "the core approved the pairing without a token");
        }
        return state.token;
      }
      if (state.status !== "pending") {
        logger.info(`pairing ${String(state.status)}, asking again`);
        break;
      }
      await sleep(pollMs, signal);
    }
  }
}

async function json(response: Response, what: string): Promise<Record<string, unknown>> {
  if (!response.ok) {
    throw new HttpError(response.status, `${what}: HTTP ${response.status} ${await detail(response)}`.trim());
  }
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(502, `${what}: the core did not answer with a JSON object`);
  }
  return body as Record<string, unknown>;
}

async function detail(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "detail" in body) return String(body.detail);
  } catch {
    // no JSON detail
  }
  return "";
}

/** Waits `ms`; rejects with the signal's reason when it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    const aborted = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}
