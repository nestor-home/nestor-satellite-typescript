/**
 * The codes of `nestor.satellite/1` pairing, and the pairing URI that carries an enrollment code.
 *
 * Device code: 6 decimal digits the core gives the device, which presents them (screen, voice, log)
 * for a person to type in the admin.
 *
 * Enrollment code: 8 symbols of Crockford's base32 (`K7QF-2M9X`), made in the admin and handed to
 * the device (configured, typed or scanned). Reading one back forgives case, dashes, spaces and the
 * letters Crockford maps to digits (O → 0, I and L → 1).
 *
 * Pairing URI: `nestor+http://nestor.local:8471/?code=K7QF2M9X`, the core's base URL prefixed with
 * `nestor+`, and the enrollment code.
 */

import { ProtocolError } from "./protocol.js";

/** Crockford's base32: no I, L, O, U. */
export const ENROLLMENT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ENROLLMENT_LENGTH = 8;
export const DEVICE_CODE = /^\d{6}$/;

const ALIASES: Readonly<Record<string, string>> = { O: "0", I: "1", L: "1" };

/** The canonical form of a typed or scanned enrollment code (`k7qf-2m9x` → `K7QF2M9X`); `null` when it cannot be one. */
export function normalizeEnrollmentCode(text: string): string | null {
  const code = text
    .replace(/[\s-]/g, "")
    .toUpperCase()
    .replace(/[OIL]/g, (c) => ALIASES[c] ?? c);
  if (code.length !== ENROLLMENT_LENGTH || [...code].some((c) => !ENROLLMENT_ALPHABET.includes(c))) return null;
  return code;
}

/** How an enrollment code is shown to people: `K7QF-2M9X`. */
export function groupEnrollmentCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface PairingUri {
  /** The core's base URL, e.g. `http://nestor.local:8471`. */
  readonly core: string;
  /** The enrollment code, canonical form. */
  readonly code: string;
}

/** The core's base URL and the enrollment code of `nestor+http(s)://host:port/path/?code=…`. */
export function parsePairingUri(uri: string): PairingUri {
  const invalid = () => new ProtocolError("a pairing URI looks like nestor+http://host:port/?code=K7QF2M9X");
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw invalid();
  }
  const scheme = { "nestor+http:": "http", "nestor+https:": "https" }[url.protocol];
  const codes = url.searchParams.getAll("code");
  const code = codes.length === 1 && codes[0] !== undefined ? normalizeEnrollmentCode(codes[0]) : null;
  if (scheme === undefined || url.host === "" || code === null) throw invalid();
  return { core: `${scheme}://${url.host}${url.pathname.replace(/\/+$/, "")}`, code };
}

/**
 * What a person handed the device: a pairing URI (`core` is then its core) or a bare enrollment code
 * (`core` is `null`). `null` when it is neither.
 */
export function readEnrollment(text: string): { readonly core: string | null; readonly code: string } | null {
  if (/^nestor\+/i.test(text.trim())) {
    try {
      return parsePairingUri(text);
    } catch {
      return null;
    }
  }
  const code = normalizeEnrollmentCode(text);
  return code === null ? null : { core: null, code };
}
