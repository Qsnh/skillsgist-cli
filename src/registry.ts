import { createHash } from "node:crypto";
import { CliError } from "./errors.js";
import { redact, type Source } from "./source.js";

export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
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
  url: string;
  skills: SkillEntry[];
  warnings: string[];
}

export interface FetchOptions {
  timeoutMs?: number;
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

async function request(url: string, options: FetchOptions): Promise<Response> {
  try {
    return await fetch(url, { redirect: "error", signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) });
  } catch (err) {
    throw new CliError(`Could not reach ${redact(url)}: ${redact(reason(err))}`);
  }
}

export async function fetchIndex(source: Source, options: FetchOptions = {}): Promise<Index | null> {
  for (const url of indexCandidates(source)) {
    const res = await request(url, options);
    if (res.status === 404) {
      await res.body?.cancel();
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new CliError(`${redact(url)} answered HTTP ${res.status}`);
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") throw new CliError(`Could not reach ${redact(url)}: timed out`);
      throw new CliError(`${redact(url)} is not valid JSON`);
    }
    return parseIndex(body, url, source.origin);
  }
  return null;
}

function entryProblem(entry: Record<string, unknown>, indexUrl: string, origin: string): string | null {
  if (typeof entry.name !== "string" || entry.name.length > 64 || !NAME_RE.test(entry.name)) return "invalid name";
  if (typeof entry.description !== "string" || entry.description.trim() === "" || entry.description.length > 1024) {
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
  if (url.origin !== origin) return "url points to another origin";
  return null;
}

async function readCapped(res: Response, name: string): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_ARTIFACT_BYTES) {
    await res.body?.cancel();
    throw new CliError(`${name} is larger than ${MAX_ARTIFACT_BYTES} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (res.body) {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > MAX_ARTIFACT_BYTES) throw new CliError(`${name} is larger than ${MAX_ARTIFACT_BYTES} bytes`);
        chunks.push(chunk);
      }
    }
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`Downloading ${name} failed: ${redact(reason(err))}`);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export function parseIndex(body: unknown, indexUrl: string, origin: string): Index {
  const record = body as { $schema?: unknown; skills?: unknown } | null;
  if (record === null || typeof record !== "object" || record.$schema !== DISCOVERY_SCHEMA || !Array.isArray(record.skills)) {
    throw new CliError(`${redact(indexUrl)} is not a discovery 0.2.0 index`);
  }
  const skills: SkillEntry[] = [];
  const warnings: string[] = [];
  record.skills.forEach((raw: unknown, position: number) => {
    const entry = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const label = typeof entry.name === "string" && NAME_RE.test(entry.name) ? entry.name : `#${position + 1}`;
    const problem = entryProblem(entry, indexUrl, origin) ?? (skills.some((skill) => skill.name === entry.name) ? "duplicate name" : null);
    if (problem !== null) {
      warnings.push(`Skipped index entry ${label}: ${problem}`);
      return;
    }
    skills.push({
      name: entry.name as string,
      description: entry.description as string,
      url: new URL(entry.url as string, indexUrl).href,
      digest: entry.digest as string,
    });
  });
  return { url: indexUrl, skills, warnings };
}

export async function downloadArtifact(entry: SkillEntry, options: FetchOptions = {}): Promise<Uint8Array> {
  const res = await request(entry.url, options);
  if (!res.ok) {
    await res.body?.cancel();
    throw new CliError(`Downloading ${entry.name} failed: HTTP ${res.status}`);
  }
  const bytes = await readCapped(res, entry.name);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== entry.digest) throw new CliError(`${entry.name} does not match its sha256 digest`);
  return bytes;
}
