/**
 * A fake core for behaviour tests: the `nestor.satellite/1` pairing endpoints over real HTTP, the
 * link over a real WebSocket, and the audio endpoint (a local server). Links whose `hello` is
 * accepted are handed out by `links`; answered audio offers become sessions handed out by `audio`,
 * answered in-process by `FakeVoice` (`./audio.ts`).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

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

/** Whatever answers an audio offer with a session the test drives. */
export interface Answerer<S> {
  answer(sdp: string, deviceId: string): S | null;
}

export function message(type: string, payload: Json, id = `m-${Math.random().toString(16).slice(2)}`): Json {
  return { type, id, at: "2026-10-30T12:00:00.000000+00:00", payload };
}

export function welcome(deviceId: string, room: string, capabilities: string[]): Json {
  return message("welcome", { device_id: deviceId, room, capabilities });
}

export type Refusal = "unknown" | "expired" | "used" | "cancelled";

export interface FakeCoreOptions<S> {
  /** Polls answered `pending` before a person types the device code (default 1; `Infinity`: never). */
  readonly pendingPolls?: number;
  /** Pairings that expire before a device code is typed, one per request, before one is approved. */
  readonly expiring?: number;
  /** Enrollment codes made in the admin: `valid` ones pair once, then read as `used`. */
  readonly codes?: Readonly<Record<string, "valid" | Refusal>>;
  /** Who answers the audio offers (none: every offer is refused as unknown). */
  readonly voice?: Answerer<S>;
  /** How long a link has to say hello (ms). */
  readonly helloTimeoutMs?: number;
}

/** The core's side of one link, once its `hello` was accepted. */
export class CoreLink {
  readonly received = new Queue<Json>();
  /** The capabilities the welcome allowed, and when it was sent; `null` before. */
  allowed: ReadonlySet<string> | null = null;
  welcomedAt: number | null = null;
  closed = false;

  constructor(
    readonly deviceId: string,
    readonly hello: Json,
    private readonly socket: WebSocket,
  ) {
    socket.on("message", (data, binary) => {
      if (!binary) this.received.push(JSON.parse(data.toString()) as Json);
    });
    socket.on("close", () => {
      this.closed = true;
    });
  }

  /** Answer the hello: the room, and what the household allows. */
  welcome(allowed: string[], room = "entree"): void {
    this.allowed = new Set(allowed);
    this.welcomedAt = Date.now();
    this.send(welcome(this.deviceId, room, allowed));
  }

  send(message: Json): void {
    this.socket.send(JSON.stringify(message));
  }

  sendRaw(text: string): void {
    this.socket.send(text);
  }

  /** The core closes the link: 1001 when it stops, 4401 for a refused token, 4409 when replaced. */
  close(code = 1001): void {
    this.socket.close(code);
  }

  /** The link breaks without a word. */
  drop(): void {
    this.socket.terminate();
  }

  async nextOfType(type: string): Promise<Json> {
    for (;;) {
      const message = await this.received.next();
      if (message.type === type) return message;
    }
  }
}

interface FakePairing {
  readonly deviceId: string;
  polls: number;
  status: "pending" | "approved" | "claimed" | "expired";
  identify: boolean;
}

/**
 * The core's side of `nestor.satellite/1`: pairing endpoints (device codes, enrollment codes,
 * identify, rate limits) and the offer endpoint, over real HTTP on a local port.
 */
export class FakeCore<S = never> {
  static readonly DEVICE_CODE = "042137";
  /** Links whose hello was accepted. */
  readonly links = new Queue<CoreLink>();
  /** Answered audio offers. */
  readonly audio = new Queue<S>();
  /** Close codes of the links turned away before a welcome (4400, 4401). */
  readonly refusedLinks: number[] = [];
  /** Bodies of `POST /satellites/pairings`, with when they came (ms). */
  readonly pairRequests: Json[] = [];
  readonly requestTimes: number[] = [];
  /** Bodies of `POST /satellites/pairings/{id}/enrollment`. */
  readonly enrollments: Json[] = [];
  readonly polls: string[] = [];
  /** Every audio offer, with when it came (ms). */
  readonly offers: { deviceId: string; authorization: string | undefined; body: Json; at: number }[] = [];
  /** Answer the next audio offers with 500. */
  audioFailures = 0;
  /** Valid tokens, by device id. */
  readonly tokens = new Map<string, string>();
  /** Answer every request with this status, and refuse every link (a core in trouble). */
  failWith: number | null = null;
  /** Answer the next requests carrying an enrollment code with `429 too_many_attempts`. */
  limited = 0;
  retryAfterS = 1;
  /** Refuse every manifest as another protocol version. */
  protocolUnsupported = false;
  readonly pairings = new Map<string, FakePairing>();
  private readonly codes: Map<string, "valid" | Refusal>;
  /** The current link of each device. */
  private readonly current = new Map<string, CoreLink>();
  private readonly sockets = new WebSocketServer({ noServer: true });
  private expiring: number;
  private issued = 0;
  url = "";

  private constructor(
    private readonly server: Server,
    readonly voice: Answerer<S> | null,
    private readonly options: FakeCoreOptions<S>,
  ) {
    this.expiring = options.expiring ?? 0;
    this.codes = new Map(Object.entries(options.codes ?? {}));
    server.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://core").pathname.match(/^\/satellites\/([^/]+)\/link$/);
      if (this.failWith !== null || !path?.[1]) {
        socket.end(`HTTP/1.1 ${this.failWith ?? 404} Unavailable\r\n\r\n`);
        return;
      }
      const deviceId = decodeURIComponent(path[1]);
      this.sockets.handleUpgrade(request, socket, head, (ws) => this.greet(ws, deviceId));
    });
  }

  static async start<S = never>(options: FakeCoreOptions<S> = {}): Promise<FakeCore<S>> {
    let core: FakeCore<S> | undefined;
    const server = createServer((request, response) => {
      core?.handle(request, response).catch((error: unknown) => {
        response.writeHead(500).end(String(error));
      });
    });
    core = new FakeCore<S>(server, options.voice ?? null, options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    core.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return core;
  }

  async stop(): Promise<void> {
    for (const client of this.sockets.clients) client.terminate();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The link's first message must be a hello with the device's own id and its valid token (L1, L2, L4). */
  private greet(socket: WebSocket, deviceId: string): void {
    const turnAway = (code: number) => {
      this.refusedLinks.push(code);
      socket.close(code);
    };
    const late = setTimeout(() => turnAway(4400), this.options.helloTimeoutMs ?? 1000);
    socket.once("message", (data) => {
      clearTimeout(late);
      let hello: Json;
      try {
        hello = JSON.parse(data.toString()) as Json;
      } catch {
        return void turnAway(4400);
      }
      const payload = hello.payload as Json | undefined;
      const manifest = payload?.manifest as Json | undefined;
      if (hello.type !== "hello" || (manifest?.device as Json | undefined)?.id !== deviceId) {
        return void turnAway(4400);
      }
      if (payload?.token !== this.tokens.get(deviceId)) return void turnAway(4401);
      this.current.get(deviceId)?.close(4409);
      const link = new CoreLink(deviceId, hello, socket);
      this.current.set(deviceId, link);
      socket.on("close", () => {
        if (this.current.get(deviceId) === link) this.current.delete(deviceId);
      });
      this.links.push(link);
    });
  }

  revoke(deviceId: string): void {
    this.tokens.delete(deviceId);
  }

  /** A person types the device code of the pending pairing now. */
  approve(pairingId = this.lastPairing()): void {
    const pairing = this.pairings.get(pairingId);
    if (pairing?.status === "pending") pairing.status = "approved";
  }

  /** A person asks the pending device to make itself noticed. */
  identify(pairingId = this.lastPairing()): void {
    const pairing = this.pairings.get(pairingId);
    if (pairing !== undefined) pairing.identify = true;
  }

  lastPairing(): string {
    return [...this.pairings.keys()].at(-1) ?? "";
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readJson(request);
    const reply = (status: number, data: Json, headers: Record<string, string> = {}) =>
      response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(data));
    if (this.failWith !== null) return void reply(this.failWith, { detail: "core in trouble" });
    const url = new URL(request.url ?? "/", this.url);
    const poll = url.pathname.match(/^\/satellites\/pairings\/([^/]+)$/);
    const enroll = url.pathname.match(/^\/satellites\/pairings\/([^/]+)\/enrollment$/);
    const offer = url.pathname.match(/^\/satellites\/([^/]+)\/audio$/);
    const refuse = (error: string, extra: Json = {}, headers: Record<string, string> = {}) =>
      reply(ERRORS[error] ?? 500, { error, detail: `${error} (in English, for logs)`, ...extra }, headers);
    const limited = () => {
      this.limited -= 1;
      refuse("too_many_attempts", { retry_after_s: this.retryAfterS }, { "retry-after": String(this.retryAfterS) });
    };

    if (request.method === "POST" && url.pathname === "/satellites/pairings") {
      this.pairRequests.push(body);
      this.requestTimes.push(Date.now());
      const manifest = body.manifest as Json | undefined;
      if (this.protocolUnsupported) return void refuse("protocol_unsupported");
      if (manifest?.protocol !== "nestor.satellite/1") return void refuse("invalid_request");
      const code = body.enrollment_code as string | undefined;
      if (code !== undefined && this.limited > 0) return void limited();
      if (code !== undefined && this.codes.get(code) !== "valid") {
        return void refuse("enrollment_refused", { reason: this.codes.get(code) ?? "unknown" });
      }
      const id = `pairing-${this.pairRequests.length}`;
      const deviceId = String((manifest.device as Json | undefined)?.id);
      const expired = code === undefined && this.expiring > 0;
      if (expired) this.expiring -= 1;
      this.pairings.set(id, { deviceId, polls: 0, status: expired ? "expired" : "pending", identify: false });
      const expires_at = "2026-10-30T12:10:00+00:00";
      if (code !== undefined) {
        this.codes.set(code, "used");
        this.approve(id);
        return void reply(201, { pairing_id: id, status: "approved", expires_at });
      }
      return void reply(201, { pairing_id: id, status: "pending", expires_at, device_code: FakeCore.DEVICE_CODE });
    }
    if (request.method === "POST" && enroll?.[1]) {
      this.enrollments.push(body);
      if (this.limited > 0) return void limited();
      const pairing = this.pairings.get(enroll[1]);
      if (pairing?.status !== "pending") return void refuse("not_pending");
      const code = String(body.enrollment_code);
      if (this.codes.get(code) !== "valid") {
        return void refuse("enrollment_refused", { reason: this.codes.get(code) ?? "unknown" });
      }
      this.codes.set(code, "used");
      pairing.status = "approved";
      return void reply(200, { status: "approved", device_id: pairing.deviceId, room: "salon", capabilities: [] });
    }
    if (request.method === "GET" && poll?.[1]) {
      this.polls.push(poll[1]);
      const pairing = this.pairings.get(poll[1]);
      if (pairing === undefined) return void reply(200, { status: "expired" });
      pairing.polls += 1;
      if (pairing.status === "pending" && pairing.polls > (this.options.pendingPolls ?? 1)) pairing.status = "approved";
      if (pairing.status === "approved") {
        pairing.status = "claimed";
        this.issued += 1;
        const token = `nst1_token-${this.issued}`;
        this.tokens.set(pairing.deviceId, token);
        return void reply(200, {
          status: "approved",
          token,
          device_id: pairing.deviceId,
          room: "salon",
          capabilities: [],
        });
      }
      const identify = pairing.identify;
      pairing.identify = false;
      return void reply(200, { status: pairing.status, ...(identify ? { identify: true } : {}) });
    }
    if (request.method === "POST" && offer?.[1]) {
      const deviceId = decodeURIComponent(offer[1]);
      const authorization = request.headers.authorization;
      this.offers.push({ deviceId, authorization, body, at: Date.now() });
      if (authorization !== `Bearer ${this.tokens.get(deviceId)}`) {
        return void reply(401, { detail: "pair this device first" });
      }
      const allowed = this.current.get(deviceId)?.allowed;
      if (!allowed?.has("audio.capture") && !allowed?.has("audio.playback")) {
        return void reply(403, { detail: "audio needs this device's link up and audio allowed" });
      }
      if (this.audioFailures > 0) {
        this.audioFailures -= 1;
        return void reply(500, { detail: "the voice failed" });
      }
      const session = this.voice === null ? null : this.voice.answer(String(body.sdp), deviceId);
      if (session === null) return void reply(400, { detail: "unknown offer" });
      reply(200, { sdp: `answer:${String(body.sdp)}`, type: "answer", pc_id: "pc-1" });
      this.audio.push(session);
      return;
    }
    reply(404, { detail: "not found" });
  }
}

const ERRORS: Record<string, number> = {
  invalid_request: 422,
  protocol_unsupported: 422,
  too_many_pending: 429,
  too_many_attempts: 429,
  enrollment_refused: 403,
  not_pending: 409,
};

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
