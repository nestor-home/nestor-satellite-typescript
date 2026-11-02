import { readFile } from "node:fs/promises";
import type { Speaker } from "../voice/spoken.js";
import type { AudioSink } from "./audio.js";

/** The package's `voice/` folder: two levels up from `src/node/` and from `dist/node/`. */
const VOICE = new URL("../../voice/", import.meta.url);

/** A file of the bundled voice (`index.json`, `en/0.wav`…), read from the package. */
export async function voiceFile(path: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(new URL(path, VOICE)));
}

/** The bundled voice through an `AudioSink`, the one that plays the core's voice. */
export function sinkSpeaker(sink: AudioSink): Speaker {
  return { sampleRate: sink.sampleRate, load: voiceFile, write: (pcm) => sink.write(pcm) };
}
