import { CliError } from "./errors.js";

export interface Source {
  origin: string;
  base: string;
  project: string | null;
  display: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const FIRST_TWO_SEGMENTS = /^\/([^/]+)\/([^/]+)/;
const ANY_KEY_SEGMENT =
  /(?<![\w.~/\\-])((?:[a-z][a-z0-9+.-]*:\/\/[^\s/?#"'`<>]+|\[[0-9a-f:.]+\]|localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?\/+i\/+)([^/\s?#"'`<>]+)/gi;
const PREFIXED_TOKEN = /(?<![A-Za-z0-9_])(sg[dit]_)[A-Za-z0-9_-]{8,}/g;
const MIN_SECRET = 8;
const UNPRINTABLE = /[\p{Cc}‪-‮⁦-⁩]/gu;
const secrets = new Set<string>();

export function maskKey(key: string): string {
  return key.length > MIN_SECRET ? `${key.slice(0, 4)}…` : "…";
}

export function registerSecret(secret: string): void {
  if (secret.length >= MIN_SECRET) secrets.add(secret);
}

export function printable(text: string): string {
  return text.replace(UNPRINTABLE, (char) => (char === "\n" || char === "\t" ? char : ""));
}

export function oneLine(text: string): string {
  return printable(text).replace(/[\n\t]/g, " ");
}

export function redact(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(maskKey(secret));
  out = out.replace(PREFIXED_TOKEN, "$1…");
  return out.replace(ANY_KEY_SEGMENT, (match, prefix: string, segment: string) => (segment.endsWith("…") ? match : `${prefix}${maskKey(segment)}`));
}

export function displayText(text: string): string {
  return redact(printable(text));
}

export function displayLine(text: string): string {
  return redact(oneLine(text));
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function keyInUrl(origin: string): string {
  return `Install keys no longer go in the URL. Use the address on the project page (${origin}/p/<project>) and sign in with: npx skillsgist login ${origin}. In CI, set SKILLSGIST_HOST and SKILLSGIST_INSTALL_KEY instead.`;
}

export function parseSource(input: string): Source {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(`Not a valid URL: ${redact(input)}`, { showUsage: true });
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CliError(`Refusing plain http to ${url.hostname}: use https`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`Unsupported URL scheme ${url.protocol} (use https)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new CliError("Refusing a URL with a username or password in it");
  }
  const path = url.pathname.replace(/\/{2,}/g, "/");
  const segments = FIRST_TWO_SEGMENTS.exec(path);
  const first = segments === null ? null : decoded(segments[1]);
  if (first === "i") throw new CliError(keyInUrl(url.origin));
  const base = path.replace(/\/+$/, "");
  const project = segments !== null && first === "p" ? decoded(segments[2]) : null;
  return { origin: url.origin, base, project, display: redact(`${url.origin}${base}`) };
}
