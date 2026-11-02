/**
 * `nestor-satellite run`: this machine's microphone and speaker, or its terminal, as a satellite of a
 * Nestor core.
 *
 *     nestor-satellite run --core http://nestor.local:8471 --room salon
 *     NESTOR_PAIRING_URI=nestor+http://nestor.local:8471/?code=K7QF2M9X nestor-satellite run --room salon
 *     nestor-satellite run --core http://nestor.local:8471 --room bureau --text --no-voice
 *
 * With an enrollment code (`--pairing-uri`, `--pairing-code`, or the same in `NESTOR_PAIRING_URI`,
 * `NESTOR_PAIRING_CODE`), the first run pairs at once; without one, it says a device code to type in
 * Nestor on its speaker (the bundled voice) and logs it. The token is then kept in `~/.config/nestor-satellite/<id>.json`. Audio goes through a recorder and a player command
 * (`arecord`/`aplay` on Linux, SoX's `rec`/`play` on macOS) exchanging raw 48 kHz s16le mono PCM.
 */

import { hostname } from "node:os";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import type { Voice } from "../audio.js";
import type { Logger } from "../log.js";
import { Manifest, ProtocolError } from "../protocol.js";
import { CapabilityNotAllowed, Satellite } from "../satellite.js";
import { SDK_VERSION } from "../version.js";
import { type AudioSink, type AudioSource, CommandSink, CommandSource, DiscardSink, SilenceSource } from "./audio.js";
import { type Environment, languagesFromEnv, PAIRING_CODE_ENV, PAIRING_URI_ENV, readProvisioning } from "./env.js";
import { FileTokenStore } from "./tokens.js";
import { nodeVoice } from "./webrtc.js";

const RATE = 48_000;
const RAW = `-t raw -b 16 -e signed-integer -c 1 -r ${RATE}`;
export const DEFAULT_INPUT =
  process.platform === "darwin" ? `rec -q ${RAW} -` : `arecord -q -t raw -f S16_LE -c 1 -r ${RATE}`;
export const DEFAULT_OUTPUT =
  process.platform === "darwin" ? `play -q ${RAW} -` : `aplay -q -t raw -f S16_LE -c 1 -r ${RATE}`;

const USAGE = `Usage: nestor-satellite run --core <url> --room <room> [options]

Run this machine's microphone and speaker, or its terminal, as a Nestor satellite.

Options:
  --core <url>          the core's voice server, e.g. http://nestor.local:8471
                        (required unless a pairing URI gives it)
  --room <slug>         the room the satellite is in: salon, cuisine… (required)
  --pairing-uri <uri>   pair with this pairing URI, made in Nestor when adding a satellite:
                        nestor+http://host:port/?code=K7QF2M9X (default: $${PAIRING_URI_ENV})
  --pairing-code <code> pair with this enrollment code, K7QF-2M9X (default: $${PAIRING_CODE_ENV})
                        without either, the satellite says and logs a device code to type in Nestor
  --id <slug>           this device's id (default: the host name)
  --model <text>        this device's model (default: node-satellite)
  --brand <slug>        its maker, optional
  --token-file <path>   where the token is kept (default: ~/.config/nestor-satellite/<id>.json)
  --input <command>     recorder printing raw 48 kHz s16le mono PCM, or "none" for silence
                        (default: ${DEFAULT_INPUT})
  --output <command>    player reading raw 48 kHz s16le mono PCM, or "none" to drop the audio
                        (default: ${DEFAULT_OUTPUT})
  --text                talk in writing too: each line typed is sent, the answers are printed
  --no-voice            no microphone nor speaker (with --text: a terminal satellite)
  --ice <url>           a STUN/TURN server, repeatable; only needed beyond the local network
  --locale <tag>        the language it speaks to people in: en, fr (default: $LC_ALL, $LANG…)
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
  readonly text: boolean;
  readonly voice: boolean;
  /** The enrollment code a person configured (canonical form), if any. */
  readonly enrollment: string | undefined;
  readonly locale: readonly string[];
  readonly verbose: boolean;
}

export function defaultId(): string {
  const slug = (hostname().toLowerCase().split(".")[0] ?? "").replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|-+$/g, "");
  return (slug || "satellite").slice(0, 64);
}

/** The arguments of `run`, then the environment; throws a usage error when they are wrong. */
export function parse(argv: readonly string[], env: Environment = process.env): Arguments | "help" | "version" {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    allowNegative: true,
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
      text: { type: "boolean" },
      voice: { type: "boolean" },
      "pairing-uri": { type: "string" },
      "pairing-code": { type: "string" },
      locale: { type: "string" },
      verbose: { type: "boolean", short: "v" },
      version: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return "help";
  if (values.version) return "version";
  if (positionals.length !== 1 || positionals[0] !== "run") throw new UsageError("expected the `run` command");
  const flags = values["pairing-uri"] !== undefined || values["pairing-code"] !== undefined;
  let provisioning: ReturnType<typeof readProvisioning>;
  try {
    provisioning = flags
      ? readProvisioning(values["pairing-uri"], values["pairing-code"])
      : readProvisioning(env[PAIRING_URI_ENV], env[PAIRING_CODE_ENV]);
  } catch (error) {
    throw new UsageError(error instanceof ProtocolError ? error.message : String(error));
  }
  const core = values.core ?? provisioning?.core ?? undefined;
  if (values.room === undefined) throw new UsageError("--room is required");
  if (core === undefined) throw new UsageError("--core is required, unless a pairing URI gives the core's address");
  const id = values.id ?? defaultId();
  return {
    core,
    room: values.room,
    id,
    model: values.model ?? "node-satellite",
    brand: values.brand,
    tokenFile: values["token-file"] ?? `~/.config/nestor-satellite/${id}.json`,
    input: values.input ?? DEFAULT_INPUT,
    output: values.output ?? DEFAULT_OUTPUT,
    ice: values.ice ?? [],
    text: values.text ?? false,
    voice: values.voice ?? true,
    enrollment: provisioning?.enrollment,
    locale: values.locale === undefined ? languagesFromEnv(env) : [values.locale],
    verbose: values.verbose ?? false,
  };
}

export class UsageError extends Error {}

/** The satellite; with `--text`, `show` prints the assistant's words. */
export function build(args: Arguments, logger: Logger, show: (text: string) => void = console.log): Satellite {
  const manifest = new Manifest({ id: args.id, model: args.model, room: args.room, brand: args.brand });
  return new Satellite({
    core: args.core,
    manifest,
    tokens: new FileTokenStore(args.tokenFile),
    ...(args.voice ? { voice: voice(args, logger) } : {}),
    ...(args.text ? { text: { input: true, display: (text: string) => show(text) } } : {}),
    // The device code is said on the speaker with the bundled voice (unless --output none or
    // --no-voice) and logged; the terminal is not a screen a person looks at while pairing. No
    // camera either, so no enrollment.qr.
    pairing: { enrollment: args.enrollment },
    locale: args.locale,
    logger,
  });
}

/** The microphone and speaker: commands that record and play raw PCM, or silence. */
function voice(args: Arguments, logger: Logger): Voice {
  const source: AudioSource = args.input === "none" ? new SilenceSource(RATE) : new CommandSource(args.input);
  const sink: AudioSink = args.output === "none" ? new DiscardSink(RATE) : new CommandSink(args.output);
  return nodeVoice({ source, sink, iceServers: args.ice, logger });
}

/** Each line typed in the terminal, sent as typed text; stops with `signal`. */
function typing(satellite: Satellite, logger: Logger, signal: AbortSignal): void {
  const lines = createInterface({ input: process.stdin, terminal: false });
  signal.addEventListener("abort", () => lines.close(), { once: true });
  lines.on("line", (line) => {
    const text = line.trim();
    if (text === "") return;
    try {
      if (!satellite.sendText(text)) logger.warn(satellite.messages.format("text-not-sent"));
    } catch (error) {
      if (!(error instanceof CapabilityNotAllowed || error instanceof ProtocolError)) throw error;
      logger.warn(error.message);
    }
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
  if (args.text) typing(satellite, logger, stopping.signal);
  try {
    await satellite.run(stopping.signal);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    stopping.abort();
  }
}
