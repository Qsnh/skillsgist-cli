import { createHash } from "node:crypto";
import { CliError } from "./errors.js";
import { printable, redact, type Source } from "./source.js";

export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
export const MAX_INDEX_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SkillEntry {
  name: string;
  description: string;
  url: string;
  digest: string;
}

export interface Index {
  skills: SkillEntry[];
  warnings: string[];
}

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Watchdog {
  signal: AbortSignal;
  reset(): void;
  stop(): void;
}

interface Reply {
  res: Response;
  watchdog: Watchdog;
}

export function indexCandidates(source: Source): string[] {
  return [
    `${source.origin}${source.base}/.well-known/agent-skills/index.json`,
    `${source.origin}${source.base}/.well-known/skills/index.json`,
  ];
}

function reason(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "timed out";
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
}

function watchdog(ms: number): Watchdog {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms).unref();
  };
  reset();
  return { signal: controller.signal, reset, stop: () => clearTimeout(timer) };
}

async function request(url: string, options: FetchOptions): Promise<Reply> {
  const dog = watchdog(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([dog.signal, options.signal]) : dog.signal;
  try {
    const res = await fetch(url, { redirect: "error", signal });
    dog.reset();
    return { res, watchdog: dog };
  } catch (err) {
    dog.stop();
    throw new CliError(`Could not reach ${redact(url)}: ${redact(reason(err))}`);
  }
}

async function discard({ res, watchdog }: Reply): Promise<void> {
  watchdog.stop();
  await res.body?.cancel();
}

async function readCapped({ res, watchdog }: Reply, limit: number, label: string, failure: string): Promise<Uint8Array> {
  try {
    if (Number(res.headers.get("content-length") ?? 0) > limit) {
      await res.body?.cancel();
      throw new CliError(`${label} is larger than ${limit} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        watchdog.reset();
        total += chunk.length;
        if (total > limit) throw new CliError(`${label} is larger than ${limit} bytes`);
        chunks.push(chunk);
      }
    }
    return Buffer.concat(chunks, total);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${failure}: ${redact(reason(err))}`);
  } finally {
    watchdog.stop();
  }
}

export async function fetchIndex(source: Source, options: FetchOptions = {}): Promise<Index | null> {
  for (const url of indexCandidates(source)) {
    const reply = await request(url, options);
    if (reply.res.status === 404) {
      await discard(reply);
      continue;
    }
    if (!reply.res.ok) {
      await discard(reply);
      throw new CliError(`${redact(url)} answered HTTP ${reply.res.status}`);
    }
    const bytes = await readCapped(reply, MAX_INDEX_BYTES, redact(url), `Could not reach ${redact(url)}`);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new CliError(`${redact(url)} is not valid JSON`);
    }
    return parseIndex(body, url, source.origin);
  }
  return null;
}

function cleanDescription(text: string): string {
  return printable(text).replace(/\s+/g, " ").trim();
}

function entryProblem(entry: Record<string, unknown>, indexUrl: string, origin: string): string | null {
  if (typeof entry.name !== "string" || entry.name.length > 64 || !NAME_RE.test(entry.name)) return "invalid name";
  if (typeof entry.description !== "string" || cleanDescription(entry.description) === "" || entry.description.length > 1024) {
    return "invalid description";
  }
  if (entry.type !== "archive") return "unsupported type";
  if (typeof entry.digest !== "string" || !DIGEST_RE.test(entry.digest)) return "invalid digest";
  if (typeof entry.url !== "string") return "missing url";
  let url: URL;
  try {
    url = new URL(entry.url, indexUrl);
  } catch {
    return "invalid url";
  }
  if (url.username !== "" || url.password !== "") return "url has a username or password in it";
  if (url.origin !== origin) return "url points to another origin";
  return null;
}

export function parseIndex(body: unknown, indexUrl: string, origin: string): Index {
  const record = body as { $schema?: unknown; skills?: unknown } | null;
  if (record === null || typeof record !== "object" || record.$schema !== DISCOVERY_SCHEMA || !Array.isArray(record.skills)) {
    throw new CliError(`${redact(indexUrl)} is not a discovery 0.2.0 index`);
  }
  const skills = new Map<string, SkillEntry>();
  const warnings: string[] = [];
  record.skills.forEach((raw: unknown, position: number) => {
    const entry = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const label = typeof entry.name === "string" && NAME_RE.test(entry.name) ? entry.name : `#${position + 1}`;
    const problem = entryProblem(entry, indexUrl, origin) ?? (skills.has(entry.name as string) ? "duplicate name" : null);
    if (problem !== null) {
      warnings.push(`Skipped index entry ${label}: ${problem}`);
      return;
    }
    skills.set(entry.name as string, {
      name: entry.name as string,
      description: cleanDescription(entry.description as string),
      url: new URL(entry.url as string, indexUrl).href,
      digest: entry.digest as string,
    });
  });
  return { skills: [...skills.values()], warnings };
}

export async function downloadArtifact(entry: SkillEntry, options: FetchOptions = {}): Promise<Uint8Array> {
  const reply = await request(entry.url, options);
  if (!reply.res.ok) {
    await discard(reply);
    throw new CliError(`Downloading ${entry.name} failed: HTTP ${reply.res.status}`);
  }
  const bytes = await readCapped(reply, MAX_ARTIFACT_BYTES, entry.name, `Downloading ${entry.name} failed`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== entry.digest) throw new CliError(`${entry.name} does not match its sha256 digest`);
  return bytes;
}
