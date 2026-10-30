/** A speaker that keeps what it is given, with the package's own clips, and a clock tests drive. */

import type { Clock, Speaker } from "../../src/index.js";
import { voiceFile } from "../../src/node/voice.js";

export class RecordingSpeaker implements Speaker {
  readonly written: Int16Array[] = [];
  /** When each chunk was written, by the speaker's clock. */
  readonly times: number[] = [];
  flushes = 0;

  constructor(
    readonly sampleRate = 16_000,
    private readonly clock: Pick<Clock, "now"> = { now: () => performance.now() },
    readonly load: (path: string) => Promise<Uint8Array> = voiceFile,
  ) {}

  write(pcm: Int16Array): void {
    this.written.push(pcm.slice());
    this.times.push(this.clock.now());
  }

  flush(): void {
    this.flushes += 1;
  }

  get samples(): number {
    return this.written.reduce((total, chunk) => total + chunk.length, 0);
  }

  /** Everything written, end to end. */
  audio(): Int16Array {
    const all = new Int16Array(this.samples);
    let at = 0;
    for (const chunk of this.written) {
      all.set(chunk, at);
      at += chunk.length;
    }
    return all;
  }
}

/** Time that passes only when the code under test sleeps. */
export class FakeClock implements Clock {
  time = 0;

  now(): number {
    return this.time;
  }

  async sleep(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.time += ms;
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
  }
}
