import { unzipSync } from "fflate";
import { parse } from "yaml";
import { CliError } from "./errors.js";

export type SkillFiles = Map<string, Uint8Array>;

export interface ArchiveLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = { maxFiles: 1000, maxBytes: 50 * 1024 * 1024 };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const FRONTMATTER_AND_BODY = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function isSafeArchivePath(path: string): boolean {
  if (path === "" || path.startsWith("/") || path.includes("\\") || path.includes("\0") || /^[a-zA-Z]:/.test(path)) return false;
  return path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function hasNameAndDescription(skillMd: string): boolean {
  const block = FRONTMATTER.exec(skillMd.replace(/^\uFEFF/, ""))?.[1];
  if (block === undefined) return false;
  return /^name:[ \t]*\S/m.test(block) && /^description:[ \t]*\S/m.test(block);
}

export function unpackSkill(name: string, bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_LIMITS): SkillFiles {
  const scan = { files: 0, bytes: 0, problem: null as string | null };
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter(file) {
        if (scan.problem !== null || file.name.endsWith("/")) return false;
        scan.files += 1;
        scan.bytes += file.originalSize;
        if (!isSafeArchivePath(file.name)) scan.problem = `unsafe path ${JSON.stringify(file.name)}`;
        else if (scan.files > limits.maxFiles) scan.problem = `more than ${limits.maxFiles} files`;
        else if (scan.bytes > limits.maxBytes) scan.problem = `more than ${limits.maxBytes} bytes unpacked`;
        return scan.problem === null;
      },
    });
  } catch (err) {
    throw new CliError(`${name}: the archive cannot be unpacked: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (scan.problem !== null) throw new CliError(`${name}: the archive has ${scan.problem}`);
  const files: SkillFiles = new Map();
  let total = 0;
  for (const [path, data] of Object.entries(entries)) {
    total += data.length;
    files.set(path, data);
  }
  if (total > limits.maxBytes) throw new CliError(`${name}: the archive has more than ${limits.maxBytes} bytes unpacked`);
  const skillMd = files.get("SKILL.md");
  if (skillMd === undefined) throw new CliError(`${name}: the archive has no SKILL.md at its root`);
  if (!hasNameAndDescription(new TextDecoder().decode(skillMd))) {
    throw new CliError(`${name}: SKILL.md has no name and description in its frontmatter`);
  }
  return files;
}

function frontmatterData(block: string): Record<string, unknown> {
  try {
    return (parse(block, { logLevel: "error" }) ?? {}) as Record<string, unknown>;
  } catch {
    throw new Error("SKILL.md has frontmatter that is not valid YAML");
  }
}

export function trimFrontmatter(files: SkillFiles): SkillFiles {
  const skillMd = new TextDecoder().decode(files.get("SKILL.md"));
  const match = FRONTMATTER_AND_BODY.exec(skillMd);
  const data = match === null ? {} : frontmatterData(match[1]);
  const body = (match === null ? skillMd : match[2]).replace(/^\r?\n/, "");
  const kept: Record<string, unknown> = {};
  if (typeof data.description === "string") kept.description = data.description;
  if (typeof data.license === "string") kept.license = data.license;
  if (data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)) {
    const metadata = Object.fromEntries(Object.entries(data.metadata).filter(([, value]) => typeof value === "string"));
    if (Object.keys(metadata).length > 0) kept.metadata = metadata;
  }
  const lines = Object.entries(kept).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  const trimmed = lines.length === 0 ? body : `---\n${lines.join("\n")}\n---\n${body}`;
  return new Map(files).set("SKILL.md", new TextEncoder().encode(trimmed));
}
