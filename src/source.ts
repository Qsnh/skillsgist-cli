import { CliError } from "./errors.js";

export interface Source {
  origin: string;
  base: string;
  key: string | null;
  display: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FIRST_TWO_SEGMENTS = /^\/([^/]+)\/([^/]+)/;
const ANY_KEY_SEGMENT =
  /(?<![\w.~/\\-])((?:[a-z][a-z0-9+.-]*:\/\/[^\s/?#"'`<>]+|\[[0-9a-f:.]+\]|localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?\/+i\/+)([^/\s?#"'`<>]+)/gi;
const MIN_REGISTERED_KEY = 8;
const UNPRINTABLE = /[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu;
const knownKeys = new Set<string>();

export function maskKey(key: string): string {
  return key.length > MIN_REGISTERED_KEY ? `${key.slice(0, 4)}…` : "…";
}

export function printable(text: string): string {
  return text.replace(UNPRINTABLE, (char) => (char === "\n" || char === "\t" ? char : ""));
}

export function redact(text: string): string {
  let out = text;
  for (const key of knownKeys) out = out.split(key).join(maskKey(key));
  return out.replace(ANY_KEY_SEGMENT, (match, prefix: string, segment: string) => (segment.endsWith("…") ? match : `${prefix}${maskKey(segment)}`));
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function remember(key: string): void {
  for (const form of [key, decoded(key)]) if (form.length >= MIN_REGISTERED_KEY) knownKeys.add(form);
}

export function parseSource(input: string): Source {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(`Not a valid URL: ${redact(input)}`, { showUsage: true });
  }
  const path = url.pathname.replace(/\/{2,}/g, "/");
  const segments = FIRST_TWO_SEGMENTS.exec(path);
  const key = segments !== null && decoded(segments[1]) === "i" ? segments[2] : null;
  if (key !== null) remember(key);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CliError(`Refusing plain http to ${url.hostname}: use https`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`Unsupported URL scheme ${url.protocol} (use https)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new CliError("Refusing a URL with a username or password in it");
  }
  const base = path.replace(/\/+$/, "");
  return { origin: url.origin, base, key, display: redact(`${url.origin}${base}`) };
}
