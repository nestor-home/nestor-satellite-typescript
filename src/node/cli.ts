/**
 * `nestor-satellite run`: this machine's microphone and speaker as a satellite of a Nestor core.
 *
 *     nestor-satellite run --core http://nestor.local:7860 --room salon
 *
 * The first run shows a pairing code to confirm in Nestor; the token is then kept in
 * `~/.config/nestor-satellite/<id>.json`. Audio goes through a recorder and a player command
 * (`arecord`/`aplay` on Linux, SoX's `rec`/`play` on macOS) exchanging raw 48 kHz s16le mono PCM.
 */

import { hostname } from "node:os";
import { parseArgs } from "node:util";
import type { Logger } from "../log.js";
import { AUDIO_CAPTURE, AUDIO_PLAYBACK, Manifest } from "../protocol.js";
import { Satellite } from "../satellite.js";
import { SDK_VERSION } from "../version.js";
import { type AudioSink, type AudioSource, CommandSink, CommandSource, DiscardSink, SilenceSource } from "./audio.js";
import { FileTokenStore } from "./tokens.js";
import { nodeWebRtc } from "./webrtc.js";

const RATE = 48_000;
const RAW = `-t raw -b 16 -e signed-integer -c 1 -r ${RATE}`;
export const DEFAULT_INPUT =
  process.platform === "darwin" ? `rec -q ${RAW} -` : `arecord -q -t raw -f S16_LE -c 1 -r ${RATE}`;
export const DEFAULT_OUTPUT =
  process.platform === "darwin" ? `play -q ${RAW} -` : `aplay -q -t raw -f S16_LE -c 1 -r ${RATE}`;

const USAGE = `Usage: nestor-satellite run --core <url> --room <room> [options]

Run this machine's microphone and speaker as a Nestor satellite.

Options:
  --core <url>          the core's voice server, e.g. http://nestor.local:7860 (required)
  --room <slug>         the room the satellite is in: salon, cuisine… (required)
  --id <slug>           this device's id (default: the host name)
  --model <text>        this device's model (default: node-satellite)
  --brand <slug>        its maker, optional
  --token-file <path>   where the token is kept (default: ~/.config/nestor-satellite/<id>.json)
  --input <command>     recorder printing raw 48 kHz s16le mono PCM, or "none" for silence
                        (default: ${DEFAULT_INPUT})
  --output <command>    player reading raw 48 kHz s16le mono PCM, or "none" to drop the audio
                        (default: ${DEFAULT_OUTPUT})
  --ice <url>           a STUN/TURN server, repeatable; only needed beyond the local network
  -v, --verbose         say what happens
  --version             print the SDK version
  -h, --help            show this help`;

export interface Arguments {
  readonly core: string;
  readonly room: string;
  readonly id: string;
  readonly model: string;
  readonly brand: string | undefined;
  readonly tokenFile: string;
  readonly input: string;
  readonly output: string;
  readonly ice: readonly string[];
  readonly verbose: boolean;
}

export function defaultId(): string {
  const slug = (hostname().toLowerCase().split(".")[0] ?? "").replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "");
  return (slug || "satellite").slice(0, 64);
}

/** The arguments of `run`; throws a usage error when they are wrong. */
export function parse(argv: readonly string[]): Arguments | "help" | "version" {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      core: { type: "string" },
      room: { type: "string" },
      id: { type: "string" },
      model: { type: "string" },
      brand: { type: "string" },
      "token-file": { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      ice: { type: "string", multiple: true },
      verbose: { type: "boolean", short: "v" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  if (values.version) return "version";
  if (positionals.length !== 1 || positionals[0] !== "run") throw new UsageError("expected the `run` command");
  if (values.core === undefined || values.room === undefined) throw new UsageError("--core and --room are required");
  const id = values.id ?? defaultId();
  return {
    core: values.core,
    room: values.room,
    id,
    model: values.model ?? "node-satellite",
    brand: values.brand,
    tokenFile: values["token-file"] ?? `~/.config/nestor-satellite/${id}.json`,
    input: values.input ?? DEFAULT_INPUT,
    output: values.output ?? DEFAULT_OUTPUT,
    ice: values.ice ?? [],
    verbose: values.verbose ?? false,
  };
}

export class UsageError extends Error {}

export function build(args: Arguments, logger: Logger): Satellite {
  const manifest = new Manifest({ id: args.id, model: args.model, room: args.room, brand: args.brand }, [
    AUDIO_CAPTURE,
    AUDIO_PLAYBACK,
  ]);
  const source: AudioSource = args.input === "none" ? new SilenceSource(RATE) : new CommandSource(args.input);
  const sink: AudioSink = args.output === "none" ? new DiscardSink(RATE) : new CommandSink(args.output);
  return new Satellite({
    core: args.core,
    manifest,
    tokens: new FileTokenStore(args.tokenFile),
    webrtc: nodeWebRtc({ source, sink, logger }),
    iceServers: args.ice,
    logger,
  });
}

function consoleLogger(verbose: boolean): Logger {
  const say = (message: string) => console.error(`[nestor-satellite] ${message}`);
  return { debug: verbose ? say : () => {}, info: verbose ? say : () => {}, warn: say };
}

export async function main(argv: readonly string[]): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (args === "help") {
    console.log(USAGE);
    return 0;
  }
  if (args === "version") {
    console.log(SDK_VERSION);
    return 0;
  }
  const logger = consoleLogger(args.verbose);
  let satellite: Satellite;
  try {
    satellite = build(args, logger);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await satellite.run(stopping.signal);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
