/**
 * A fake core for behaviour tests: the pairing and offer endpoints over real HTTP (a local
 * server). Answered offers become sessions handed out by `sessions`; `FakeWebRtc`
 * (`./webrtc.ts`) answers them in-process.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export class Queue<T> {
  private readonly items: T[] = [];
  private readonly waiting: ((item: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.waiting.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  next(timeoutMs = 2000): Promise<T> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`nothing within ${timeoutMs} ms`)), timeoutMs);
      this.waiting.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  }

  get pending(): readonly T[] {
    return this.items;
  }
}

export type Json = Record<string, unknown>;

/** Whatever answers an offer with a session the test drives. */
export interface Answerer<S> {
  answer(sdp: string, deviceId: string): S | null;
}

export function message(type: string, payload: Json, id = `m-${Math.random().toString(16).slice(2)}`): Json {
  return { type, id, at: "2026-10-30T12:00:00.000000+00:00", payload };
}

export function welcome(deviceId: string, room: string, capabilities: string[]): Json {
  return message("welcome", { device_id: deviceId, room, capabilities });
}

export interface FakeCoreOptions<S> {
  /** Polls answered `pending` before the approval (default 1). */
  readonly pendingPolls?: number;
  /** Pairing codes that expire before approval, one per request, before one is approved. */
  readonly expiring?: number;
  /** Who answers the offers (none: every offer is refused as unknown). */
  readonly webrtc?: Answerer<S>;
}

export class FakeCore<S = never> {
  readonly sessions = new Queue<S>();
  readonly pairRequests: Json[] = [];
  readonly offers: { deviceId: string; authorization: string | undefined; body: Json }[] = [];
  /** Valid tokens, by device id. */
  readonly tokens = new Map<string, string>();
  /** Answer every request with this status (a core in trouble). */
  failWith: number | null = null;
  private readonly pairings = new Map<string, { deviceId: string; polls: number; expired: boolean }>();
  private expiring: number;
  private issued = 0;
  url = "";

  private constructor(
    private readonly server: Server,
    readonly webrtc: Answerer<S> | null,
    private readonly options: FakeCoreOptions<S>,
  ) {
    this.expiring = options.expiring ?? 0;
  }

  static async start<S = never>(options: FakeCoreOptions<S> = {}): Promise<FakeCore<S>> {
    let core: FakeCore<S> | undefined;
    const server = createServer((request, response) => {
      core?.handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    core = new FakeCore<S>(server, options.webrtc ?? null, options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    core.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return core;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  revoke(deviceId: string): void {
    this.tokens.delete(deviceId);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const reply = (status: number, data: Json) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
    if (this.failWith !== null) return void reply(this.failWith, { detail: "core in trouble" });
    const url = new URL(request.url ?? "/", this.url);
    const poll = url.pathname.match(/^\/satellites\/pair\/([^/]+)$/);
    const offer = url.pathname.match(/^\/satellites\/([^/]+)\/offer$/);
    if (request.method === "POST" && url.pathname === "/satellites/pair") {
      this.pairRequests.push(body);
      const id = `pairing-${this.pairRequests.length}`;
      const device = (body.device as Json | undefined)?.id;
      const expired = this.expiring > 0;
      if (expired) this.expiring -= 1;
      this.pairings.set(id, { deviceId: String(device), polls: 0, expired });
      return void reply(201, { pairing_id: id, code: "042137", expires_at: "2026-10-30T12:10:00+00:00" });
    }
    if (request.method === "GET" && poll?.[1]) {
      const pairing = this.pairings.get(poll[1]);
      if (pairing === undefined || pairing.expired) return void reply(200, { status: "expired" });
      pairing.polls += 1;
      if (pairing.polls <= (this.options.pendingPolls ?? 1)) return void reply(200, { status: "pending" });
      if (pairing.polls > (this.options.pendingPolls ?? 1) + 1) return void reply(200, { status: "claimed" });
      this.issued += 1;
      const token = `nst1_token-${this.issued}`;
      this.tokens.set(pairing.deviceId, token);
      return void reply(200, { status: "approved", token, device_id: pairing.deviceId });
    }
    if (request.method === "POST" && offer?.[1]) {
      const deviceId = decodeURIComponent(offer[1]);
      const authorization = request.headers.authorization;
      this.offers.push({ deviceId, authorization, body });
      if (authorization !== `Bearer ${this.tokens.get(deviceId)}`) {
        return void reply(401, { detail: "pair this device first" });
      }
      const session = this.webrtc === null ? null : this.webrtc.answer(String(body.sdp), deviceId);
      if (session === null) return void reply(400, { detail: "unknown offer" });
      reply(200, { sdp: `answer:${String(body.sdp)}`, type: "answer", pc_id: "pc-1" });
      this.sessions.push(session);
      return;
    }
    reply(404, { detail: "not found" });
  }
}

async function readJson(request: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Json) : {};
}

export function until(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      if (condition()) resolve();
      else if (Date.now() > deadline) reject(new Error("condition not met in time"));
      else setTimeout(check, 5);
    };
    check();
  });
}
