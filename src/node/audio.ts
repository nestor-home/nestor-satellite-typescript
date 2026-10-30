/**
 * Audio in and out of a Node satellite: 16-bit mono PCM, whatever the hardware.
 *
 * `AudioSource` gives the chunks to send to the core (the microphone); `AudioSink` plays what the
 * core says (the speaker). Node has no audio API of its own: `CommandSource` and `CommandSink` run
 * a recorder and a player (`arecord`/`aplay`, SoX, ffmpeg…) and exchange raw PCM through their
 * pipes; the doubles serve tests and devices without one or the other.
 */

import { type ChildProcess, spawn } from "node:child_process";

export const FRAME_MS = 20;

export interface AudioSource {
  readonly sampleRate: number;
  /** Open the device; nothing to open by default. Rejects clearly when it cannot. */
  start?(): Promise<void>;
  /** The next chunk of audio (any length, 20 ms is usual); waits for it. */
  read(): Promise<Int16Array>;
  close?(): Promise<void>;
}

export interface AudioSink {
  readonly sampleRate: number;
  start?(): Promise<void>;
  /** Play audio as it arrives; must not block. */
  write(pcm: Int16Array): void;
  close?(): Promise<void>;
}

/** A device without a microphone still sends a (silent) stream: the core's turn taking expects one. */
export class SilenceSource implements AudioSource {
  constructor(readonly sampleRate = 48_000) {}

  async read(): Promise<Int16Array> {
    return new Int16Array((this.sampleRate * FRAME_MS) / 1000);
  }
}

/** Keeps what was played, e.g. to check a device received the core's voice. */
export class RecordingSink implements AudioSink {
  readonly chunks: Int16Array[] = [];

  constructor(readonly sampleRate = 48_000) {}

  get samples(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.length, 0);
  }

  write(pcm: Int16Array): void {
    this.chunks.push(pcm);
  }
}

/** No speaker: the core's audio is received (the link stays healthy) and dropped. */
export class DiscardSink implements AudioSink {
  constructor(readonly sampleRate = 48_000) {}

  write(): void {}
}

export interface CommandOptions {
  readonly sampleRate?: number;
  /** How much audio may wait before it is dropped (default: 1 s for a recorder, 500 ms for a player). */
  readonly maxBufferMs?: number;
}

/**
 * A recorder whose standard output is raw s16le mono PCM, e.g.
 * `arecord -q -t raw -f S16_LE -c 1 -r 48000`. Run by `/bin/sh -c`.
 */
export class CommandSource implements AudioSource {
  readonly sampleRate: number;
  private readonly maxBytes: number;
  private process: ChildProcess | null = null;
  private buffer = Buffer.alloc(0);
  private waiting: (() => void) | null = null;
  private failure: Error | null = null;

  constructor(
    readonly command: string,
    options: CommandOptions = {},
  ) {
    this.sampleRate = options.sampleRate ?? 48_000;
    this.maxBytes = Math.round((this.sampleRate * (options.maxBufferMs ?? 1000)) / 1000) * 2;
  }

  async start(): Promise<void> {
    const child = await launch(this.command, ["ignore", "pipe", "inherit"]);
    this.process = child;
    child.stdout?.on("data", (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data]);
      if (this.buffer.length > this.maxBytes) this.buffer = this.buffer.subarray(this.buffer.length - this.maxBytes);
      this.wake();
    });
    child.on("exit", (code, signal) => {
      if (this.process === child) this.failure = new Error(`the recorder stopped (${signal ?? `status ${code}`})`);
      this.wake();
    });
  }

  async read(): Promise<Int16Array> {
    const frame = ((this.sampleRate * FRAME_MS) / 1000) * 2;
    while (this.buffer.length < frame) {
      if (this.failure !== null) throw this.failure;
      if (this.process === null) throw new Error("the recorder is not started");
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
    const chunk = this.buffer.subarray(0, frame);
    this.buffer = this.buffer.subarray(frame);
    return pcm(chunk);
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    this.wake();
    await stop(child);
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }
}

/**
 * A player that reads raw s16le mono PCM on its standard input, e.g.
 * `aplay -q -t raw -f S16_LE -c 1 -r 48000`. Audio the player cannot take in time is dropped
 * rather than letting the voice lag further and further behind.
 */
export class CommandSink implements AudioSink {
  readonly sampleRate: number;
  private readonly maxBytes: number;
  private process: ChildProcess | null = null;

  constructor(
    readonly command: string,
    options: CommandOptions = {},
  ) {
    this.sampleRate = options.sampleRate ?? 48_000;
    this.maxBytes = Math.round((this.sampleRate * (options.maxBufferMs ?? 500)) / 1000) * 2;
  }

  async start(): Promise<void> {
    this.process = await launch(this.command, ["pipe", "ignore", "inherit"]);
    this.process.stdin?.on("error", () => {}); // a player that quits is noticed on exit
  }

  write(samples: Int16Array): void {
    const stdin = this.process?.stdin;
    if (!stdin || stdin.destroyed || stdin.writableLength > this.maxBytes) return;
    stdin.write(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  }

  async close(): Promise<void> {
    const child = this.process;
    this.process = null;
    child?.stdin?.end();
    await stop(child, 1000); // let it play what it has, briefly
  }
}

function pcm(bytes: Buffer): Int16Array {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Int16Array(copy.buffer);
}

function launch(command: string, stdio: ["ignore" | "pipe", "ignore" | "pipe", "inherit"]): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", `exec ${command}`], { stdio });
    child.once("error", reject);
    child.once("spawn", () => {
      // `sh` starts even when the command does not exist: give it a moment to fail.
      const early = setTimeout(() => {
        child.off("exit", exited);
        resolve(child);
      }, 200);
      const exited = (code: number | null) => {
        clearTimeout(early);
        reject(new Error(`\`${command}\` exited at once (status ${code}): is it installed?`));
      };
      child.once("exit", exited);
    });
  });
}

/** Ends a child: after `graceMs` on its own, then SIGTERM, then SIGKILL. */
async function stop(child: ChildProcess | null, graceMs = 0): Promise<void> {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const term = setTimeout(() => child.kill("SIGTERM"), graceMs);
  const kill = setTimeout(() => child.kill("SIGKILL"), graceMs + 2000);
  await exited;
  clearTimeout(term);
  clearTimeout(kill);
}
