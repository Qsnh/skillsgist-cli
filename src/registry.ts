import { createHash } from "node:crypto";
import { CliError } from "./errors.js";
import { authFailure, discard, readCapped, readJson, request, type FetchOptions } from "./http.js";
import { printable, redact, type Source } from "./source.js";

export type { FetchOptions } from "./http.js";

export const DISCOVERY_SCHEMA = "https://schemas.agentskills.io/discovery/0.2.0/schema.json";
export const MAX_INDEX_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

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

export function indexCandidates(source: Source): string[] {
  return [
    `${source.origin}${source.base}/.well-known/agent-skills/index.json`,
    `${source.origin}${source.base}/.well-known/skills/index.json`,
  ];
}

export async function fetchIndex(source: Source, options: FetchOptions = {}): Promise<Index | null> {
  for (const url of indexCandidates(source)) {
    const reply = await request(url, options);
    if (reply.res.status === 404) {
      await discard(reply);
      continue;
    }
    if (reply.res.status === 401 || reply.res.status === 403) throw await authFailure(reply, url);
    if (!reply.res.ok) {
      await discard(reply);
      throw new CliError(`${redact(url)} answered HTTP ${reply.res.status}`);
    }
    return parseIndex(await readJson(reply, MAX_INDEX_BYTES, redact(url)), url, source.origin);
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
  if (reply.res.status === 401 || reply.res.status === 403) throw await authFailure(reply, entry.url);
  if (!reply.res.ok) {
    await discard(reply);
    throw new CliError(`Downloading ${entry.name} failed: HTTP ${reply.res.status}`);
  }
  const bytes = await readCapped(reply, MAX_ARTIFACT_BYTES, entry.name, `Downloading ${entry.name} failed`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== entry.digest) throw new CliError(`${entry.name} does not match its sha256 digest`);
  return bytes;
}
