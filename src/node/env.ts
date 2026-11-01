/**
 * What a headless device reads from its environment (P1): the pairing URI or the enrollment code a
 * person configured, and the language to speak to people in.
 *
 *     NESTOR_PAIRING_URI=nestor+http://nestor.local:8471/?code=K7QF2M9X   the core and the code
 *     NESTOR_PAIRING_CODE=K7QF-2M9X                                     the code (the core given apart)
 */

import { normalizeEnrollmentCode, parsePairingUri } from "../codes.js";
import { ProtocolError } from "../protocol.js";

export const PAIRING_URI_ENV = "NESTOR_PAIRING_URI";
export const PAIRING_CODE_ENV = "NESTOR_PAIRING_CODE";

export type Environment = Readonly<Record<string, string | undefined>>;

/** An enrollment code a person configured, and the core it names (`null`: a bare code). */
export interface Provisioning {
  readonly core: string | null;
  /** The enrollment code, canonical form. */
  readonly enrollment: string;
}

/**
 * Read a pairing URI or an enrollment code, as given on a command line or in the environment.
 * Throws a `ProtocolError` when it is malformed, or when both are given.
 */
export function readProvisioning(uri: string | undefined, code: string | undefined): Provisioning | null {
  const given = (value: string | undefined) => (value === undefined || value.trim() === "" ? undefined : value);
  const [pairingUri, pairingCode] = [given(uri), given(code)];
  if (pairingUri !== undefined && pairingCode !== undefined) {
    throw new ProtocolError("give a pairing URI or an enrollment code, not both");
  }
  if (pairingUri !== undefined) {
    const { core, code: enrollment } = parsePairingUri(pairingUri);
    return { core, enrollment };
  }
  if (pairingCode === undefined) return null;
  const enrollment = normalizeEnrollmentCode(pairingCode);
  if (enrollment === null) throw new ProtocolError(`${PAIRING_CODE_ENV}: an enrollment code looks like K7QF-2M9X`);
  return { core: null, enrollment };
}

/** `NESTOR_PAIRING_URI` or `NESTOR_PAIRING_CODE`; `null` when neither is set. */
export function provisioningFromEnv(env: Environment = process.env): Provisioning | null {
  return readProvisioning(env[PAIRING_URI_ENV], env[PAIRING_CODE_ENV]);
}

/** The languages the POSIX environment asks for (`LC_ALL`, `LC_MESSAGES`, `LANG`), best first. */
export function languagesFromEnv(env: Environment = process.env): string[] {
  return [env.LC_ALL, env.LC_MESSAGES, env.LANG].filter(
    (tag): tag is string => tag !== undefined && tag !== "" && !/^(C|POSIX)([._@].*)?$/.test(tag),
  );
}
