import { describe, expect, it } from "vitest";
import { Messages, quietLogger } from "../src/index.js";
import {
  CommandSink,
  CommandSource,
  DiscardSink,
  nodeVoice,
  RecordingSink,
  SilenceSource,
  sinkSpeaker,
} from "../src/node/index.js";
import { SpokenCode } from "../src/voice/index.js";

const node = JSON.stringify(process.execPath);

describe("audio through commands", () => {
  it("reads a recorder's raw PCM in 20 ms chunks", async () => {
    // 50 ms of samples 0, 1, 2… at 8 kHz, little-endian, then the recorder keeps running.
    const script =
      "const b=Buffer.alloc(800);for(let i=0;i<400;i++)b.writeInt16LE(i,i*2);process.stdout.write(b);setInterval(()=>{},1000)";
    const source = new CommandSource(`${node} -e '${script}'`, { sampleRate: 8000 });
    await source.start();
    const first = await source.read();
    const second = await source.read();
    await source.close();
    expect(first.length).toBe(160);
    expect([first[0], first[159], second[0]]).toEqual([0, 159, 160]);
  });

  it("fails clearly when the recorder is missing or stops", async () => {
    await expect(new CommandSource("no-such-recorder-xyz").start()).rejects.toThrow(/is it installed/);
    const source = new CommandSource(`${node} -e 'setTimeout(()=>{},300)'`);
    await source.start();
    await expect(source.read()).rejects.toThrow(/recorder stopped/);
  });

  it("writes PCM to a player's standard input", async () => {
    const script =
      'let n=0;process.stdin.on("data",d=>n+=d.length);process.stdin.on("end",()=>{require("fs").writeFileSync(process.argv[1],String(n))})';
    const { mkdtemp, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const out = `${await mkdtemp(`${tmpdir()}/nestor-`)}/count`;
    const sink = new CommandSink(`${node} -e '${script}' ${out}`);
    await sink.start();
    sink.write(new Int16Array(480));
    sink.write(new Int16Array(480));
    await sink.close();
    expect(await readFile(out, "utf8")).toBe("1920");
  });

  it("a sink written before it starts, or after it closes, drops the audio", async () => {
    const sink = new CommandSink("cat > /dev/null");
    sink.write(new Int16Array(10));
    await sink.start();
    await sink.close();
    sink.write(new Int16Array(10));
  });
});

it("silence comes in 20 ms chunks at the source's rate; a recording keeps what it is given", async () => {
  expect((await new SilenceSource(16_000).read()).length).toBe(320);
  const sink = new RecordingSink();
  sink.write(new Int16Array(3));
  sink.write(new Int16Array(4));
  expect(sink.samples).toBe(7);
});

describe("the bundled voice in Node", () => {
  it("plays on the sink the core's voice plays on, at its rate, from the package's clips", async () => {
    const sink = new RecordingSink(48_000);
    const speaker = sinkSpeaker(sink);
    expect(speaker.sampleRate).toBe(48_000);
    const clock = { now: () => 0, sleep: async () => {} }; // no waiting: the test is about what is played
    const voice = new SpokenCode(speaker, new Messages("en"), { clock });
    voice.say("042137");
    await voice.finished();
    expect(sink.samples).toBeGreaterThan(48_000 * 8); // about ten seconds
    expect(Math.max(...sink.chunks.map((chunk) => Math.max(...chunk.map(Math.abs))))).toBeGreaterThan(1000);
  });

  it("is not there without a speaker, or when the core's voice is dropped", () => {
    const codeVoice = (voice: ReturnType<typeof nodeVoice>) => voice.codeVoice?.(new Messages("en"), quietLogger);
    expect(codeVoice(nodeVoice({}))).toBeUndefined();
    expect(codeVoice(nodeVoice({ sink: new DiscardSink() }))).toBeUndefined();
    expect(codeVoice(nodeVoice({ sink: new RecordingSink() }))).toBeDefined();
  });
});
