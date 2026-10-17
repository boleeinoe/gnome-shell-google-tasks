// Link detection in task text. No GNOME imports, so it runs under `bun test`;
// markup and launching live in textInteraction.ts.

export interface LinkRange {
  /** JS string indices, for slicing when building markup. */
  jsStart: number;
  jsEnd: number;
  /** UTF-8 byte offsets, for hit-testing against the Pango layout. */
  byteStart: number;
  byteEnd: number;
  /** The launchable URI (scheme added for bare `www.` / e-mail matches). */
  uri: string;
  /** The text as it appears in the label. */
  text: string;
}

// Only these schemes become clickable. Task text comes from Google and can be
// written by other people (tasks assigned from Docs, Chat or Gmail), and any
// other scheme hands the click to whatever local handler claims it — file://
// opens local files, and custom schemes start arbitrary installed apps.
const SAFE_URI_RE = /^(?:https?:\/\/|mailto:)/i;

export function isSafeLinkUri(uri: string): boolean {
  return SAFE_URI_RE.test(uri);
}

const LINK_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>"'`]+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/gi;

// Trailing characters that are almost always sentence punctuation rather than
// part of the address — "see https://example.com/page." shouldn't swallow the
// full stop, and a link inside brackets shouldn't swallow the closing one.
export function trimTrailingPunctuation(match: string): string {
  let end = match.length;
  while (end > 0) {
    const ch = match[end - 1];
    if ('.,;:!?"\'`'.includes(ch)) {
      end--;
      continue;
    }
    if (ch === ')' && (match.slice(0, end).match(/\(/g)?.length ?? 0) >= (match.slice(0, end).match(/\)/g)?.length ?? 0))
      break;
    if (')]}>'.includes(ch)) {
      end--;
      continue;
    }
    break;
  }
  return match.slice(0, end);
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

export function toUri(raw: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw))
    return raw;
  if (/^www\./i.test(raw))
    return `https://${raw}`;
  if (raw.includes('@'))
    return `mailto:${raw}`;
  return `https://${raw}`;
}

// Clickable links in text: web addresses (with or without a scheme) and
// e-mail addresses. Anything with another scheme stays plain text.
export function findLinks(text: string): LinkRange[] {
  if (!text)
    return [];

  const links: LinkRange[] = [];
  for (const match of text.matchAll(LINK_RE)) {
    const trimmed = trimTrailingPunctuation(match[0]);
    if (trimmed.length < 4)
      continue;
    const uri = toUri(trimmed);
    if (!isSafeLinkUri(uri))
      continue;

    const jsStart = match.index ?? 0;
    const byteStart = byteLength(text.slice(0, jsStart));
    links.push({
      jsStart,
      jsEnd: jsStart + trimmed.length,
      byteStart,
      byteEnd: byteStart + byteLength(trimmed),
      uri,
      text: trimmed,
    });
  }
  return links;
}
