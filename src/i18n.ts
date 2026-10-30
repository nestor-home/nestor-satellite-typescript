/**
 * What a satellite says to people (its device code, a refused enrollment code, why it cannot pair),
 * in their language. The catalogues are Fluent (`./locales.ts`); English is the fallback.
 *
 * The locale comes from the `locale` option, else the platform (`navigator.languages` in browsers
 * and in Node), else English. Node's CLI reads `LC_ALL`, `LC_MESSAGES` and `LANG` itself.
 */

import { FluentBundle, FluentResource } from "@fluent/bundle";
import { en, fr, type MessageId } from "./locales.js";

export type { MessageId } from "./locales.js";

const CATALOGUES = { en, fr } as const;
export type Locale = keyof typeof CATALOGUES;
export const LOCALES: readonly Locale[] = Object.freeze(Object.keys(CATALOGUES) as Locale[]);

export type MessageArgs = Readonly<Record<string, string | number>>;

/**
 * The first supported locale among `requested` (BCP 47 tags such as `fr-FR`, or POSIX ones such as
 * `fr_FR.UTF-8`), else English.
 */
export function negotiateLocale(requested: readonly (string | null | undefined)[]): Locale {
  for (const tag of requested) {
    const language = tag
      ?.trim()
      .toLowerCase()
      .split(/[-_.@]/)[0];
    const found = LOCALES.find((locale) => locale === language);
    if (found !== undefined) return found;
  }
  return "en";
}

/** The platform's preferred languages, when it says (browsers, Node 21+). */
export function platformLanguages(): readonly string[] {
  const navigator = (globalThis as { navigator?: { languages?: readonly string[]; language?: string } }).navigator;
  return navigator?.languages ?? (navigator?.language === undefined ? [] : [navigator.language]);
}

export class Messages {
  readonly locale: Locale;
  private readonly bundle: FluentBundle;
  private readonly fallback: FluentBundle;

  /** `locale`: a tag or a list of preferred tags; by default the platform's languages. */
  constructor(locale?: string | readonly string[]) {
    const requested = locale === undefined ? platformLanguages() : typeof locale === "string" ? [locale] : locale;
    this.locale = negotiateLocale(requested);
    this.bundle = bundle(this.locale);
    this.fallback = this.locale === "en" ? this.bundle : bundle("en");
  }

  /** The sentence `id` with its arguments, in this locale (in English when this locale lacks it). */
  format(id: MessageId, args: MessageArgs = {}): string {
    for (const source of [this.bundle, this.fallback]) {
      const message = source.getMessage(id);
      if (message?.value) return source.formatPattern(message.value, args);
    }
    return id;
  }
}

function bundle(locale: Locale): FluentBundle {
  const result = new FluentBundle(locale, { useIsolating: false });
  const errors = result.addResource(new FluentResource(CATALOGUES[locale]));
  if (errors.length > 0) throw new Error(`the ${locale} catalogue is broken: ${errors.join("; ")}`);
  return result;
}
