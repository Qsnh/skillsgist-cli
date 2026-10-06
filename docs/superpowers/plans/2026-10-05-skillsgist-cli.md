# skillsgist CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `npx skillsgist add <url>`, a minimal Agent Skills installer that behaves like `npx skills add` for skillsgist registries but never stores the install key or sends it anywhere but the registry. Then switch the skillsgist web UI, docs and contract test over to it.

**Architecture:** The CLI is a small TypeScript ESM package. One module per job:

| Module | Job |
|---|---|
| `source` | URL rules and key masking |
| `registry` | Index and artifact fetching |
| `archive` | In-memory unzip |
| `agents` | The 73-agent table and agent detection |
| `installer` | Canonical directory, symlinks and copies |
| `add` | The flow, behind a `Ui` interface |
| `args`, `ui`, `cli` | Argument parsing, the `@clack/prompts` implementation of `Ui`, and the entry point |

Tests run in-process against a local HTTP registry, and end to end against the built `dist/cli.js` with a connection recorder preloaded. The skillsgist server keeps its protocol unchanged. Only its install commands, copy, tests, docs and `verify-cli` change.

**Tech Stack:**
- Node ≥ 20.12, TypeScript 7.0.2 (`tsc`, `module: NodeNext`), vitest 5.0.3
- Runtime dependencies: `@clack/prompts` 1.8.1 and `fflate` 0.8.3
- The skillsgist side is Hono JSX on Cloudflare Workers with vitest-pool-workers

**Spec:** `docs/superpowers/specs/2026-10-05-skillsgist-cli-design.md` (in this repo)

## Global Constraints

- **Runtime:** Node `>=20.12` (`engines`), ESM only (`"type": "module"`), relative imports end in `.js`.
- **Runtime dependencies:** exactly `@clack/prompts@1.8.1` and `fflate@0.8.3`, pinned with `--save-exact`. No other runtime dependency and no install scripts.
- **Dev dependencies:** `typescript@7.0.2`, `vitest@5.0.3` and `@types/node@20`, all pinned.
- **Nothing on disk but the skills:** the CLI writes only skill files and the symlinks to them. No lock file, state file, cache or temp file. Archives are unpacked in memory.
- **No requests but to the given origin:** the only requests are the index and the artifacts, both on the input URL's origin. `redirect: "error"`, a 30-second timeout, no telemetry.
- **No key in output:** every string the CLI prints goes through `redact()`. Keys show as their first 4 characters plus `…`. No stack traces, no debug switch.
- **Exit codes:** `0` for success, `--list` and user cancel; `1` for everything else.
- **Code style:** no comments in code (the sibling repo's `CLAUDE.md` rule, applied to both repos). English identifiers, docs and commit messages.
- **skillsgist UI text:** English first, then `zh-CN`, `zh-TW` (Taiwan wording) and `ja`, in `src/i18n/*.ts` only.
- **Server protocol:** unchanged, so `npx skills add` keeps working.
- **Reference behavior:** `skills@1.5.18`. Where this plan departs from it, the spec says so.

## Review Focus

1. **The agent directory already resolves to the canonical one.** For example, `.claude/skills` is a symlink to `.agents/skills`. Linking must be a no-op and must never delete the canonical copy. Pinned in Task 5.
2. **An index entry with a relative `url`.** It must resolve against the index URL, so it inherits `/i/<key>/`, and still pass the same-origin check. Pinned in Task 2.
3. **The registry can't be reached at all** (connection refused). The error must still mask the key. Pinned in Task 2.
4. **Running the same install twice.** The second run must succeed, keep the links valid and report the overwrite. Pinned in Task 6.
5. **`-s` given in mixed case** (`-s Demo-Skill`). It must match the lowercase index name. Pinned in Task 6.

## File Map

`skillsgist-cli` (this repo, branch `feat/skillsgist-cli`, already checked out):

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE` | Package and toolchain |
| `src/errors.ts` | `CliError`: the user-facing error type |
| `src/source.ts` | Parse and validate the input URL, register its key, `redact()` and `maskKey()` |
| `src/registry.ts` | Index candidates, `fetchIndex`, `parseIndex`, `downloadArtifact` |
| `src/archive.ts` | `unpackSkill`, path and size checks, the SKILL.md frontmatter check |
| `src/agents.ts` | The 73-agent table, `loadAgents`, `detectRunningAgent` |
| `src/installer.ts` | `sanitizeName`, target directories, `installSkill`, `existingTargets` |
| `src/add.ts` | The `Ui` interface, `runAdd`, summary and result output |
| `src/args.ts` | `parseCommandLine`, `USAGE` |
| `src/ui.ts` | The `@clack/prompts` implementation of `Ui`, which redacts everything |
| `src/cli.ts` | The `bin` entry |
| `test/helpers/registry.ts` | Local HTTP registry and zip fixtures |
| `test/helpers/fs.ts` | Temp dirs, sandboxed `exists`, key scanning |
| `test/fixtures/record-connections.mjs` | `--import` preload that logs every TCP connection |
| `test/*.test.ts` | One test file per module, plus `e2e.test.ts` |
| `README.md` | Usage, guarantees and limits |

`errors.ts`, `args.ts` and `ui.ts` are small additions to the spec's module list. They keep `cli.ts` a two-line entry, and `args.ts` lets tests import the parser without running the program.

`skillsgist` (sibling repo `../skillsgist`, new branch `feat/skillsgist-cli`):

| Path | Change |
|---|---|
| `src/views/skills.tsx`, `src/views/projects.tsx` | `npx skills` becomes `npx skillsgist` |
| `src/i18n/{en,zh-CN,zh-TW,ja}.ts` | `heroAnon` and `commandKeyNote` |
| `test/{skills,projects,users,i18n}.test.ts` | Assertions |
| `scripts/verify-cli.mjs` | The agent prompt runs skillsgist, and nothing under `HOME` may hold the key |
| `README.md`, `PRODUCT.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `scripts/social-preview.html` | Docs |
| `docs/images/*.png`, `public/og.png` | Regenerated |

---

### Task 1: Package scaffold, `CliError` and `source`

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`
- Create: `src/errors.ts`, `src/source.ts`
- Test: `test/source.test.ts`

**Interfaces:**
- Produces:
  - `class CliError extends Error { readonly showUsage: boolean; constructor(message: string, options?: { showUsage?: boolean }) }`
  - `interface Source { origin: string; base: string; key: string | null; display: string }`
  - `parseSource(input: string): Source`
  - `redact(text: string): string`
  - `maskKey(key: string): string`

- [ ] **Step 1: Write the package files**

`package.json`:

```json
{
  "name": "skillsgist",
  "version": "0.1.0",
  "description": "Install Agent Skills from a skillsgist registry without storing its install key.",
  "keywords": ["agent-skills", "skills", "skillsgist", "claude-code", "codex", "cursor", "cli"],
  "license": "MIT",
  "author": "Qsnh",
  "type": "module",
  "bin": {
    "skillsgist": "dist/cli.js"
  },
  "files": ["dist"],
  "engines": {
    "node": ">=20.12"
  },
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit",
    "test": "npm run build && vitest run",
    "prepublishOnly": "npm test"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src"]
}
```

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
```

`.gitignore`:

```
node_modules
dist
```

Then copy the license from the sibling repo:

```bash
cp ../skillsgist/LICENSE LICENSE
```

- [ ] **Step 2: Install the pinned dependencies**

```bash
npm install --save-exact @clack/prompts@1.8.1 fflate@0.8.3
npm install --save-dev --save-exact typescript@7.0.2 vitest@5.0.3 @types/node@20
```

Expected: `package.json` gains `dependencies` and `devDependencies` with exact versions, and `package-lock.json` is created.

- [ ] **Step 3: Write the failing test**

`test/source.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { maskKey, parseSource, redact } from "../src/source.js";

const KEY = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

function failure(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

describe("parseSource", () => {
  it("reads the origin and an empty base from a bare origin", () => {
    expect(parseSource("https://skills.example.com")).toEqual({
      origin: "https://skills.example.com",
      base: "",
      key: null,
      display: "https://skills.example.com",
    });
  });

  it("keeps a project path and drops a trailing slash, query and fragment", () => {
    expect(parseSource("https://skills.example.com/p/team/?x=1#top")).toMatchObject({
      base: "/p/team",
      key: null,
      display: "https://skills.example.com/p/team",
    });
  });

  it("extracts the install key and masks it in the display form", () => {
    expect(parseSource(`https://skills.example.com/i/${KEY}/`)).toEqual({
      origin: "https://skills.example.com",
      base: `/i/${KEY}`,
      key: KEY,
      display: "https://skills.example.com/i/0123…",
    });
  });

  it("keeps the single-skill path under a key", () => {
    const source = parseSource(`https://skills.example.com/i/${KEY}/.well-known/agent-skills/demo-skill`);
    expect(source.base).toBe(`/i/${KEY}/.well-known/agent-skills/demo-skill`);
    expect(source.display).toBe("https://skills.example.com/i/0123…/.well-known/agent-skills/demo-skill");
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787/p/team", "http://[::1]:8080"])(
    "accepts plain http to the loopback address %s",
    (url) => {
      expect(() => parseSource(url)).not.toThrow();
    },
  );

  it("refuses plain http to any other host without echoing the key", () => {
    const message = failure(() => parseSource(`http://skills.example.com/i/${KEY}`));
    expect(message).toMatch(/use https/);
    expect(message).not.toContain(KEY);
  });

  it("refuses other schemes", () => {
    expect(failure(() => parseSource("ftp://skills.example.com"))).toMatch(/Unsupported URL scheme ftp:/);
  });

  it("refuses a username or password in the URL", () => {
    expect(failure(() => parseSource("https://user:pass@skills.example.com"))).toMatch(/username or password/);
  });

  it("masks a key inside an input that is not a URL", () => {
    const message = failure(() => parseSource(`skills.example.com/i/${OTHER}`));
    expect(message).toMatch(/Not a valid URL/);
    expect(message).not.toContain(OTHER);
  });
});

describe("redact", () => {
  it("masks a parsed key wherever it appears", () => {
    parseSource(`https://skills.example.com/i/${KEY}`);
    expect(redact(`boom ${KEY} boom`)).toBe("boom 0123… boom");
  });

  it("masks any /i/ segment even when no key was parsed", () => {
    expect(redact(`https://h.example/i/${OTHER}/d/x/1.zip`)).toBe("https://h.example/i/fedc…/d/x/1.zip");
  });

  it("is idempotent", () => {
    const once = redact(`https://h.example/i/${OTHER}`);
    expect(redact(once)).toBe(once);
  });
});

describe("maskKey", () => {
  it("keeps four characters of a long key", () => {
    expect(maskKey(KEY)).toBe("0123…");
  });

  it("hides a short key entirely", () => {
    expect(maskKey("abc")).toBe("…");
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `npx vitest run test/source.test.ts`
Expected: FAIL, because `../src/source.js` cannot be resolved.

- [ ] **Step 5: Implement `errors.ts` and `source.ts`**

`src/errors.ts`:

```ts
export class CliError extends Error {
  readonly showUsage: boolean;

  constructor(message: string, options: { showUsage?: boolean } = {}) {
    super(message);
    this.name = "CliError";
    this.showUsage = options.showUsage ?? false;
  }
}
```

`src/source.ts`:

```ts
import { CliError } from "./errors.js";

export interface Source {
  origin: string;
  base: string;
  key: string | null;
  display: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const KEY_IN_PATH = /^\/i\/([^/]+)/;
const ANY_KEY_SEGMENT = /\/i\/([^/\s?#"'`<>]+)/g;
const MIN_REGISTERED_KEY = 8;
const knownKeys = new Set<string>();

export function maskKey(key: string): string {
  return key.length > MIN_REGISTERED_KEY ? `${key.slice(0, 4)}…` : "…";
}

export function redact(text: string): string {
  let out = text;
  for (const key of knownKeys) out = out.split(key).join(maskKey(key));
  return out.replace(ANY_KEY_SEGMENT, (match, segment: string) => (segment.endsWith("…") ? match : `/i/${maskKey(segment)}`));
}

export function parseSource(input: string): Source {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new CliError(`Not a valid URL: ${redact(input)}`, { showUsage: true });
  }
  const key = KEY_IN_PATH.exec(url.pathname)?.[1] ?? null;
  if (key !== null && key.length >= MIN_REGISTERED_KEY) knownKeys.add(key);
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new CliError(`Refusing plain http to ${url.hostname}: use https`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError(`Unsupported URL scheme ${url.protocol} (use https)`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new CliError("Refusing a URL with a username or password in it");
  }
  const base = url.pathname.replace(/\/+$/, "");
  return { origin: url.origin, base, key, display: redact(`${url.origin}${base}`) };
}
```

- [ ] **Step 6: Run the tests and the type check**

Run: `npx vitest run test/source.test.ts && npm run typecheck`
Expected: all source tests pass; `tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore LICENSE src/errors.ts src/source.ts test/source.test.ts
git commit -m "feat: parse registry URLs and mask install keys"
```

---

### Task 2: Registry client

**Files:**
- Create: `src/registry.ts`
- Create: `test/helpers/registry.ts`
- Test: `test/registry.test.ts`

**Interfaces:**
- Consumes: `Source`, `parseSource`, `redact` (Task 1); `CliError`.
- Produces:
  - `DISCOVERY_SCHEMA: string`
  - `MAX_ARTIFACT_BYTES: number`
  - `interface SkillEntry { name: string; description: string; url: string; digest: string }`
  - `interface Index { url: string; skills: SkillEntry[]; warnings: string[] }`
  - `interface FetchOptions { timeoutMs?: number }`
  - `indexCandidates(source: Source): string[]`
  - `fetchIndex(source: Source, options?: FetchOptions): Promise<Index | null>`. Returns `null` when both candidates are 404.
  - `parseIndex(body: unknown, indexUrl: string, origin: string): Index`
  - `downloadArtifact(entry: SkillEntry, options?: FetchOptions): Promise<Uint8Array>`
  - Test helpers:
    - `KEY`
    - `startRegistry(): Promise<TestRegistry>`
    - `publishIndex(registry, basePath, skills, options?)`
    - `skillZip(name, extra?)`
    - `skillMd(name)`
    - `digestOf(bytes)`

- [ ] **Step 1: Write the test helper**

`test/helpers/registry.ts`:

```ts
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { strToU8, zipSync } from "fflate";
import { DISCOVERY_SCHEMA } from "../../src/registry.js";

export const KEY = "0123456789abcdef0123456789abcdef";

export interface Route {
  status?: number;
  body: string | Uint8Array;
  type?: string;
  headers?: Record<string, string>;
  delayMs?: number;
}

export interface TestRegistry {
  origin: string;
  requests: string[];
  routes: Map<string, Route>;
  close(): Promise<void>;
}

export interface Published {
  name: string;
  zip: Uint8Array;
}

export async function startRegistry(): Promise<TestRegistry> {
  const routes = new Map<string, Route>();
  const requests: string[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    requests.push(path);
    const route = routes.get(path);
    const send = () => {
      if (!route) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(route.status ?? 200, { "content-type": route.type ?? "application/octet-stream", ...route.headers });
      res.end(route.body);
    };
    if (route?.delayMs) setTimeout(send, route.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    routes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export function skillMd(name: string): string {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n# ${name}\n`;
}

export function skillZip(name: string, extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = { "SKILL.md": strToU8(skillMd(name)) };
  for (const [path, text] of Object.entries(extra)) files[path] = strToU8(text);
  return zipSync(files);
}

export function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function publishIndex(
  registry: TestRegistry,
  basePath: string,
  skills: Published[],
  options: { wellKnown?: "agent-skills" | "skills"; overrides?: Array<Record<string, unknown>> } = {},
): void {
  const entries = skills.map((skill) => {
    const digest = digestOf(skill.zip);
    const path = `${basePath}/d/${skill.name}/${digest.slice("sha256:".length)}.zip`;
    registry.routes.set(path, { body: skill.zip, type: "application/zip" });
    return { name: skill.name, description: `The ${skill.name} skill.`, type: "archive", url: `${registry.origin}${path}`, digest };
  });
  registry.routes.set(`${basePath}/.well-known/${options.wellKnown ?? "agent-skills"}/index.json`, {
    type: "application/json",
    body: JSON.stringify({ $schema: DISCOVERY_SCHEMA, skills: [...entries, ...(options.overrides ?? [])] }),
  });
}
```

- [ ] **Step 2: Write the failing test**

`test/registry.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DISCOVERY_SCHEMA, downloadArtifact, fetchIndex, indexCandidates, parseIndex } from "../src/registry.js";
import { parseSource } from "../src/source.js";
import { KEY, publishIndex, skillZip, startRegistry, type TestRegistry } from "./helpers/registry.js";

let registry: TestRegistry;

beforeAll(async () => {
  registry = await startRegistry();
});

afterAll(() => registry.close());

beforeEach(() => {
  registry.routes.clear();
  registry.requests.length = 0;
});

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

const keyed = () => parseSource(`${registry.origin}/i/${KEY}`);
const indexPath = `/i/${KEY}/.well-known/agent-skills/index.json`;

describe("indexCandidates", () => {
  it("looks under the given path only, agent-skills first", () => {
    expect(indexCandidates(parseSource(`https://h.example/i/${KEY}`))).toEqual([
      `https://h.example/i/${KEY}/.well-known/agent-skills/index.json`,
      `https://h.example/i/${KEY}/.well-known/skills/index.json`,
    ]);
  });
});

describe("fetchIndex", () => {
  it("reads the index under a keyed path", async () => {
    publishIndex(registry, `/i/${KEY}`, [{ name: "demo-skill", zip: skillZip("demo-skill") }]);
    const index = await fetchIndex(keyed());
    expect(index?.skills.map((skill) => skill.name)).toEqual(["demo-skill"]);
    expect(index?.warnings).toEqual([]);
  });

  it("falls back to /.well-known/skills when agent-skills is missing", async () => {
    publishIndex(registry, `/i/${KEY}`, [{ name: "demo-skill", zip: skillZip("demo-skill") }], { wellKnown: "skills" });
    expect((await fetchIndex(keyed()))?.url).toBe(`${registry.origin}/i/${KEY}/.well-known/skills/index.json`);
  });

  it("returns null when neither candidate exists and never asks the origin's root", async () => {
    publishIndex(registry, "", [{ name: "public-skill", zip: skillZip("public-skill") }]);
    expect(await fetchIndex(keyed())).toBeNull();
    expect(registry.requests).toEqual([indexPath, `/i/${KEY}/.well-known/skills/index.json`]);
  });

  it("fails on a server error without echoing the key", async () => {
    registry.routes.set(indexPath, { status: 500, body: "boom" });
    const message = await failure(fetchIndex(keyed()));
    expect(message).toContain("HTTP 500");
    expect(message).toContain("/i/0123…/");
    expect(message).not.toContain(KEY);
  });

  it("fails on a body that is not JSON", async () => {
    registry.routes.set(indexPath, { body: "<html>", type: "text/html" });
    expect(await failure(fetchIndex(keyed()))).toMatch(/is not valid JSON/);
  });

  it("rejects an index that is not discovery 0.2.0", async () => {
    registry.routes.set(indexPath, { type: "application/json", body: JSON.stringify({ skills: [] }) });
    expect(await failure(fetchIndex(keyed()))).toMatch(/is not a discovery 0\.2\.0 index/);
  });

  it("refuses to follow a redirect", async () => {
    registry.routes.set(indexPath, { status: 302, body: "", headers: { location: "https://elsewhere.example/" } });
    const message = await failure(fetchIndex(keyed()));
    expect(message).toMatch(/Could not reach/);
    expect(message).not.toContain(KEY);
  });

  it("gives up after the timeout", async () => {
    registry.routes.set(indexPath, { body: "{}", delayMs: 500 });
    expect(await failure(fetchIndex(keyed(), { timeoutMs: 100 }))).toMatch(/timed out/);
  });

  it("masks the key when the registry cannot be reached at all", async () => {
    const closed = await startRegistry();
    await closed.close();
    const message = await failure(fetchIndex(parseSource(`${closed.origin}/i/${KEY}`)));
    expect(message).toMatch(/Could not reach/);
    expect(message).not.toContain(KEY);
  });
});

describe("parseIndex", () => {
  const indexUrl = `https://h.example/i/${KEY}/.well-known/agent-skills/index.json`;
  const good = {
    name: "demo-skill",
    description: "Demo.",
    type: "archive",
    url: `https://h.example/i/${KEY}/d/demo-skill/${"a".repeat(64)}.zip`,
    digest: `sha256:${"a".repeat(64)}`,
  };

  it("resolves a relative url against the index url", () => {
    const index = parseIndex({ $schema: DISCOVERY_SCHEMA, skills: [{ ...good, url: "../../d/demo-skill/x.zip" }] }, indexUrl, "https://h.example");
    expect(index.skills[0].url).toBe(`https://h.example/i/${KEY}/d/demo-skill/x.zip`);
  });

  it.each<[Record<string, unknown>, string]>([
    [{ ...good, name: "Bad Name" }, "invalid name"],
    [{ ...good, name: "a".repeat(65) }, "invalid name"],
    [{ ...good, description: " " }, "invalid description"],
    [{ ...good, type: "skill-md" }, "unsupported type"],
    [{ ...good, digest: "sha256:xyz" }, "invalid digest"],
    [{ ...good, url: "https://evil.example/x.zip" }, "url points to another origin"],
  ])("skips the entry %j", (entry, reason) => {
    const index = parseIndex({ $schema: DISCOVERY_SCHEMA, skills: [entry, { ...good, name: "kept-skill" }] }, indexUrl, "https://h.example");
    expect(index.skills.map((skill) => skill.name)).toEqual(["kept-skill"]);
    expect(index.warnings).toHaveLength(1);
    expect(index.warnings[0]).toContain(reason);
    expect(index.warnings[0]).not.toContain("https://");
  });

  it("skips a second entry with the same name", () => {
    const index = parseIndex({ $schema: DISCOVERY_SCHEMA, skills: [good, good] }, indexUrl, "https://h.example");
    expect(index.skills).toHaveLength(1);
    expect(index.warnings).toEqual(["Skipped index entry demo-skill: duplicate name"]);
  });
});

describe("downloadArtifact", () => {
  it("returns the bytes when the digest matches", async () => {
    const zip = skillZip("demo-skill");
    publishIndex(registry, `/i/${KEY}`, [{ name: "demo-skill", zip }]);
    const index = await fetchIndex(keyed());
    expect(await downloadArtifact(index!.skills[0])).toEqual(zip);
  });

  it("fails when the bytes do not match the digest", async () => {
    publishIndex(registry, `/i/${KEY}`, [{ name: "demo-skill", zip: skillZip("demo-skill") }]);
    const index = await fetchIndex(keyed());
    registry.routes.set(new URL(index!.skills[0].url).pathname, { body: skillZip("demo-skill", { "extra.md": "tampered" }) });
    expect(await failure(downloadArtifact(index!.skills[0]))).toMatch(/sha256/);
  });

  it("fails on a missing artifact without echoing the key", async () => {
    const message = await failure(
      downloadArtifact({
        name: "demo-skill",
        description: "Demo.",
        url: `${registry.origin}/i/${KEY}/d/demo-skill/${"0".repeat(64)}.zip`,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    );
    expect(message).toMatch(/HTTP 404/);
    expect(message).not.toContain(KEY);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/registry.test.ts`
Expected: FAIL, because `../src/registry.js` cannot be resolved.

- [ ] **Step 4: Implement `src/registry.ts`**

```ts
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
    if (!res.ok) throw new CliError(`${redact(url)} answered HTTP ${res.status}`);
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
  if (!res.ok) throw new CliError(`Downloading ${entry.name} failed: HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_ARTIFACT_BYTES) {
    throw new CliError(`${entry.name} is larger than ${MAX_ARTIFACT_BYTES} bytes`);
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (err) {
    throw new CliError(`Downloading ${entry.name} failed: ${redact(reason(err))}`);
  }
  if (bytes.length > MAX_ARTIFACT_BYTES) throw new CliError(`${entry.name} is larger than ${MAX_ARTIFACT_BYTES} bytes`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== entry.digest) throw new CliError(`${entry.name} does not match its sha256 digest`);
  return bytes;
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run test/registry.test.ts && npm run typecheck`
Expected: all registry tests pass; `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/registry.ts test/helpers/registry.ts test/registry.test.ts
git commit -m "feat: fetch discovery indexes and artifacts from the given origin only"
```

---

### Task 3: In-memory archive unpacking

**Files:**
- Create: `src/archive.ts`
- Test: `test/archive.test.ts`

**Interfaces:**
- Consumes: `CliError`; test helper `skillMd` (Task 2).
- Produces:
  - `type SkillFiles = Map<string, Uint8Array>`
  - `interface ArchiveLimits { maxFiles: number; maxBytes: number }`
  - `DEFAULT_LIMITS`
  - `isSafeArchivePath(path: string): boolean`
  - `hasNameAndDescription(skillMd: string): boolean`
  - `unpackSkill(name: string, bytes: Uint8Array, limits?: ArchiveLimits): SkillFiles`

- [ ] **Step 1: Write the failing test**

`test/archive.test.ts`:

```ts
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { hasNameAndDescription, isSafeArchivePath, unpackSkill } from "../src/archive.js";
import { skillMd } from "./helpers/registry.js";

const zip = (files: Record<string, string>) =>
  zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));

function failure(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

describe("unpackSkill", () => {
  it("returns every file keyed by its path and skips directory entries", () => {
    const bytes = zipSync({
      "SKILL.md": strToU8(skillMd("demo-skill")),
      "references/": new Uint8Array(0),
      "references/api.md": strToU8("api"),
    });
    const files = unpackSkill("demo-skill", bytes);
    expect([...files.keys()].sort()).toEqual(["SKILL.md", "references/api.md"]);
    expect(new TextDecoder().decode(files.get("references/api.md"))).toBe("api");
  });

  it.each(["../evil.md", "a/../../evil.md", "/etc/evil", "C:/evil.md", "a\\evil.md", "./other.md"])(
    "rejects the unsafe path %s",
    (path) => {
      expect(failure(() => unpackSkill("demo-skill", zip({ "SKILL.md": skillMd("demo-skill"), [path]: "x" })))).toMatch(/unsafe path/);
    },
  );

  it("rejects more files than the limit", () => {
    const extra = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [`f${i}.md`, "x"]));
    const bytes = zip({ "SKILL.md": skillMd("demo-skill"), ...extra });
    expect(failure(() => unpackSkill("demo-skill", bytes, { maxFiles: 3, maxBytes: 10_000 }))).toMatch(/more than 3 files/);
  });

  it("rejects more unpacked bytes than the limit", () => {
    const bytes = zip({ "SKILL.md": skillMd("demo-skill"), "big.md": "x".repeat(5000) });
    expect(failure(() => unpackSkill("demo-skill", bytes, { maxFiles: 10, maxBytes: 1000 }))).toMatch(/more than 1000 bytes/);
  });

  it("requires SKILL.md at the root, spelled exactly", () => {
    expect(failure(() => unpackSkill("demo-skill", zip({ "demo-skill/SKILL.md": skillMd("demo-skill") })))).toMatch(/no SKILL\.md at its root/);
    expect(failure(() => unpackSkill("demo-skill", zip({ "skill.md": skillMd("demo-skill") })))).toMatch(/no SKILL\.md at its root/);
  });

  it("requires a name and a description in the frontmatter", () => {
    expect(failure(() => unpackSkill("demo-skill", zip({ "SKILL.md": "---\nname: demo-skill\n---\n" })))).toMatch(/no name and description/);
  });

  it("rejects bytes that are not a zip", () => {
    expect(failure(() => unpackSkill("demo-skill", strToU8("not a zip")))).toMatch(/not a valid zip/);
  });
});

describe("isSafeArchivePath", () => {
  it("accepts nested relative paths", () => {
    expect(isSafeArchivePath("references/deep/api.md")).toBe(true);
  });

  it("rejects an empty segment", () => {
    expect(isSafeArchivePath("a//b.md")).toBe(false);
  });
});

describe("hasNameAndDescription", () => {
  it("accepts a folded description", () => {
    expect(hasNameAndDescription("---\nname: x\ndescription: >-\n  folded\n---\n")).toBe(true);
  });

  it("accepts CRLF line endings and a byte order mark", () => {
    expect(hasNameAndDescription("\uFEFF---\r\nname: x\r\ndescription: y\r\n---\r\n")).toBe(true);
  });

  it("rejects a file without frontmatter", () => {
    expect(hasNameAndDescription("# x\n")).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(hasNameAndDescription("---\nname:\ndescription: y\n---\n")).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/archive.test.ts`
Expected: FAIL, because `../src/archive.js` cannot be resolved.

- [ ] **Step 3: Implement `src/archive.ts`**

```ts
import { unzipSync } from "fflate";
import { CliError } from "./errors.js";

export type SkillFiles = Map<string, Uint8Array>;

export interface ArchiveLimits {
  maxFiles: number;
  maxBytes: number;
}

export const DEFAULT_LIMITS: ArchiveLimits = { maxFiles: 1000, maxBytes: 50 * 1024 * 1024 };

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

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
  } catch {
    throw new CliError(`${name}: the archive is not a valid zip file`);
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
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run test/archive.test.ts && npm run typecheck`
Expected: all archive tests pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/archive.ts test/archive.test.ts
git commit -m "feat: unpack skill archives in memory with path and size checks"
```

---

### Task 4: Agent table and detection

**Files:**
- Create: `src/agents.ts`
- Create: `test/helpers/fs.ts`
- Test: `test/agents.test.ts`

**Interfaces:**
- Produces:
  - `CANONICAL_SKILLS_DIR = ".agents/skills"`
  - `type Exists = (path: string) => boolean`
  - `interface Agent { id: string; displayName: string; skillsDir: string; globalDir: string | null; canonical: boolean; universal: boolean; hidden: boolean; installed: boolean }`
    - `canonical`: the agent installs into `.agents/skills`.
    - `universal`: the agent is in the always-included group (canonical, excluding `replit` and `universal`).
    - `hidden`: the agent is not named in that group's display.
  - `interface AgentEnvironment { home: string; cwd: string; env: NodeJS.ProcessEnv; exists?: Exists }`
  - `loadAgents(environment: AgentEnvironment): Agent[]` (table order)
  - `interface RunningAgent { inAgent: boolean; id: string | null }`
  - `detectRunningAgent(env: NodeJS.ProcessEnv, exists?: Exists): RunningAgent`
  - Test helpers:
    - `tempDir(): string` (realpath'd)
    - `cleanup(): void`
    - `sandboxExists(...roots: string[]): Exists`
    - `filesContaining(root: string, needle: string): string[]`

- [ ] **Step 1: Write the fs test helper**

`test/helpers/fs.ts`:

```ts
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "skillsgist-test-")));
  made.push(dir);
  return dir;
}

export function cleanup(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export function sandboxExists(...roots: string[]): (path: string) => boolean {
  return (path) => roots.some((root) => path === root || path.startsWith(`${root}/`)) && existsSync(path);
}

export function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        if (readlinkSync(path).includes(needle)) hits.push(path);
      } else if (stat.isDirectory()) {
        walk(path);
      } else if (readFileSync(path).includes(needle)) {
        hits.push(path);
      }
    }
  };
  if (existsSync(root)) walk(root);
  return hits;
}
```

- [ ] **Step 2: Write the failing test**

`test/agents.test.ts`:

```ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectRunningAgent, loadAgents, type Agent } from "../src/agents.js";
import { cleanup, sandboxExists, tempDir } from "./helpers/fs.js";

afterEach(cleanup);

const none = () => false;
const only = (...paths: string[]) => (path: string) => paths.includes(path);
const load = (env: NodeJS.ProcessEnv = {}, exists: (path: string) => boolean = none) => loadAgents({ home: "/h", cwd: "/w", env, exists });
const byId = (agents: Agent[], id: string) => agents.find((agent) => agent.id === id)!;

describe("loadAgents", () => {
  it("knows the 73 agents of skills 1.5.18, each once", () => {
    const ids = load().map((agent) => agent.id);
    expect(ids).toHaveLength(73);
    expect(new Set(ids).size).toBe(73);
  });

  it("puts the 17 universal agents in .agents/skills and hides four of them", () => {
    const agents = load();
    expect(agents.filter((agent) => agent.universal).map((agent) => agent.id)).toEqual([
      "amp", "antigravity", "antigravity-cli", "cline", "codex", "cursor", "deepagents", "dexto", "firebender",
      "gemini-cli", "github-copilot", "kimi-code-cli", "loaf", "opencode", "warp", "zed", "promptscript",
    ]);
    expect(agents.filter((agent) => agent.hidden).map((agent) => agent.id)).toEqual(["dexto", "firebender", "loaf", "promptscript"]);
    expect(byId(agents, "replit")).toMatchObject({ canonical: true, universal: false });
    expect(byId(agents, "universal")).toMatchObject({ canonical: true, universal: false });
  });

  it("resolves global directories from the home directory", () => {
    const agents = load();
    expect(byId(agents, "claude-code").globalDir).toBe("/h/.claude/skills");
    expect(byId(agents, "windsurf").globalDir).toBe("/h/.codeium/windsurf/skills");
    expect(byId(agents, "opencode").globalDir).toBe("/h/.config/opencode/skills");
    expect(byId(agents, "eve").globalDir).toBeNull();
    expect(byId(agents, "promptscript").globalDir).toBeNull();
  });

  it("honours the agents' home overrides and ignores blank ones", () => {
    const agents = load({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "  ", XDG_CONFIG_HOME: "/x" });
    expect(byId(agents, "claude-code").globalDir).toBe("/c/skills");
    expect(byId(agents, "codex").globalDir).toBe("/h/.codex/skills");
    expect(byId(agents, "opencode").globalDir).toBe("/x/opencode/skills");
    expect(byId(agents, "crush").globalDir).toBe("/h/.config/crush/skills");
  });

  it("detects agents by their marker paths", () => {
    const agents = load({}, only("/h/.claude", "/h/.codeium/windsurf", "/etc/codex"));
    expect(agents.filter((agent) => agent.installed).map((agent) => agent.id)).toEqual(["claude-code", "codex", "windsurf"]);
  });

  it("picks OpenClaw's legacy directory when only that one exists", () => {
    expect(byId(load({}, only("/h/.clawdbot")), "openclaw").globalDir).toBe("/h/.clawdbot/skills");
  });

  it("detects Eve only with an agent directory and an eve dependency", () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, "agent"));
    const eve = () => byId(loadAgents({ home: "/h", cwd, env: {}, exists: sandboxExists(cwd) }), "eve").installed;
    expect(eve()).toBe(false);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ dependencies: { eve: "1.0.0" } }));
    expect(eve()).toBe(true);
  });
});

describe("detectRunningAgent", () => {
  it.each<[NodeJS.ProcessEnv, string | null]>([
    [{ CLAUDECODE: "1" }, "claude-code"],
    [{ CLAUDE_CODE: "1", CLAUDE_CODE_IS_COWORK: "1" }, "claude-code"],
    [{ CODEX_SANDBOX: "seatbelt" }, "codex"],
    [{ GEMINI_CLI: "1" }, "gemini-cli"],
    [{ OPENCODE_CLIENT: "cli" }, "opencode"],
    [{ CURSOR_AGENT: "1" }, "cursor"],
    [{ CURSOR_TRACE_ID: "t", CURSOR_AGENT: "1" }, "cursor"],
    [{ AUGMENT_AGENT: "1" }, "augment"],
    [{ ANTIGRAVITY_AGENT: "1" }, "antigravity"],
    [{ COPILOT_MODEL: "x" }, "github-copilot"],
    [{ REPL_ID: "r" }, "replit"],
    [{ AI_AGENT: "claude-code" }, "claude-code"],
    [{ AI_AGENT: "github-copilot-cli" }, "github-copilot"],
    [{ AI_AGENT: "v0" }, null],
  ])("maps %j to %s", (env, id) => {
    expect(detectRunningAgent(env, none)).toEqual({ inAgent: true, id });
  });

  it("treats a bare Cursor terminal as no agent, even with Claude Code inside it", () => {
    expect(detectRunningAgent({ CURSOR_TRACE_ID: "t", CLAUDECODE: "1" }, none)).toEqual({ inAgent: false, id: null });
  });

  it("maps Devin's marker file to the universal directory", () => {
    expect(detectRunningAgent({}, only("/opt/.devin"))).toEqual({ inAgent: true, id: "universal" });
  });

  it("reports no agent in a plain shell", () => {
    expect(detectRunningAgent({}, none)).toEqual({ inAgent: false, id: null });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run test/agents.test.ts`
Expected: FAIL, because `../src/agents.js` cannot be resolved.

- [ ] **Step 4: Implement `src/agents.ts`**

The `AGENTS` array was generated from the agent table in `skills@1.5.18` `dist/cli.mjs`. Keep its order: prompts and output list agents in this order.

```ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CANONICAL_SKILLS_DIR = ".agents/skills";

export type Exists = (path: string) => boolean;

export interface AgentPaths {
  home: string;
  cwd: string;
  config: string;
  claude: string;
  codex: string;
  vibe: string;
  hermes: string;
  autohand: string;
  appData: string | undefined;
  flatpakConfig: string | undefined;
}

interface AgentDef {
  id: string;
  displayName: string;
  skillsDir: string;
  globalDir: (p: AgentPaths, exists: Exists) => string | null;
  detect: (p: AgentPaths, exists: Exists) => boolean;
  hiddenInPrompt?: boolean;
  unlisted?: boolean;
}

export interface Agent {
  id: string;
  displayName: string;
  skillsDir: string;
  globalDir: string | null;
  canonical: boolean;
  universal: boolean;
  hidden: boolean;
  installed: boolean;
}

export interface AgentEnvironment {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  exists?: Exists;
}

export interface RunningAgent {
  inAgent: boolean;
  id: string | null;
}

function hasDependency(packageJsonPath: string, name: string): boolean {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]);
  } catch {
    return false;
  }
}

function openClawGlobalDir(p: AgentPaths, exists: Exists): string {
  for (const dir of [".openclaw", ".clawdbot", ".moltbot"]) {
    if (exists(join(p.home, dir))) return join(p.home, dir, "skills");
  }
  return join(p.home, ".openclaw/skills");
}

const AGENTS: AgentDef[] = [
  { id: "aider-desk", displayName: "AiderDesk", skillsDir: ".aider-desk/skills", globalDir: (p) => join(p.home, ".aider-desk/skills"), detect: (p, exists) => exists(join(p.home, ".aider-desk")) },
  { id: "amp", displayName: "Amp", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "agents/skills"), detect: (p, exists) => exists(join(p.config, "amp")) },
  { id: "antigravity", displayName: "Antigravity", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".gemini/antigravity/skills"), detect: (p, exists) => exists(join(p.home, ".gemini/antigravity")) },
  { id: "antigravity-cli", displayName: "Antigravity CLI", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".gemini/antigravity-cli/skills"), detect: (p, exists) => exists(join(p.home, ".gemini/antigravity-cli")) },
  { id: "astrbot", displayName: "AstrBot", skillsDir: "data/skills", globalDir: (p) => join(p.home, ".astrbot/data/skills"), detect: (p, exists) => exists(join(p.cwd, "data/skills")) || exists(join(p.home, ".astrbot")) },
  { id: "autohand-code", displayName: "Autohand Code CLI", skillsDir: ".autohand/skills", globalDir: (p) => join(p.autohand, "skills"), detect: (p, exists) => exists(p.autohand) },
  { id: "augment", displayName: "Augment", skillsDir: ".augment/skills", globalDir: (p) => join(p.home, ".augment/skills"), detect: (p, exists) => exists(join(p.home, ".augment")) },
  { id: "bob", displayName: "IBM Bob", skillsDir: ".bob/skills", globalDir: (p) => join(p.home, ".bob/skills"), detect: (p, exists) => exists(join(p.home, ".bob")) },
  { id: "claude-code", displayName: "Claude Code", skillsDir: ".claude/skills", globalDir: (p) => join(p.claude, "skills"), detect: (p, exists) => exists(p.claude) },
  { id: "openclaw", displayName: "OpenClaw", skillsDir: "skills", globalDir: (p, exists) => openClawGlobalDir(p, exists), detect: (p, exists) => exists(join(p.home, ".openclaw")) || exists(join(p.home, ".clawdbot")) || exists(join(p.home, ".moltbot")) },
  { id: "cline", displayName: "Cline", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".cline")) },
  { id: "codearts-agent", displayName: "CodeArts Agent", skillsDir: ".codeartsdoer/skills", globalDir: (p) => join(p.home, ".codeartsdoer/skills"), detect: (p, exists) => exists(join(p.home, ".codeartsdoer")) },
  { id: "codebuddy", displayName: "CodeBuddy", skillsDir: ".codebuddy/skills", globalDir: (p) => join(p.home, ".codebuddy/skills"), detect: (p, exists) => exists(join(p.cwd, ".codebuddy")) || exists(join(p.home, ".codebuddy")) },
  { id: "codemaker", displayName: "Codemaker", skillsDir: ".codemaker/skills", globalDir: (p) => join(p.home, ".codemaker/skills"), detect: (p, exists) => exists(join(p.home, ".codemaker")) },
  { id: "codestudio", displayName: "Code Studio", skillsDir: ".codestudio/skills", globalDir: (p) => join(p.home, ".codestudio/skills"), detect: (p, exists) => exists(join(p.home, ".codestudio")) },
  { id: "codex", displayName: "Codex", skillsDir: ".agents/skills", globalDir: (p) => join(p.codex, "skills"), detect: (p, exists) => exists(p.codex) || exists("/etc/codex") },
  { id: "command-code", displayName: "Command Code", skillsDir: ".commandcode/skills", globalDir: (p) => join(p.home, ".commandcode/skills"), detect: (p, exists) => exists(join(p.home, ".commandcode")) },
  { id: "continue", displayName: "Continue", skillsDir: ".continue/skills", globalDir: (p) => join(p.home, ".continue/skills"), detect: (p, exists) => exists(join(p.cwd, ".continue")) || exists(join(p.home, ".continue")) },
  { id: "cortex", displayName: "Cortex Code", skillsDir: ".cortex/skills", globalDir: (p) => join(p.home, ".snowflake/cortex/skills"), detect: (p, exists) => exists(join(p.home, ".snowflake/cortex")) },
  { id: "crush", displayName: "Crush", skillsDir: ".crush/skills", globalDir: (p) => join(p.home, ".config/crush/skills"), detect: (p, exists) => exists(join(p.home, ".config/crush")) },
  { id: "cursor", displayName: "Cursor", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".cursor/skills"), detect: (p, exists) => exists(join(p.home, ".cursor")) },
  { id: "deepagents", displayName: "Deep Agents", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".deepagents/agent/skills"), detect: (p, exists) => exists(join(p.home, ".deepagents")) },
  { id: "devin", displayName: "Devin for Terminal", skillsDir: ".devin/skills", globalDir: (p) => join(p.config, "devin/skills"), detect: (p, exists) => exists(join(p.config, "devin")) },
  { id: "dexto", displayName: "Dexto", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".dexto")), hiddenInPrompt: true },
  { id: "droid", displayName: "Droid", skillsDir: ".factory/skills", globalDir: (p) => join(p.home, ".factory/skills"), detect: (p, exists) => exists(join(p.home, ".factory")) },
  { id: "eve", displayName: "Eve", skillsDir: "agent/skills", globalDir: () => null, detect: (p, exists) => exists(join(p.cwd, "agent")) && hasDependency(join(p.cwd, "package.json"), "eve") },
  { id: "firebender", displayName: "Firebender", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".firebender/skills"), detect: (p, exists) => exists(join(p.home, ".firebender")), hiddenInPrompt: true },
  { id: "forgecode", displayName: "ForgeCode", skillsDir: ".forge/skills", globalDir: (p) => join(p.home, ".forge/skills"), detect: (p, exists) => exists(join(p.home, ".forge")) },
  { id: "gemini-cli", displayName: "Gemini CLI", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".gemini/skills"), detect: (p, exists) => exists(join(p.home, ".gemini")) },
  { id: "github-copilot", displayName: "GitHub Copilot", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".copilot/skills"), detect: (p, exists) => exists(join(p.home, ".copilot")) },
  { id: "goose", displayName: "Goose", skillsDir: ".goose/skills", globalDir: (p) => join(p.config, "goose/skills"), detect: (p, exists) => exists(join(p.config, "goose")) },
  { id: "hermes-agent", displayName: "Hermes Agent", skillsDir: ".hermes/skills", globalDir: (p) => join(p.hermes, "skills"), detect: (p, exists) => exists(p.hermes) },
  { id: "inference-sh", displayName: "inference.sh", skillsDir: ".inferencesh/skills", globalDir: (p) => join(p.home, ".inferencesh/skills"), detect: (p, exists) => exists(join(p.home, ".inferencesh")) },
  { id: "jazz", displayName: "Jazz", skillsDir: ".jazz/skills", globalDir: (p) => join(p.home, ".jazz/skills"), detect: (p, exists) => exists(join(p.home, ".jazz")) || exists(join(p.cwd, ".jazz")) },
  { id: "junie", displayName: "Junie", skillsDir: ".junie/skills", globalDir: (p) => join(p.home, ".junie/skills"), detect: (p, exists) => exists(join(p.home, ".junie")) },
  { id: "iflow-cli", displayName: "iFlow CLI", skillsDir: ".iflow/skills", globalDir: (p) => join(p.home, ".iflow/skills"), detect: (p, exists) => exists(join(p.home, ".iflow")) },
  { id: "kilo", displayName: "Kilo Code", skillsDir: ".kilocode/skills", globalDir: (p) => join(p.home, ".kilocode/skills"), detect: (p, exists) => exists(join(p.home, ".kilocode")) },
  { id: "kimi-code-cli", displayName: "Kimi Code CLI", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".kimi-code")) || exists(join(p.home, ".kimi")) },
  { id: "kiro-cli", displayName: "Kiro CLI", skillsDir: ".kiro/skills", globalDir: (p) => join(p.home, ".kiro/skills"), detect: (p, exists) => exists(join(p.home, ".kiro")) },
  { id: "kode", displayName: "Kode", skillsDir: ".kode/skills", globalDir: (p) => join(p.home, ".kode/skills"), detect: (p, exists) => exists(join(p.home, ".kode")) },
  { id: "lingma", displayName: "Lingma", skillsDir: ".lingma/skills", globalDir: (p) => join(p.home, ".lingma/skills"), detect: (p, exists) => exists(join(p.home, ".lingma")) },
  { id: "loaf", displayName: "Loaf", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".loaf")), hiddenInPrompt: true },
  { id: "mcpjam", displayName: "MCPJam", skillsDir: ".mcpjam/skills", globalDir: (p) => join(p.home, ".mcpjam/skills"), detect: (p, exists) => exists(join(p.home, ".mcpjam")) },
  { id: "mistral-vibe", displayName: "Mistral Vibe", skillsDir: ".vibe/skills", globalDir: (p) => join(p.vibe, "skills"), detect: (p, exists) => exists(p.vibe) },
  { id: "moxby", displayName: "Moxby", skillsDir: ".moxby/skills", globalDir: (p) => join(p.home, ".moxby/skills"), detect: (p, exists) => exists(join(p.home, ".moxby")) },
  { id: "mux", displayName: "Mux", skillsDir: ".mux/skills", globalDir: (p) => join(p.home, ".mux/skills"), detect: (p, exists) => exists(join(p.home, ".mux")) },
  { id: "opencode", displayName: "OpenCode", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "opencode/skills"), detect: (p, exists) => exists(join(p.config, "opencode")) },
  { id: "openhands", displayName: "OpenHands", skillsDir: ".openhands/skills", globalDir: (p) => join(p.home, ".openhands/skills"), detect: (p, exists) => exists(join(p.home, ".openhands")) },
  { id: "ona", displayName: "Ona", skillsDir: ".ona/skills", globalDir: (p) => join(p.home, ".ona/skills"), detect: (p, exists) => exists(join(p.home, ".ona")) },
  { id: "pi", displayName: "Pi", skillsDir: ".pi/skills", globalDir: (p) => join(p.home, ".pi/agent/skills"), detect: (p, exists) => exists(join(p.home, ".pi/agent")) },
  { id: "qoder", displayName: "Qoder", skillsDir: ".qoder/skills", globalDir: (p) => join(p.home, ".qoder/skills"), detect: (p, exists) => exists(join(p.home, ".qoder")) },
  { id: "qoder-cn", displayName: "Qoder CN", skillsDir: ".qoder/skills", globalDir: (p) => join(p.home, ".qoder-cn/skills"), detect: (p, exists) => exists(join(p.home, ".qoder-cn")) },
  { id: "qwen-code", displayName: "Qwen Code", skillsDir: ".qwen/skills", globalDir: (p) => join(p.home, ".qwen/skills"), detect: (p, exists) => exists(join(p.home, ".qwen")) },
  { id: "replit", displayName: "Replit", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "agents/skills"), detect: (p, exists) => exists(join(p.cwd, ".replit")), unlisted: true },
  { id: "reasonix", displayName: "Reasonix", skillsDir: ".reasonix/skills", globalDir: (p) => join(p.home, ".reasonix/skills"), detect: (p, exists) => exists(join(p.home, ".reasonix")) },
  { id: "rovodev", displayName: "Rovo Dev", skillsDir: ".rovodev/skills", globalDir: (p) => join(p.home, ".rovodev/skills"), detect: (p, exists) => exists(join(p.home, ".rovodev")) },
  { id: "roo", displayName: "Roo Code", skillsDir: ".roo/skills", globalDir: (p) => join(p.home, ".roo/skills"), detect: (p, exists) => exists(join(p.home, ".roo")) },
  { id: "tabnine-cli", displayName: "Tabnine CLI", skillsDir: ".tabnine/agent/skills", globalDir: (p) => join(p.home, ".tabnine/agent/skills"), detect: (p, exists) => exists(join(p.home, ".tabnine")) },
  { id: "terramind", displayName: "Terramind", skillsDir: ".terramind/skills", globalDir: (p) => join(p.home, ".terramind/skills"), detect: (p, exists) => exists(join(p.home, ".terramind")) },
  { id: "tinycloud", displayName: "Tinycloud", skillsDir: ".tinycloud/skills", globalDir: (p) => join(p.home, ".tinycloud/skills"), detect: (p, exists) => exists(join(p.home, ".tinycloud")) },
  { id: "trae", displayName: "Trae", skillsDir: ".trae/skills", globalDir: (p) => join(p.home, ".trae/skills"), detect: (p, exists) => exists(join(p.home, ".trae")) },
  { id: "trae-cn", displayName: "Trae CN", skillsDir: ".trae/skills", globalDir: (p) => join(p.home, ".trae-cn/skills"), detect: (p, exists) => exists(join(p.home, ".trae-cn")) },
  { id: "warp", displayName: "Warp", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.home, ".warp")) },
  { id: "windsurf", displayName: "Windsurf", skillsDir: ".windsurf/skills", globalDir: (p) => join(p.home, ".codeium/windsurf/skills"), detect: (p, exists) => exists(join(p.home, ".codeium/windsurf")) },
  { id: "zed", displayName: "Zed", skillsDir: ".agents/skills", globalDir: (p) => join(p.home, ".agents/skills"), detect: (p, exists) => exists(join(p.config, "zed")) || (p.appData !== undefined && exists(join(p.appData, "Zed"))) || (p.flatpakConfig !== undefined && exists(join(p.flatpakConfig, "zed"))) },
  { id: "zcode", displayName: "ZCode", skillsDir: ".zcode/skills", globalDir: (p) => join(p.home, ".zcode/skills"), detect: (p, exists) => exists(join(p.home, ".zcode")) || exists("/Applications/ZCode.app") },
  { id: "zencoder", displayName: "Zencoder", skillsDir: ".zencoder/skills", globalDir: (p) => join(p.home, ".zencoder/skills"), detect: (p, exists) => exists(join(p.home, ".zencoder")) },
  { id: "zenflow", displayName: "Zenflow", skillsDir: ".zencoder/skills", globalDir: (p) => join(p.home, ".zencoder/skills"), detect: (p, exists) => exists(join(p.home, ".zencoder")) },
  { id: "neovate", displayName: "Neovate", skillsDir: ".neovate/skills", globalDir: (p) => join(p.home, ".neovate/skills"), detect: (p, exists) => exists(join(p.home, ".neovate")) },
  { id: "pochi", displayName: "Pochi", skillsDir: ".pochi/skills", globalDir: (p) => join(p.home, ".pochi/skills"), detect: (p, exists) => exists(join(p.home, ".pochi")) },
  { id: "promptscript", displayName: "PromptScript", skillsDir: ".agents/skills", globalDir: () => null, detect: (p, exists) => exists(join(p.cwd, ".promptscript")) || exists(join(p.cwd, "promptscript.yaml")), hiddenInPrompt: true },
  { id: "adal", displayName: "AdaL", skillsDir: ".adal/skills", globalDir: (p) => join(p.home, ".adal/skills"), detect: (p, exists) => exists(join(p.home, ".adal")) },
  { id: "universal", displayName: "Universal", skillsDir: ".agents/skills", globalDir: (p) => join(p.config, "agents/skills"), detect: () => false, unlisted: true },
];

const RUNNING_AGENT_IDS: Record<string, string> = {
  cursor: "cursor",
  "cursor-cli": "cursor",
  claude: "claude-code",
  cowork: "claude-code",
  devin: "universal",
  replit: "replit",
  gemini: "gemini-cli",
  codex: "codex",
  antigravity: "antigravity",
  "augment-cli": "augment",
  opencode: "opencode",
  "github-copilot": "github-copilot",
  "github-copilot-cli": "github-copilot",
};

export function agentPaths(home: string, cwd: string, env: NodeJS.ProcessEnv): AgentPaths {
  const dir = (value: string | undefined, fallback: string) => value?.trim() || fallback;
  return {
    home,
    cwd,
    config: dir(env.XDG_CONFIG_HOME, join(home, ".config")),
    claude: dir(env.CLAUDE_CONFIG_DIR, join(home, ".claude")),
    codex: dir(env.CODEX_HOME, join(home, ".codex")),
    vibe: dir(env.VIBE_HOME, join(home, ".vibe")),
    hermes: dir(env.HERMES_HOME, join(home, ".hermes")),
    autohand: dir(env.AUTOHAND_HOME, join(home, ".autohand")),
    appData: env.APPDATA?.trim() || undefined,
    flatpakConfig: env.FLATPAK_XDG_CONFIG_HOME?.trim() || undefined,
  };
}

export function loadAgents(environment: AgentEnvironment): Agent[] {
  const exists = environment.exists ?? existsSync;
  const paths = agentPaths(environment.home, environment.cwd, environment.env);
  return AGENTS.map((def) => {
    const canonical = def.skillsDir === CANONICAL_SKILLS_DIR;
    return {
      id: def.id,
      displayName: def.displayName,
      skillsDir: def.skillsDir,
      globalDir: def.globalDir(paths, exists),
      canonical,
      universal: canonical && def.unlisted !== true,
      hidden: def.hiddenInPrompt === true,
      installed: def.detect(paths, exists),
    };
  });
}

function runningAgentName(env: NodeJS.ProcessEnv, exists: Exists): string | null {
  const declared = env.AI_AGENT?.trim();
  if (declared) return declared;
  if (env.CURSOR_TRACE_ID) return "cursor";
  if (env.CURSOR_AGENT || env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec") return "cursor-cli";
  if (env.GEMINI_CLI) return "gemini";
  if (env.CODEX_SANDBOX || env.CODEX_CI || env.CODEX_THREAD_ID) return "codex";
  if (env.ANTIGRAVITY_AGENT) return "antigravity";
  if (env.AUGMENT_AGENT) return "augment-cli";
  if (env.OPENCODE_CLIENT) return "opencode";
  if (env.CLAUDECODE || env.CLAUDE_CODE) return env.CLAUDE_CODE_IS_COWORK ? "cowork" : "claude";
  if (env.REPL_ID) return "replit";
  if (env.COPILOT_MODEL || env.COPILOT_ALLOW_ALL || env.COPILOT_GITHUB_TOKEN) return "github-copilot";
  if (exists("/opt/.devin")) return "devin";
  return null;
}

export function detectRunningAgent(env: NodeJS.ProcessEnv, exists: Exists = existsSync): RunningAgent {
  const name = runningAgentName(env, exists);
  if (name === null) return { inAgent: false, id: null };
  const strongCursor = Boolean(env.CURSOR_AGENT?.trim()) || env.CURSOR_EXTENSION_HOST_ROLE === "agent-exec";
  if ((name === "cursor" || name === "cursor-cli") && !strongCursor) return { inAgent: false, id: null };
  const id = RUNNING_AGENT_IDS[name] ?? (AGENTS.some((agent) => agent.id === name) ? name : null);
  return { inAgent: true, id };
}
```

- [ ] **Step 5: Run the tests and the type check**

Run: `npx vitest run test/agents.test.ts && npm run typecheck`
Expected: all agent tests pass; `tsc` prints nothing.

- [ ] **Step 6: Commit**

```bash
git add src/agents.ts test/helpers/fs.ts test/agents.test.ts
git commit -m "feat: mirror the skills 1.5.18 agent table and agent detection"
```

---

### Task 5: Installer

**Files:**
- Create: `src/installer.ts`
- Test: `test/installer.test.ts`

**Interfaces:**
- Consumes: `Agent`, `CANONICAL_SKILLS_DIR`, `loadAgents` (Task 4); `SkillFiles` (Task 3); `CliError`; test helpers `tempDir`, `cleanup`.
- Produces:
  - `interface InstallOptions { global: boolean; copy: boolean; home: string; cwd: string }`
  - `interface InstalledAgent { agent: Agent; status: "canonical" | "symlinked" | "copied"; path: string; symlinkFailed: boolean }`
  - `interface FailedAgent { agent: Agent; status: "failed"; path: string | null; error: string }`
  - `type AgentResult = InstalledAgent | FailedAgent`
  - `interface SkillResult { name: string; canonicalPath: string; agents: AgentResult[] }`
  - `sanitizeName(name: string): string`
  - `canonicalSkillDir(name: string, options: InstallOptions): string`
  - `agentSkillDir(agent: Agent, name: string, options: InstallOptions): string | null`
  - `installSkill(name: string, files: SkillFiles, agents: Agent[], options: InstallOptions): Promise<SkillResult>`
  - `existingTargets(name: string, agents: Agent[], options: InstallOptions): Promise<Agent[]>`

- [ ] **Step 1: Write the failing test**

`test/installer.test.ts`:

```ts
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgents } from "../src/agents.js";
import { agentSkillDir, existingTargets, installSkill, sanitizeName, type InstallOptions } from "../src/installer.js";
import { cleanup, tempDir } from "./helpers/fs.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, symlink: vi.fn(actual.symlink) };
});

afterEach(cleanup);

const encode = (text: string) => new TextEncoder().encode(text);
const files = new Map([
  ["SKILL.md", encode("---\nname: demo-skill\ndescription: Demo.\n---\n")],
  ["references/api.md", encode("api")],
]);

function setup(overrides: Partial<InstallOptions> = {}) {
  const home = tempDir();
  const cwd = tempDir();
  const agents = loadAgents({ home, cwd, env: {}, exists: () => false });
  const pick = (...ids: string[]) => ids.map((id) => agents.find((agent) => agent.id === id)!);
  const options: InstallOptions = { global: false, copy: false, home, cwd, ...overrides };
  return { home, cwd, pick, options };
}

describe("sanitizeName", () => {
  it.each([
    ["demo-skill", "demo-skill"],
    ["Demo Skill!", "demo-skill"],
    ["../../etc", "etc"],
    ["", "unnamed-skill"],
  ])("turns %j into %j", (input, output) => {
    expect(sanitizeName(input)).toBe(output);
  });
});

describe("installSkill", () => {
  it("writes the canonical copy once and links other agents to it relatively", async () => {
    const { cwd, pick, options } = setup();
    const result = await installSkill("demo-skill", files, pick("claude-code", "cursor"), options);
    expect(result.canonicalPath).toBe(join(cwd, ".agents/skills/demo-skill"));
    expect(readFileSync(join(cwd, ".agents/skills/demo-skill/references/api.md"), "utf8")).toBe("api");
    expect(readlinkSync(join(cwd, ".claude/skills/demo-skill"))).toBe("../../.agents/skills/demo-skill");
    expect(readFileSync(join(cwd, ".claude/skills/demo-skill/SKILL.md"), "utf8")).toContain("name: demo-skill");
    expect(result.agents.map((agent) => [agent.agent.id, agent.status])).toEqual([
      ["claude-code", "symlinked"],
      ["cursor", "canonical"],
    ]);
  });

  it("installs under the home directory when global", async () => {
    const { home, pick, options } = setup({ global: true });
    await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(existsSync(join(home, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
    expect(lstatSync(join(home, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
  });

  it("replaces whatever was installed before", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".agents/skills/demo-skill"), { recursive: true });
    writeFileSync(join(cwd, ".agents/skills/demo-skill/stale.md"), "stale");
    mkdirSync(join(cwd, ".claude/skills/demo-skill"), { recursive: true });
    await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(existsSync(join(cwd, ".agents/skills/demo-skill/stale.md"))).toBe(false);
    expect(lstatSync(join(cwd, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
  });

  it("leaves a shared directory alone when the agent's directory already is the canonical one", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".agents/skills"), { recursive: true });
    mkdirSync(join(cwd, ".claude"));
    symlinkSync(join(cwd, ".agents/skills"), join(cwd, ".claude/skills"));
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(readFileSync(join(cwd, ".agents/skills/demo-skill/SKILL.md"), "utf8")).toContain("demo-skill");
    expect(lstatSync(join(cwd, ".agents/skills/demo-skill")).isDirectory()).toBe(true);
    expect(result.agents[0].status).toBe("symlinked");
  });

  it("copies into each distinct directory with copy", async () => {
    const { cwd, pick, options } = setup({ copy: true });
    const result = await installSkill("demo-skill", files, pick("claude-code", "cursor", "codex"), options);
    expect(lstatSync(join(cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expect(lstatSync(join(cwd, ".agents/skills/demo-skill")).isDirectory()).toBe(true);
    expect(result.agents.every((agent) => agent.status === "copied")).toBe(true);
  });

  it("falls back to a copy when the symlink cannot be created", async () => {
    const { cwd, pick, options } = setup();
    vi.mocked(symlink).mockRejectedValueOnce(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }));
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(lstatSync(join(cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expect(result.agents[0]).toMatchObject({ status: "copied", symlinkFailed: true });
  });

  it("reports an agent that cannot install globally", async () => {
    const { pick, options } = setup({ global: true });
    const result = await installSkill("demo-skill", files, pick("eve"), options);
    expect(result.agents[0]).toMatchObject({ status: "failed", error: "Eve does not support global skill installation" });
  });

  it("reports a write failure instead of throwing", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".claude"));
    writeFileSync(join(cwd, ".claude/skills"), "not a directory");
    const result = await installSkill("demo-skill", files, pick("claude-code"), options);
    expect(result.agents[0].status).toBe("failed");
  });
});

describe("agentSkillDir", () => {
  it("keeps a hostile name inside the agent directory", () => {
    const { cwd, pick, options } = setup();
    expect(agentSkillDir(pick("claude-code")[0], "../../evil", options)).toBe(join(cwd, ".claude/skills/evil"));
  });
});

describe("existingTargets", () => {
  it("lists the agents whose install directory already exists", async () => {
    const { cwd, pick, options } = setup();
    mkdirSync(join(cwd, ".claude/skills/demo-skill"), { recursive: true });
    const found = await existingTargets("demo-skill", pick("claude-code", "windsurf"), options);
    expect(found.map((agent) => agent.id)).toEqual(["claude-code"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/installer.test.ts`
Expected: FAIL, because `../src/installer.js` cannot be resolved.

- [ ] **Step 3: Implement `src/installer.ts`**

```ts
import { lstat, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CANONICAL_SKILLS_DIR, type Agent } from "./agents.js";
import type { SkillFiles } from "./archive.js";
import { CliError } from "./errors.js";

export interface InstallOptions {
  global: boolean;
  copy: boolean;
  home: string;
  cwd: string;
}

export interface InstalledAgent {
  agent: Agent;
  status: "canonical" | "symlinked" | "copied";
  path: string;
  symlinkFailed: boolean;
}

export interface FailedAgent {
  agent: Agent;
  status: "failed";
  path: string | null;
  error: string;
}

export type AgentResult = InstalledAgent | FailedAgent;

export interface SkillResult {
  name: string;
  canonicalPath: string;
  agents: AgentResult[];
}

export function sanitizeName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 255) || "unnamed-skill"
  );
}

function isInside(base: string, target: string): boolean {
  return resolve(target).startsWith(resolve(base) + sep);
}

function inside(base: string, name: string): string {
  const target = join(base, sanitizeName(name));
  if (!isInside(base, target)) throw new CliError(`Refusing to install ${name} outside ${base}`);
  return target;
}

export function canonicalSkillDir(name: string, options: InstallOptions): string {
  return inside(join(options.global ? options.home : options.cwd, CANONICAL_SKILLS_DIR), name);
}

export function agentSkillDir(agent: Agent, name: string, options: InstallOptions): string | null {
  if (options.global && agent.globalDir === null) return null;
  if (agent.canonical) return canonicalSkillDir(name, options);
  return inside(options.global ? (agent.globalDir as string) : join(options.cwd, agent.skillsDir), name);
}

async function writeSkill(dir: string, files: SkillFiles): Promise<void> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [path, data] of files) {
    const target = join(dir, path);
    if (!isInside(dir, target)) throw new Error(`refusing to write ${path} outside the skill directory`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, data);
  }
}

async function linkSkill(canonicalPath: string, linkPath: string): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  const target = await realpath(canonicalPath);
  const link = join(await realpath(dirname(linkPath)), basename(linkPath));
  if (link === target) return;
  const existing = await lstat(linkPath).catch(() => null);
  if (existing?.isSymbolicLink() && (await realpath(linkPath).catch(() => null)) === target) return;
  if (existing) await rm(linkPath, { recursive: true, force: true });
  if (process.platform === "win32") await symlink(target, linkPath, "junction");
  else await symlink(relative(dirname(link), target), linkPath);
}

async function attempt(action: () => Promise<void>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

function unsupported(agent: Agent): FailedAgent {
  return { agent, status: "failed", path: null, error: `${agent.displayName} does not support global skill installation` };
}

export async function installSkill(name: string, files: SkillFiles, agents: Agent[], options: InstallOptions): Promise<SkillResult> {
  const canonicalPath = canonicalSkillDir(name, options);
  const results: AgentResult[] = [];
  if (options.copy) {
    const written = new Map<string, string | null>();
    for (const agent of agents) {
      const dir = agentSkillDir(agent, name, options);
      if (dir === null) {
        results.push(unsupported(agent));
        continue;
      }
      if (!written.has(dir)) written.set(dir, await attempt(() => writeSkill(dir, files)));
      const error = written.get(dir);
      results.push(error ? { agent, status: "failed", path: dir, error } : { agent, status: "copied", path: dir, symlinkFailed: false });
    }
    return { name, canonicalPath, agents: results };
  }
  const canonicalError = await attempt(() => writeSkill(canonicalPath, files));
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, options);
    if (dir === null) {
      results.push(unsupported(agent));
    } else if (canonicalError !== null) {
      results.push({ agent, status: "failed", path: dir, error: canonicalError });
    } else if (dir === canonicalPath) {
      results.push({ agent, status: "canonical", path: dir, symlinkFailed: false });
    } else if ((await attempt(() => linkSkill(canonicalPath, dir))) === null) {
      results.push({ agent, status: "symlinked", path: dir, symlinkFailed: false });
    } else {
      const copyError = await attempt(() => writeSkill(dir, files));
      results.push(copyError ? { agent, status: "failed", path: dir, error: copyError } : { agent, status: "copied", path: dir, symlinkFailed: true });
    }
  }
  return { name, canonicalPath, agents: results };
}

export async function existingTargets(name: string, agents: Agent[], options: InstallOptions): Promise<Agent[]> {
  const found: Agent[] = [];
  for (const agent of agents) {
    const dir = agentSkillDir(agent, name, options);
    if (dir !== null && (await lstat(dir).catch(() => null)) !== null) found.push(agent);
  }
  return found;
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run test/installer.test.ts && npm run typecheck`
Expected: all installer tests pass; `tsc` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add src/installer.ts test/installer.test.ts
git commit -m "feat: install skills into the canonical directory and link agents to it"
```

---

### Task 6: The add flow

**Files:**
- Create: `src/add.ts`
- Test: `test/add.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5; test helpers from Tasks 2 and 4.
- Produces:
  - `CANCELLED: unique symbol`
  - `type Cancellable<T> = T | typeof CANCELLED`
  - `interface AgentRequest { choices: Agent[]; initial: string[]; locked: Agent[] }`
  - The `Ui` interface:

    ```ts
    interface Ui {
      intro(title: string): void;
      step(message: string): void;
      info(message: string): void;
      warn(message: string): void;
      error(message: string): void;
      message(message: string): void;
      note(body: string, title: string): void;
      cancel(message: string): void;
      outro(message: string): void;
      selectSkills(skills: SkillEntry[]): Promise<Cancellable<SkillEntry[]>>;
      selectAgents(request: AgentRequest): Promise<Cancellable<string[]>>;
      selectScope(): Promise<Cancellable<boolean>>;
      confirm(message: string): Promise<Cancellable<boolean>>;
    }
    ```

    `selectScope` resolves `true` for Global.
  - `interface AddOptions { global: boolean; agents: string[] | null; skills: string[] | null; yes: boolean; copy: boolean; list: boolean }`
  - `interface AddContext { ui: Ui; home: string; cwd: string; env: NodeJS.ProcessEnv; interactive: boolean; exists?: Exists; fetch?: FetchOptions }`
  - `DEFAULT_AGENTS = ["claude-code", "opencode", "codex"]`
  - `shortPath(path: string, home: string, cwd: string): string`
  - `runAdd(url: string, options: AddOptions, context: AddContext): Promise<number>`. Returns the exit code and throws `CliError` for errors.

- [ ] **Step 1: Write the failing test**

`test/add.test.ts`:

```ts
import { existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CANCELLED, runAdd, type AddContext, type AddOptions, type AgentRequest, type Ui } from "../src/add.js";
import type { SkillEntry } from "../src/registry.js";
import { cleanup, filesContaining, sandboxExists, tempDir } from "./helpers/fs.js";
import { KEY, publishIndex, skillZip, startRegistry, type TestRegistry } from "./helpers/registry.js";

type Answer<T> = T | typeof CANCELLED;

interface Answers {
  skills?: Answer<string[]>;
  agents?: Answer<string[]>;
  scope?: Answer<boolean>;
  confirm?: Answer<boolean>;
}

function fakeUi(answers: Answers = {}) {
  const lines: string[] = [];
  const asked: string[] = [];
  const requests: AgentRequest[] = [];
  function answer<T>(name: keyof Answers): T {
    asked.push(name);
    if (!(name in answers)) throw new Error(`unexpected ${name} prompt`);
    return answers[name] as T;
  }
  const ui: Ui = {
    intro: (message) => lines.push(message),
    step: (message) => lines.push(message),
    info: (message) => lines.push(message),
    warn: (message) => lines.push(`warn: ${message}`),
    error: (message) => lines.push(`error: ${message}`),
    message: (message) => lines.push(message),
    note: (body, title) => lines.push(`${title}\n${body}`),
    cancel: (message) => lines.push(`cancel: ${message}`),
    outro: (message) => lines.push(message),
    selectSkills: async (skills: SkillEntry[]) => {
      const chosen = answer<Answer<string[]>>("skills");
      return chosen === CANCELLED ? chosen : skills.filter((skill) => chosen.includes(skill.name));
    },
    selectAgents: async (request: AgentRequest) => {
      requests.push(request);
      return answer<Answer<string[]>>("agents");
    },
    selectScope: async () => answer<Answer<boolean>>("scope"),
    confirm: async () => answer<Answer<boolean>>("confirm"),
  };
  return { ui, asked, requests, text: () => lines.join("\n") };
}

const options = (overrides: Partial<AddOptions> = {}): AddOptions => ({
  global: false,
  agents: null,
  skills: null,
  yes: false,
  copy: false,
  list: false,
  ...overrides,
});

let registry: TestRegistry;
let url: string;

beforeAll(async () => {
  registry = await startRegistry();
  publishIndex(registry, `/i/${KEY}`, [
    { name: "demo-skill", zip: skillZip("demo-skill", { "references/api.md": "api" }) },
    { name: "other-skill", zip: skillZip("other-skill") },
  ]);
  url = `${registry.origin}/i/${KEY}`;
});

afterAll(() => registry.close());
afterEach(cleanup);

function sandbox(env: NodeJS.ProcessEnv = {}, interactive = true) {
  const home = tempDir();
  const cwd = tempDir();
  const context = (ui: Ui): AddContext => ({ ui, home, cwd, env, interactive, exists: sandboxExists(home, cwd) });
  return { home, cwd, context };
}

describe("runAdd", () => {
  it("installs one skill globally for Claude Code without asking anything, like the agent prompt", async () => {
    const box = sandbox({ CLAUDECODE: "1" }, false);
    const ui = fakeUi();
    const code = await runAdd(url, options({ skills: ["demo-skill"], global: true, yes: true }), box.context(ui.ui));
    expect(code).toBe(0);
    expect(ui.asked).toEqual([]);
    expect(existsSync(join(box.home, ".agents/skills/demo-skill/references/api.md"))).toBe(true);
    expect(lstatSync(join(box.home, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(ui.text()).toContain("Claude Code detected");
    expect(ui.text()).toContain("✓ ~/.agents/skills/demo-skill");
    expect(ui.text()).toContain("universal: Amp, Antigravity, Antigravity CLI, Cline, Codex +8 more");
    expect(ui.text()).toContain("symlinked: Claude Code");
    expect(ui.text()).not.toContain("Failed");
    expect(ui.text()).not.toContain(KEY);
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(filesContaining(box.home, KEY)).toEqual([]);
  });

  it("lists skills without installing or needing a terminal", async () => {
    const box = sandbox({}, false);
    const ui = fakeUi();
    expect(await runAdd(url, options({ list: true }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("demo-skill\n  The demo-skill skill.");
    expect(ui.text()).toContain("other-skill");
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(readdirSync(box.home)).toEqual([]);
  });

  it("refuses to prompt without a terminal", async () => {
    const box = sandbox({}, false);
    await expect(runAdd(url, options(), box.context(fakeUi().ui))).rejects.toThrow(/Add -y/);
  });

  it("asks for skills, agents, scope and confirmation when no agent is detected", async () => {
    const box = sandbox();
    const ui = fakeUi({ skills: ["other-skill"], agents: ["claude-code"], scope: false, confirm: true });
    expect(await runAdd(url, options(), box.context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual(["skills", "agents", "scope", "confirm"]);
    expect(ui.requests[0].initial).toEqual(["claude-code", "opencode", "codex"]);
    expect(ui.requests[0].locked).toEqual([]);
    expect(readlinkSync(join(box.cwd, ".claude/skills/other-skill"))).toBe("../../.agents/skills/other-skill");
    expect(ui.text()).toContain("✓ ./.agents/skills/other-skill");
  });

  it("locks the universal agents and preselects the detected ones when several agents are installed", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    mkdirSync(join(box.home, ".codeium/windsurf"), { recursive: true });
    const ui = fakeUi({ agents: ["windsurf"], scope: true, confirm: true });
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    const request = ui.requests[0];
    expect(request.initial).toEqual(["claude-code", "windsurf"]);
    expect(request.locked.map((agent) => agent.id)).toEqual([
      "amp", "antigravity", "antigravity-cli", "cline", "codex", "cursor", "deepagents",
      "gemini-cli", "github-copilot", "kimi-code-cli", "opencode", "warp", "zed",
    ]);
    expect(request.choices.some((agent) => agent.canonical || agent.id === "eve")).toBe(false);
    expect(lstatSync(join(box.home, ".codeium/windsurf/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(box.home, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
    expect(existsSync(join(box.home, ".claude/skills/demo-skill"))).toBe(false);
  });

  it("installs to the one detected agent and the universal directory with -y", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(ui.ui))).toBe(0);
    expect(ui.asked).toEqual([]);
    expect(lstatSync(join(box.cwd, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(box.cwd, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
  });

  it("installs only into .agents/skills when -y finds no agent", async () => {
    const box = sandbox();
    expect(await runAdd(url, options({ yes: true }), box.context(fakeUi().ui))).toBe(0);
    expect(readdirSync(box.cwd)).toEqual([".agents"]);
    expect(readdirSync(join(box.cwd, ".agents/skills")).sort()).toEqual(["demo-skill", "other-skill"]);
  });

  it("writes nothing and exits 0 when a prompt is cancelled", async () => {
    const box = sandbox();
    const ui = fakeUi({ skills: CANCELLED });
    expect(await runAdd(url, options(), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("cancel: Installation cancelled");
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("writes nothing when the summary is declined", async () => {
    const box = sandbox();
    const ui = fakeUi({ agents: ["claude-code"], scope: false, confirm: false });
    expect(await runAdd(url, options({ skills: ["demo-skill"] }), box.context(ui.ui))).toBe(0);
    expect(readdirSync(box.cwd)).toEqual([]);
  });

  it("writes nothing when a download fails its digest check", async () => {
    const box = sandbox();
    publishIndex(registry, "/tampered", [{ name: "demo-skill", zip: skillZip("demo-skill") }]);
    for (const [path, route] of registry.routes) {
      if (path.startsWith("/tampered/d/")) route.body = skillZip("demo-skill", { "evil.md": "x" });
    }
    await expect(runAdd(`${registry.origin}/tampered`, options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(/sha256/);
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(readdirSync(box.home)).toEqual([]);
  });

  it("refuses a named agent that cannot install globally", async () => {
    const box = sandbox();
    await expect(
      runAdd(url, options({ agents: ["eve"], global: true, yes: true, skills: ["demo-skill"] }), box.context(fakeUi().ui)),
    ).rejects.toThrow(/Eve cannot install skills globally/);
  });

  it("reports a missing index with the key masked", async () => {
    const box = sandbox();
    await expect(runAdd(`${registry.origin}/i/${"f".repeat(32)}`, options({ yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      `No skills found at ${registry.origin}/i/ffff…`,
    );
  });

  it("matches -s names case-insensitively and names the missing ones", async () => {
    const box = sandbox();
    expect(await runAdd(url, options({ skills: ["Demo-Skill"], yes: true }), box.context(fakeUi().ui))).toBe(0);
    expect(existsSync(join(box.cwd, ".agents/skills/demo-skill/SKILL.md"))).toBe(true);
    await expect(runAdd(url, options({ skills: ["nope"], yes: true }), box.context(fakeUi().ui))).rejects.toThrow(
      "No skill named nope in this registry. Available: demo-skill, other-skill",
    );
  });

  it("rejects an unknown agent id", async () => {
    const box = sandbox();
    await expect(runAdd(url, options({ agents: ["nope"], yes: true }), box.context(fakeUi().ui))).rejects.toThrow(/Invalid agents: nope/);
  });

  it("survives running the same install twice and reports the overwrite", async () => {
    const box = sandbox();
    mkdirSync(join(box.home, ".claude"));
    const first = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(first.ui))).toBe(0);
    const second = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], yes: true }), box.context(second.ui))).toBe(0);
    expect(second.text()).toContain("overwrites: Claude Code");
    expect(existsSync(join(box.cwd, ".claude/skills/demo-skill/SKILL.md"))).toBe(true);
  });

  it("copies with --copy and says where", async () => {
    const box = sandbox();
    const ui = fakeUi();
    const code = await runAdd(url, options({ skills: ["demo-skill"], agents: ["claude-code", "cursor"], copy: true, yes: true }), box.context(ui.ui));
    expect(code).toBe(0);
    expect(lstatSync(join(box.cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expect(ui.text()).toContain("✓ demo-skill (copied)\n  → ./.claude/skills/demo-skill\n  → ./.agents/skills/demo-skill");
  });

  it("warns about entries it skipped and installs the rest", async () => {
    const box = sandbox();
    publishIndex(registry, "/warned", [{ name: "demo-skill", zip: skillZip("demo-skill") }], {
      overrides: [{ name: "far-skill", description: "Far.", type: "archive", url: "https://far.example/x.zip", digest: `sha256:${"0".repeat(64)}` }],
    });
    const ui = fakeUi();
    expect(await runAdd(`${registry.origin}/warned`, options({ yes: true }), box.context(ui.ui))).toBe(0);
    expect(ui.text()).toContain("warn: Skipped index entry far-skill: url points to another origin");
  });

  it("exits 1 and lists the failure when an agent directory cannot be written", async () => {
    const box = sandbox();
    mkdirSync(join(box.cwd, ".claude"));
    writeFileSync(join(box.cwd, ".claude/skills"), "not a directory");
    const ui = fakeUi();
    expect(await runAdd(url, options({ skills: ["demo-skill"], agents: ["claude-code"], yes: true }), box.context(ui.ui))).toBe(1);
    expect(ui.text()).toContain("error: Failed to install 1");
    expect(ui.text()).toContain("✗ demo-skill → Claude Code:");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/add.test.ts`
Expected: FAIL, because `../src/add.js` cannot be resolved.

- [ ] **Step 3: Implement `src/add.ts`**

```ts
import { sep } from "node:path";
import { detectRunningAgent, loadAgents, type Agent, type Exists, type RunningAgent } from "./agents.js";
import { unpackSkill, type SkillFiles } from "./archive.js";
import { CliError } from "./errors.js";
import {
  canonicalSkillDir,
  existingTargets,
  installSkill,
  type AgentResult,
  type InstallOptions,
  type InstalledAgent,
  type SkillResult,
} from "./installer.js";
import { downloadArtifact, fetchIndex, type FetchOptions, type SkillEntry } from "./registry.js";
import { parseSource } from "./source.js";

export const CANCELLED: unique symbol = Symbol("cancelled");

export type Cancellable<T> = T | typeof CANCELLED;

export interface AgentRequest {
  choices: Agent[];
  initial: string[];
  locked: Agent[];
}

export interface Ui {
  intro(title: string): void;
  step(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  message(message: string): void;
  note(body: string, title: string): void;
  cancel(message: string): void;
  outro(message: string): void;
  selectSkills(skills: SkillEntry[]): Promise<Cancellable<SkillEntry[]>>;
  selectAgents(request: AgentRequest): Promise<Cancellable<string[]>>;
  selectScope(): Promise<Cancellable<boolean>>;
  confirm(message: string): Promise<Cancellable<boolean>>;
}

export interface AddOptions {
  global: boolean;
  agents: string[] | null;
  skills: string[] | null;
  yes: boolean;
  copy: boolean;
  list: boolean;
}

export interface AddContext {
  ui: Ui;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  exists?: Exists;
  fetch?: FetchOptions;
}

export const DEFAULT_AGENTS = ["claude-code", "opencode", "codex"];

const unique = <T>(items: T[]): T[] => [...new Set(items)];

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function formatList(items: string[], max = 5): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")} +${items.length - max} more`;
}

export function shortPath(path: string, home: string, cwd: string): string {
  if (path === home || path.startsWith(home + sep)) return `~${path.slice(home.length)}`;
  if (path === cwd || path.startsWith(cwd + sep)) return `.${path.slice(cwd.length)}`;
  return path;
}

function cancelled(ui: Ui): number {
  ui.cancel("Installation cancelled");
  return 0;
}

function sharedNames(agents: Agent[]): string[] {
  return agents.filter((agent) => agent.canonical && !agent.hidden).map((agent) => agent.displayName);
}

async function chooseSkills(all: SkillEntry[], options: AddOptions, yes: boolean, ui: Ui): Promise<Cancellable<SkillEntry[]>> {
  if (options.skills?.includes("*")) return all;
  if (options.skills) {
    const wanted = unique(options.skills.map((name) => name.toLowerCase()));
    const missing = wanted.filter((name) => !all.some((skill) => skill.name === name));
    if (missing.length > 0) {
      throw new CliError(`No skill named ${missing.join(", ")} in this registry. Available: ${all.map((skill) => skill.name).join(", ")}`);
    }
    return all.filter((skill) => wanted.includes(skill.name));
  }
  if (all.length === 1 || yes) return all;
  return ui.selectSkills(all);
}

async function chooseAgents(agents: Agent[], options: AddOptions, yes: boolean, running: RunningAgent, ui: Ui): Promise<Cancellable<Agent[]>> {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const pick = (ids: string[]) => unique(ids).map((id) => byId.get(id) as Agent);
  const universal = agents.filter((agent) => agent.universal);
  const withUniversal = (list: Agent[]) => [...list, ...universal.filter((agent) => !list.includes(agent))];
  if (options.agents?.includes("*")) return agents;
  if (options.agents) {
    const invalid = options.agents.filter((id) => !byId.has(id));
    if (invalid.length > 0) {
      throw new CliError(`Invalid agents: ${invalid.join(", ")}. Valid agents: ${agents.map((agent) => agent.id).join(", ")}`);
    }
    return pick(options.agents);
  }
  if (running.inAgent) return withUniversal(running.id === null ? [] : pick([running.id]));
  const installed = agents.filter((agent) => agent.installed);
  if (installed.length === 0) {
    if (yes) return universal;
    const chosen = await ui.selectAgents({ choices: agents, initial: DEFAULT_AGENTS, locked: [] });
    return chosen === CANCELLED ? CANCELLED : pick(chosen);
  }
  if (installed.length === 1 || yes) return withUniversal(installed);
  const choices = agents.filter((agent) => !agent.canonical && agent.id !== "eve");
  const chosen = await ui.selectAgents({
    choices,
    initial: installed.filter((agent) => choices.includes(agent)).map((agent) => agent.id),
    locked: universal.filter((agent) => !agent.hidden),
  });
  return chosen === CANCELLED ? CANCELLED : withUniversal(pick(chosen));
}

async function chooseScope(targets: Agent[], options: AddOptions, yes: boolean, ui: Ui): Promise<Cancellable<boolean>> {
  if (options.global) return true;
  if (yes || !targets.some((agent) => agent.globalDir !== null)) return false;
  return ui.selectScope();
}

function forScope(targets: Agent[], global: boolean, options: AddOptions): Agent[] {
  if (!global) return targets;
  const unsupported = targets.filter((agent) => agent.globalDir === null);
  if (unsupported.length > 0 && options.agents !== null && !options.agents.includes("*")) {
    throw new CliError(`${unsupported.map((agent) => agent.displayName).join(", ")} cannot install skills globally`);
  }
  const supported = targets.filter((agent) => agent.globalDir !== null);
  if (supported.length === 0) throw new CliError("None of the selected agents can install skills globally");
  return supported;
}

async function summary(skills: SkillEntry[], targets: Agent[], install: InstallOptions): Promise<string> {
  const blocks: string[] = [];
  for (const skill of skills) {
    const lines: string[] = [];
    if (install.copy) {
      lines.push(`${skill.name} (copy)`);
      lines.push(`  copy → ${formatList(targets.map((agent) => agent.displayName))}`);
    } else {
      lines.push(shortPath(canonicalSkillDir(skill.name, install), install.home, install.cwd));
      const shared = sharedNames(targets);
      const linked = targets.filter((agent) => !agent.canonical).map((agent) => agent.displayName);
      if (shared.length > 0) lines.push(`  universal: ${formatList(shared)}`);
      if (linked.length > 0) lines.push(`  symlink → ${formatList(linked)}`);
    }
    const overwritten = await existingTargets(skill.name, targets, install);
    if (overwritten.length > 0) lines.push(`  overwrites: ${formatList(overwritten.map((agent) => agent.displayName))}`);
    blocks.push(lines.join("\n"));
  }
  return blocks.join("\n\n");
}

function isInstalled(result: AgentResult): result is InstalledAgent {
  return result.status !== "failed";
}

function report(results: SkillResult[], install: InstallOptions, ui: Ui): void {
  const lines: string[] = [];
  const fallbacks: string[] = [];
  const failures: string[] = [];
  let installed = 0;
  for (const result of results) {
    for (const agent of result.agents) {
      if (agent.status === "failed") failures.push(`✗ ${result.name} → ${agent.agent.displayName}: ${agent.error}`);
    }
    const done = result.agents.filter(isInstalled);
    if (done.length === 0) continue;
    installed += 1;
    if (install.copy) {
      lines.push(`✓ ${result.name} (copied)`);
      for (const path of unique(done.map((agent) => shortPath(agent.path, install.home, install.cwd)))) lines.push(`  → ${path}`);
      continue;
    }
    lines.push(`✓ ${shortPath(result.canonicalPath, install.home, install.cwd)}`);
    const shared = sharedNames(done.filter((agent) => agent.status === "canonical").map((agent) => agent.agent));
    const linked = done.filter((agent) => agent.status === "symlinked").map((agent) => agent.agent.displayName);
    const copied = done.filter((agent) => agent.status === "copied").map((agent) => agent.agent.displayName);
    if (shared.length > 0) lines.push(`  universal: ${formatList(shared)}`);
    if (linked.length > 0) lines.push(`  symlinked: ${formatList(linked)}`);
    if (copied.length > 0) {
      lines.push(`  copied: ${formatList(copied)}`);
      fallbacks.push(...copied);
    }
  }
  if (installed > 0) ui.note(lines.join("\n"), `Installed ${plural(installed, "skill")}`);
  if (fallbacks.length > 0) ui.warn(`Symlinks failed for: ${formatList(unique(fallbacks))}. Files were copied instead.`);
  if (failures.length > 0) {
    ui.error(`Failed to install ${failures.length}`);
    ui.message(failures.join("\n"));
  }
}

export async function runAdd(url: string, options: AddOptions, context: AddContext): Promise<number> {
  const { ui } = context;
  const source = parseSource(url);
  const running = detectRunningAgent(context.env, context.exists);
  const agents = loadAgents({ home: context.home, cwd: context.cwd, env: context.env, exists: context.exists });
  const yes = options.yes || running.inAgent;
  if (running.inAgent) {
    const name = agents.find((agent) => agent.id === running.id)?.displayName ?? "An agent";
    ui.info(`${name} detected — installing non-interactively`);
  } else {
    ui.intro("skillsgist");
  }
  ui.step(`Source: ${source.display}`);

  const index = await fetchIndex(source, context.fetch);
  for (const warning of index?.warnings ?? []) ui.warn(warning);
  if (index === null || index.skills.length === 0) throw new CliError(`No skills found at ${source.display}`);
  ui.step(`Found ${plural(index.skills.length, "skill")}`);

  if (options.list) {
    ui.message(index.skills.map((skill) => `${skill.name}\n  ${skill.description}`).join("\n"));
    ui.outro("Run without --list to install");
    return 0;
  }
  if (!yes && !context.interactive) {
    throw new CliError("There is no terminal to ask questions in. Add -y to install without prompts.");
  }

  const skills = await chooseSkills(index.skills, options, yes, ui);
  if (skills === CANCELLED) return cancelled(ui);
  const chosen = await chooseAgents(agents, options, yes, running, ui);
  if (chosen === CANCELLED) return cancelled(ui);
  const global = await chooseScope(chosen, options, yes, ui);
  if (global === CANCELLED) return cancelled(ui);
  const targets = forScope(chosen, global, options);
  const install: InstallOptions = { global, copy: options.copy, home: context.home, cwd: context.cwd };

  ui.note(await summary(skills, targets, install), "Installation Summary");
  if (!yes) {
    const proceed = await ui.confirm("Proceed with installation?");
    if (proceed === CANCELLED || !proceed) return cancelled(ui);
  }

  const payloads: Array<{ name: string; files: SkillFiles }> = [];
  for (const skill of skills) payloads.push({ name: skill.name, files: unpackSkill(skill.name, await downloadArtifact(skill, context.fetch)) });

  const results: SkillResult[] = [];
  for (const payload of payloads) results.push(await installSkill(payload.name, payload.files, targets, install));
  report(results, install, ui);
  ui.outro("Done!  Review skills before use; they run with full agent permissions.");
  return results.some((result) => result.agents.some((agent) => agent.status === "failed")) ? 1 : 0;
}
```

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run test/add.test.ts && npm run typecheck`
Expected: all add tests pass; `tsc` prints nothing.

In the first test, the Claude Code global install's universal line lists only the 13 visible universal agents. `promptscript` has no global directory and is dropped, and the hidden ones are not named. So the line reads `Amp, Antigravity, Antigravity CLI, Cline, Codex +8 more`. If that count differs, re-check `sharedNames` before changing the test.

- [ ] **Step 5: Commit**

```bash
git add src/add.ts test/add.test.ts
git commit -m "feat: add the install flow behind a prompt interface"
```

---

### Task 7: Command line, clack UI, entry point, end-to-end tests and README

**Files:**
- Create: `src/args.ts`, `src/ui.ts`, `src/cli.ts`
- Create: `test/fixtures/record-connections.mjs`
- Test: `test/args.test.ts`, `test/e2e.test.ts`
- Create: `README.md` (replace the one-line stub)

**Interfaces:**
- Consumes:
  - `AddOptions`, `runAdd`, `CANCELLED`, `Ui`, `AgentRequest`, `Cancellable` (Task 6)
  - `redact` (Task 1)
  - `CliError`, `SkillEntry`
  - Test helpers from Tasks 2 and 4
- Produces:
  - `USAGE: string`
  - `type Command = { kind: "help" } | { kind: "version" } | { kind: "add"; url: string; options: AddOptions }`
  - `parseCommandLine(argv: string[]): Command`
  - `clackUi(): Ui`
  - The `skillsgist` binary at `dist/cli.js`

- [ ] **Step 1: Write the failing argument test**

`test/args.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCommandLine } from "../src/args.js";

function add(...argv: string[]) {
  const command = parseCommandLine(argv);
  if (command.kind !== "add") throw new Error(`expected add, got ${command.kind}`);
  return command;
}

function failure(action: () => unknown): string {
  try {
    action();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

describe("parseCommandLine", () => {
  it.each(["add", "a", "install", "i"])("accepts the %s command", (name) => {
    expect(add(name, "https://h.example").url).toBe("https://h.example");
  });

  it("reads the flags npx skills users type", () => {
    expect(add("add", "https://h.example", "-g", "-y", "--copy", "-l").options).toEqual({
      global: true,
      agents: null,
      skills: null,
      yes: true,
      copy: true,
      list: true,
    });
    expect(add("add", "--global", "--yes", "--list", "https://h.example").options).toMatchObject({ global: true, yes: true, list: true });
  });

  it("collects agent and skill values up to the next option", () => {
    const { options } = add("add", "https://h.example", "-a", "claude-code", "cursor", "-s", "demo-skill", "--skill", "other-skill", "-y");
    expect(options.agents).toEqual(["claude-code", "cursor"]);
    expect(options.skills).toEqual(["demo-skill", "other-skill"]);
    expect(options.yes).toBe(true);
  });

  it("expands --all", () => {
    expect(add("add", "https://h.example", "--all").options).toMatchObject({ skills: ["*"], agents: ["*"], yes: true });
  });

  it("shows help and the version", () => {
    expect(parseCommandLine([])).toEqual({ kind: "help" });
    expect(parseCommandLine(["--help"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["add", "-h"])).toEqual({ kind: "help" });
    expect(parseCommandLine(["-v"])).toEqual({ kind: "version" });
    expect(parseCommandLine(["--version"])).toEqual({ kind: "version" });
  });

  it("rejects unknown commands and options", () => {
    expect(failure(() => parseCommandLine(["remove", "x"]))).toBe("Unknown command: remove");
    expect(failure(() => parseCommandLine(["add", "https://h.example", "--full-depth"]))).toBe("Unknown option: --full-depth");
  });

  it("needs exactly one URL", () => {
    expect(failure(() => parseCommandLine(["add"]))).toBe("Missing the registry URL");
    expect(failure(() => parseCommandLine(["add", "https://a.example", "https://b.example"]))).toBe("Only one URL can be given");
  });

  it("needs a value after -a and -s", () => {
    expect(failure(() => parseCommandLine(["add", "https://h.example", "-a"]))).toBe("-a needs at least one value");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/args.test.ts`
Expected: FAIL, because `../src/args.js` cannot be resolved.

- [ ] **Step 3: Implement `src/args.ts`**

```ts
import type { AddOptions } from "./add.js";
import { CliError } from "./errors.js";

export const USAGE = `Usage: skillsgist add <url> [options]

Install Agent Skills from a skillsgist registry. The URL and its install key are never stored.

Options:
  -g, --global            Install into your home directory instead of the project
  -a, --agent <ids...>    Agents to install to ('*' for all)
  -s, --skill <names...>  Skills to install ('*' for all)
  -y, --yes               Skip all prompts
      --copy              Copy into each agent directory instead of symlinking
      --all               Same as -s '*' -a '*' -y
  -l, --list              List the registry's skills without installing
  -h, --help              Show this help
  -v, --version           Show the version
`;

export type Command = { kind: "help" } | { kind: "version" } | { kind: "add"; url: string; options: AddOptions };

const ADD_COMMANDS = new Set(["add", "a", "install", "i"]);

export function parseCommandLine(argv: string[]): Command {
  const [command, ...rest] = argv;
  if (command === undefined || command === "-h" || command === "--help") return { kind: "help" };
  if (command === "-v" || command === "--version") return { kind: "version" };
  if (!ADD_COMMANDS.has(command)) throw new CliError(`Unknown command: ${command}`, { showUsage: true });
  const options: AddOptions = { global: false, agents: null, skills: null, yes: false, copy: false, list: false };
  let url: string | null = null;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    switch (arg) {
      case "-g":
      case "--global":
        options.global = true;
        break;
      case "-y":
      case "--yes":
        options.yes = true;
        break;
      case "--copy":
        options.copy = true;
        break;
      case "-l":
      case "--list":
        options.list = true;
        break;
      case "--all":
        options.skills = ["*"];
        options.agents = ["*"];
        options.yes = true;
        break;
      case "-h":
      case "--help":
        return { kind: "help" };
      case "-a":
      case "--agent":
      case "-s":
      case "--skill": {
        const values: string[] = [];
        while (i + 1 < rest.length && !rest[i + 1].startsWith("-")) {
          values.push(rest[i + 1]);
          i += 1;
        }
        if (values.length === 0) throw new CliError(`${arg} needs at least one value`, { showUsage: true });
        if (arg === "-a" || arg === "--agent") options.agents = [...(options.agents ?? []), ...values];
        else options.skills = [...(options.skills ?? []), ...values];
        break;
      }
      default:
        if (arg.startsWith("-")) throw new CliError(`Unknown option: ${arg}`, { showUsage: true });
        if (url !== null) throw new CliError("Only one URL can be given", { showUsage: true });
        url = arg;
    }
  }
  if (url === null) throw new CliError("Missing the registry URL", { showUsage: true });
  return { kind: "add", url, options };
}
```

Run: `npx vitest run test/args.test.ts`
Expected: PASS.

- [ ] **Step 4: Implement `src/ui.ts` and `src/cli.ts`**

`src/ui.ts`:

```ts
import * as clack from "@clack/prompts";
import { CANCELLED, type AgentRequest, type Cancellable, type Ui } from "./add.js";
import type { SkillEntry } from "./registry.js";
import { redact } from "./source.js";

function settle<T>(value: T | symbol): Cancellable<T> {
  return clack.isCancel(value) ? CANCELLED : (value as T);
}

function hint(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

export function clackUi(): Ui {
  return {
    intro: (title) => clack.intro(redact(title)),
    step: (message) => clack.log.step(redact(message)),
    info: (message) => clack.log.info(redact(message)),
    warn: (message) => clack.log.warn(redact(message)),
    error: (message) => clack.log.error(redact(message)),
    message: (message) => clack.log.message(redact(message)),
    note: (body, title) => clack.note(redact(body), redact(title)),
    cancel: (message) => clack.cancel(redact(message)),
    outro: (message) => clack.outro(redact(message)),
    async selectSkills(skills: SkillEntry[]) {
      const chosen = settle<string[]>(
        await clack.multiselect({
          message: "Select skills to install",
          options: skills.map((skill) => ({ value: skill.name, label: skill.name, hint: hint(skill.description) })),
          required: true,
        }),
      );
      return chosen === CANCELLED ? CANCELLED : skills.filter((skill) => chosen.includes(skill.name));
    },
    async selectAgents(request: AgentRequest) {
      if (request.locked.length > 0) {
        clack.log.info(`Universal (.agents/skills), always included: ${request.locked.map((agent) => agent.displayName).join(", ")}`);
      }
      return settle<string[]>(
        await clack.autocompleteMultiselect({
          message: "Which agents do you want to install to?",
          options: request.choices.map((agent) => ({ value: agent.id, label: agent.displayName, hint: agent.skillsDir })),
          initialValues: request.initial,
          required: request.locked.length === 0,
          placeholder: "Type to search",
        }),
      );
    },
    async selectScope() {
      return settle<boolean>(
        await clack.select({
          message: "Installation scope",
          options: [
            { value: false, label: "Project", hint: "Install in the current directory" },
            { value: true, label: "Global", hint: "Install in your home directory" },
          ],
        }),
      );
    },
    async confirm(message: string) {
      return settle<boolean>(await clack.confirm({ message: redact(message) }));
    },
  };
}
```

`src/cli.ts`:

```ts
#!/usr/bin/env node
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { runAdd } from "./add.js";
import { parseCommandLine, USAGE } from "./args.js";
import { CliError } from "./errors.js";
import { clackUi } from "./ui.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(argv: string[]): Promise<number> {
  const ui = clackUi();
  try {
    const command = parseCommandLine(argv);
    if (command.kind === "help") {
      process.stdout.write(USAGE);
      return 0;
    }
    if (command.kind === "version") {
      process.stdout.write(`${version}\n`);
      return 0;
    }
    return await runAdd(command.url, command.options, {
      ui,
      home: homedir(),
      cwd: process.cwd(),
      env: process.env,
      interactive: Boolean(process.stdin.isTTY),
    });
  } catch (err) {
    ui.error(err instanceof Error ? err.message : String(err));
    if (err instanceof CliError && err.showUsage) process.stderr.write(USAGE);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
```

Run: `npm run build && node dist/cli.js --version && node dist/cli.js --help`
Expected: prints `0.1.0`, then the usage text.

- [ ] **Step 5: Write the connection recorder and the end-to-end test**

`test/fixtures/record-connections.mjs`:

```js
import { appendFileSync } from "node:fs";
import net from "node:net";

const log = process.env.CONNECTION_LOG;
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const where = typeof target === "object" && target !== null ? `${target.host ?? "localhost"}:${target.port}` : `${args[1] ?? "localhost"}:${target}`;
  if (log) appendFileSync(log, `${where}\n`);
  return connect.apply(this, args);
};
```

`test/e2e.test.ts`:

```ts
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanup, filesContaining, tempDir } from "./helpers/fs.js";
import { KEY, publishIndex, skillZip, startRegistry, type TestRegistry } from "./helpers/registry.js";

const CLI = resolve("dist/cli.js");
const RECORDER = pathToFileURL(resolve("test/fixtures/record-connections.mjs")).href;

interface Sandbox {
  home: string;
  cwd: string;
  log: string;
}

interface Result {
  code: number;
  output: string;
  connections: string[];
}

let registry: TestRegistry;

beforeAll(async () => {
  if (!existsSync(CLI)) throw new Error("dist/cli.js is missing: run npm run build first");
  registry = await startRegistry();
  const demo = { name: "demo-skill", zip: skillZip("demo-skill", { "references/api.md": "api", "scripts/run.sh": "echo run" }) };
  publishIndex(registry, `/i/${KEY}`, [demo, { name: "other-skill", zip: skillZip("other-skill") }]);
  publishIndex(registry, `/i/${KEY}/.well-known/agent-skills/demo-skill`, [demo]);
});

afterAll(() => registry.close());
afterEach(cleanup);

function sandbox(): Sandbox {
  const root = tempDir();
  const box = { home: join(root, "home"), cwd: join(root, "project"), log: join(root, "connections.log") };
  mkdirSync(box.home);
  mkdirSync(box.cwd);
  return box;
}

function run(box: Sandbox, args: string[], env: Record<string, string> = {}): Promise<Result> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      ["--import", RECORDER, CLI, ...args],
      {
        cwd: box.cwd,
        env: {
          PATH: process.env.PATH ?? "",
          HOME: box.home,
          USERPROFILE: box.home,
          XDG_CONFIG_HOME: join(box.home, ".config"),
          CONNECTION_LOG: box.log,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const connections = existsSync(box.log) ? readFileSync(box.log, "utf8").split("\n").filter(Boolean) : [];
        done({ code: error ? Number(error.code ?? 1) : 0, output: `${stdout}${stderr}`, connections });
      },
    );
  });
}

function expectNoLeak(box: Sandbox, result: Result): void {
  expect(result.output).not.toContain(KEY);
  expect(filesContaining(box.home, KEY)).toEqual([]);
  expect(filesContaining(box.cwd, KEY)).toEqual([]);
  const registryHost = new URL(registry.origin).host;
  expect(result.connections.filter((connection) => connection !== registryHost)).toEqual([]);
}

describe("skillsgist add", () => {
  it("runs the skillsgist agent prompt inside Claude Code without leaving the key behind", async () => {
    const box = sandbox();
    const result = await run(
      box,
      ["add", `${registry.origin}/i/${KEY}/.well-known/agent-skills/demo-skill`, "--skill", "demo-skill", "-g", "-y"],
      { CLAUDECODE: "1" },
    );
    expect(result.code).toBe(0);
    expect(result.output).toMatch(/✓ ~\/\.agents\/skills\/demo-skill\b/);
    expect(result.output).toContain("/i/0123…");
    expect(existsSync(join(box.home, ".agents/skills/demo-skill/references/api.md"))).toBe(true);
    expect(lstatSync(join(box.home, ".claude/skills/demo-skill")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(box.home, ".claude/skills/demo-skill/SKILL.md"), "utf8")).toContain("name: demo-skill");
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(result.connections.length).toBeGreaterThan(0);
    expectNoLeak(box, result);
  });

  it("installs every skill of a key into the project with -y", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "-y"]);
    expect(result.code).toBe(0);
    expect(readdirSync(join(box.cwd, ".agents/skills")).sort()).toEqual(["demo-skill", "other-skill"]);
    expect(readdirSync(box.home)).toEqual([]);
    expectNoLeak(box, result);
  });

  it("copies with --copy", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "-s", "demo-skill", "-a", "claude-code", "--copy", "-y"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("✓ demo-skill (copied)");
    expect(lstatSync(join(box.cwd, ".claude/skills/demo-skill")).isDirectory()).toBe(true);
    expectNoLeak(box, result);
  });

  it("lists skills without writing anything", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "--list"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("other-skill");
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(readdirSync(box.home)).toEqual([]);
    expectNoLeak(box, result);
  });

  it("writes nothing when an artifact fails its digest check", async () => {
    const box = sandbox();
    publishIndex(registry, "/tampered", [{ name: "demo-skill", zip: skillZip("demo-skill") }]);
    for (const [path, route] of registry.routes) {
      if (path.startsWith("/tampered/d/")) route.body = skillZip("demo-skill", { "evil.md": "x" });
    }
    const result = await run(box, ["add", `${registry.origin}/tampered`, "-y"]);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/sha256/);
    expect(readdirSync(box.cwd)).toEqual([]);
    expectNoLeak(box, result);
  });

  it("skips an index entry on another origin and never contacts it", async () => {
    const box = sandbox();
    publishIndex(registry, "/mixed", [{ name: "demo-skill", zip: skillZip("demo-skill") }], {
      overrides: [{ name: "far-skill", description: "Far.", type: "archive", url: "https://far.example/far.zip", digest: `sha256:${"0".repeat(64)}` }],
    });
    const result = await run(box, ["add", `${registry.origin}/mixed`, "-y"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("Skipped index entry far-skill: url points to another origin");
    expectNoLeak(box, result);
  });

  it("refuses plain http to a remote host before connecting anywhere", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `http://skills.example.com/i/${KEY}`, "-y"]);
    expect(result.code).toBe(1);
    expect(result.output).toMatch(/use https/);
    expect(result.connections).toEqual([]);
    expectNoLeak(box, result);
  });

  it("prints the usage for an unknown option", async () => {
    const box = sandbox();
    const result = await run(box, ["add", `${registry.origin}/i/${KEY}`, "--full-depth"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain("Unknown option: --full-depth");
    expect(result.output).toContain("Usage: skillsgist add <url> [options]");
  });
});
```

- [ ] **Step 6: Run the whole suite**

Run: `npm test && npm run typecheck`
Expected: `tsc` builds `dist/`, every test file passes (source, registry, archive, agents, installer, add, args, e2e), and the type check prints nothing.

- [ ] **Step 7: Try the interactive flow by hand**

The prompts are not covered by automated tests, so drive them once in a real terminal. Write a throwaway registry inside the repo, so that its `fflate` import resolves (`serve.tmp.mjs` is deleted again at the end of this step):

```bash
cat > serve.tmp.mjs <<'EOF'
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { strToU8, zipSync } from "fflate";
const KEY = "0123456789abcdef0123456789abcdef";
const routes = new Map();
const skills = ["demo-skill", "other-skill"].map((name) => {
  const zip = zipSync({ "SKILL.md": strToU8(`---\nname: ${name}\ndescription: The ${name} skill.\n---\n`) });
  const hex = createHash("sha256").update(zip).digest("hex");
  routes.set(`/i/${KEY}/d/${name}/${hex}.zip`, zip);
  return { name, description: `The ${name} skill.`, type: "archive", url: `http://127.0.0.1:8790/i/${KEY}/d/${name}/${hex}.zip`, digest: `sha256:${hex}` };
});
routes.set(`/i/${KEY}/.well-known/agent-skills/index.json`, JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills }));
createServer((req, res) => { const body = routes.get(req.url); res.writeHead(body ? 200 : 404); res.end(body ?? "not found"); }).listen(8790, "127.0.0.1");
EOF
node serve.tmp.mjs &
```

Then, in an empty directory in a real terminal, run:

```bash
node <path to skillsgist-cli>/dist/cli.js add http://127.0.0.1:8790/i/0123456789abcdef0123456789abcdef
```

Expected:
- the skills multiselect, then the agent picker, then Project/Global, then the summary and confirmation;
- the key shown only as `/i/0123…`;
- Ctrl+C at any prompt prints `Installation cancelled`, and the exit status is 0.

Then stop the server and delete the script: `kill %1 && rm serve.tmp.mjs`. Run `git status --short` and confirm that `serve.tmp.mjs` is gone.

- [ ] **Step 8: Write the README**

Replace `README.md` with:

````markdown
# skillsgist

Install Agent Skills from a [skillsgist](https://github.com/Qsnh/skillsgist) registry into Claude Code, Codex, Cursor and dozens of other coding agents, without storing the registry's install key anywhere.

```bash
npx skillsgist add https://skills.example.com/i/<install_key>
```

## Why not `npx skills`?

`npx skills add` works with a skillsgist registry. But a skillsgist install key lives in the URL, and `npx skills` 1.5 does not keep that URL to itself:

- a global install writes it to `~/.agents/.skill-lock.json`;
- its telemetry sends it to `add-skill.vercel.sh` unless `DO_NOT_TRACK` is set;
- a bare `https://host/i/<key>` is looked up on `api.github.com`;
- it prints the full URL.

`npx skillsgist add` installs into the same directories for the same agents, and:

- writes nothing but the skill files and their symlinks: no lock file, no state, no cache;
- talks to no host but the one in the URL, and never follows a redirect;
- masks the key in everything it prints (`/i/abcd…`).

## Usage

```
npx skillsgist add <url> [options]
```

| Option | Meaning |
|---|---|
| `-g, --global` | Install into your home directory instead of the project |
| `-a, --agent <ids...>` | Agents to install to; `'*'` means all |
| `-s, --skill <names...>` | Skills to install; `'*'` means all |
| `-y, --yes` | Skip all prompts |
| `--copy` | Copy into each agent directory instead of symlinking |
| `--all` | Same as `-s '*' -a '*' -y` |
| `-l, --list` | List the registry's skills without installing |

The URL is any address a skillsgist page shows:

- `https://host` for public skills;
- `https://host/p/<project>` for one project's public skills;
- `https://host/i/<key>` for every skill your key opens;
- `https://host/i/<key>/.well-known/agent-skills/<skill>` for one skill.

Each skill lands in `.agents/skills/<name>`, or in `~/.agents/skills/<name>` with `-g`. Agents that read another directory get a symlink to it.

Inside a coding agent (Claude Code, Codex, Cursor and others are detected from their environment), `-y` is implied and the agent is added to the targets.

## What can still see the key

- **The command line.** Your shell history and the agent's transcript keep the command you ran.
- **npm's debug logs.** npm writes the full command line of every `npx` run to `_logs` in its cache directory (`npm config get cache`, usually `~/.npm`). Run `npx --logs-max=0 skillsgist add ...` to skip them, and delete old logs left by earlier `npx skills` runs.

If a key has leaked, reset it on the project's settings page in skillsgist.

## Development

```bash
npm install
npm test
npm run typecheck
```

`npm test` builds `dist/` first, because the end-to-end tests run the real binary.

## License

[MIT](LICENSE)
````

- [ ] **Step 9: Commit**

```bash
git add src/args.ts src/ui.ts src/cli.ts test/args.test.ts test/e2e.test.ts test/fixtures/record-connections.mjs README.md
git commit -m "feat: ship the skillsgist binary with end-to-end leak checks"
```

---

### Task 8: skillsgist UI, copy and tests

Work in `../skillsgist`, the skillsgist checkout next to this repository.

**Files:**
- Modify: `src/views/skills.tsx` (`skillsAdd` and its two call sites; `HeroLede`)
- Modify: `src/views/projects.tsx:135`, `src/views/projects.tsx:176`
- Modify: `src/i18n/en.ts`, `src/i18n/zh-CN.ts`, `src/i18n/zh-TW.ts`, `src/i18n/ja.ts` (`heroAnon`, `commandKeyNote`)
- Test: `test/skills.test.ts`, `test/projects.test.ts`, `test/users.test.ts`, `test/i18n.test.ts`

**Interfaces:**
- Produces:
  - The rendered page commands `npx skillsgist add <url>`.
  - The agent prompt command `npx -y skillsgist add <url> --skill <slug> -g -y`, which Task 9's `verify-cli` reads off the page.

- [ ] **Step 1: Branch**

```bash
cd ../skillsgist
git checkout -b feat/skillsgist-cli
```

- [ ] **Step 2: Update the tests first**

```bash
sed -i '' \
  -e 's/npx skills add/npx skillsgist add/g' \
  -e 's/npx -y skills add/npx -y skillsgist add/g' \
  -e 's#<code>npx skills</code>#<code>npx skillsgist</code>#g' \
  -e 's/installs one skill with skills add/installs one skill with skillsgist add/' \
  -e 's/`skills add` installs every entry/`skillsgist add` installs every entry/' \
  test/skills.test.ts test/projects.test.ts test/users.test.ts test/i18n.test.ts
```

Then replace the `COMMAND_KEY_NOTE` constant in `test/skills.test.ts` with:

```ts
const COMMAND_KEY_NOTE =
  '<p class="cf-install-note">This command carries your install key for Default. skillsgist does not store it anywhere, but your shell history and agent transcripts may keep it. Keep the command out of shared chats and public repositories, and reset the key under <a href="/p/default/settings">Settings</a> if it leaks.</p>';
```

Check that nothing still expects the old CLI:

Run: `git grep -n "npx skills\|skills-lock" test/`
Expected: no output.

- [ ] **Step 3: Run the affected tests to verify they fail**

Run: `npx vitest run test/skills.test.ts test/projects.test.ts test/users.test.ts test/i18n.test.ts`
Expected: FAIL. The pages still render `npx skills add`, and the key note still mentions `skills-lock.json`.

- [ ] **Step 4: Change the views**

In `src/views/skills.tsx`, replace

```tsx
function skillsAdd(url: string) {
  return `skills add ${url}`;
}
```

with

```tsx
function skillsgistAdd(url: string) {
  return `skillsgist add ${url}`;
}
```

Then make three more edits in the same file:
- Change `<CodeBlock raised>npx {skillsAdd(props.url)}</CodeBlock>` to `<CodeBlock raised>npx {skillsgistAdd(props.url)}</CodeBlock>`.
- Change `` {t.skills.agentPrompt(`npx -y ${skillsAdd(props.promptUrl)} --skill ${props.slug} -g -y`)} `` to `` {t.skills.agentPrompt(`npx -y ${skillsgistAdd(props.promptUrl)} --skill ${props.slug} -g -y`)} ``.
- Change `{t.skills.heroAnon(<code>npx skills</code>, <a href="/login">{t.layout.signIn}</a>)}` to `{t.skills.heroAnon(<code>npx skillsgist</code>, <a href="/login">{t.layout.signIn}</a>)}`.

In `src/views/projects.tsx`, make two edits:
- Change `{base ? <CodeBlock raised>npx skills add {base}</CodeBlock> : null}` to `{base ? <CodeBlock raised>npx skillsgist add {base}</CodeBlock> : null}`.
- Change ``<CodeBlock>npx skills add {`${props.origin}${installKeyPath(membership.install_key)}`}</CodeBlock>`` to ``<CodeBlock>npx skillsgist add {`${props.origin}${installKeyPath(membership.install_key)}`}</CodeBlock>``.

- [ ] **Step 5: Change the copy in all four languages**

`src/i18n/en.ts`, `heroAnon`:

```ts
    heroAnon: (cli: Slot, signIn: Slot) => [
      "This registry serves Agent Skills, installed with the ",
      cli,
      " CLI. Every skill has its install command on its page, and public skills need no key. ",
      signIn,
      " to see the private ones.",
    ],
```

`src/i18n/en.ts`, `commandKeyNote`:

```ts
    commandKeyNote: (name: string, settings: Slot) => [
      `This command carries your install key for ${name}. skillsgist does not store it anywhere, but your shell history and agent transcripts may keep it. Keep the command out of shared chats and public repositories, and reset the key under `,
      settings,
      " if it leaks.",
    ],
```

`src/i18n/zh-CN.ts`:

```ts
    heroAnon: (cli, signIn) => [
      "本仓库提供 Agent Skills，用 ",
      cli,
      " CLI 安装。每个技能的页面上都有它的安装命令，公开技能无需密钥。",
      signIn,
      "后可查看私有技能。",
    ],
```

```ts
    commandKeyNote: (name, settings) => [
      `这条命令带有你在 ${name} 的安装密钥。skillsgist 不会在任何地方保存它，但 shell 历史和智能体的对话记录可能会留下它。不要把这条命令发到共享聊天或公开的代码仓库里；如果泄露，请前往`,
      settings,
      "重置密钥。",
    ],
```

`src/i18n/zh-TW.ts`:

```ts
    heroAnon: (cli, signIn) => [
      "此儲存庫提供 Agent Skills，以 ",
      cli,
      " CLI 安裝。每個技能的頁面上都有它的安裝指令，公開技能不需要金鑰。",
      signIn,
      "後即可查看私人技能。",
    ],
```

```ts
    commandKeyNote: (name, settings) => [
      `這條指令包含你在 ${name} 的安裝金鑰。skillsgist 不會在任何地方保存它，但 shell 歷史記錄和 AI 代理的對話記錄可能會留下它。不要把這條指令貼到共用聊天室或公開的程式碼儲存庫；如果外洩，請前往`,
      settings,
      "重設金鑰。",
    ],
```

`src/i18n/ja.ts`:

```ts
    heroAnon: (cli, signIn) => [
      "このレジストリは Agent Skills を配信し、",
      cli,
      " CLI でインストールできます。各スキルのページにインストールコマンドがあり、パブリックなスキルにはキーが要りません。プライベートなスキルを見るには",
      signIn,
      "してください。",
    ],
```

```ts
    commandKeyNote: (name, settings) => [
      `このコマンドには ${name} 用のあなたのインストールキーが含まれています。skillsgist はこれをどこにも保存しませんが、シェルの履歴やエージェントの会話記録に残ることがあります。コマンドを共有チャットや公開リポジトリに載せず、漏れた場合は`,
      settings,
      "でキーをリセットしてください。",
    ],
```

- [ ] **Step 6: Run the whole suite and the type check**

Run: `npm test && npm run typecheck`
Expected: every test passes; `tsc` prints nothing.

Run: `git grep -n "npx skills\|skills-lock" src/`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add src/views/skills.tsx src/views/projects.tsx src/i18n/en.ts src/i18n/zh-CN.ts src/i18n/zh-TW.ts src/i18n/ja.ts test/skills.test.ts test/projects.test.ts test/users.test.ts test/i18n.test.ts
git commit -m "feat: show npx skillsgist install commands and say where the key can still leak"
```

---

### Task 9: skillsgist contract test, docs and images

Work in `../skillsgist`, on the branch from Task 8. Needs Task 7's `dist/cli.js` built in `../skillsgist-cli`.

**Files:**
- Modify: `scripts/verify-cli.mjs` (lines 2, 7; add a helper after `findFile`; replace the agent-prompt loop)
- Modify: `README.md`, `PRODUCT.md`, `.github/ISSUE_TEMPLATE/bug_report.yml`, `scripts/social-preview.html:137`
- Regenerate: `docs/images/home.png`, `docs/images/skill.png`, `docs/images/social-preview.png`, `public/og.png`

**Interfaces:**
- Consumes:
  - The agent prompt command rendered by Task 8.
  - The `skillsgist` binary (Task 7), via `SKILLSGIST_CLI=<checkout>` until it is on npm.

- [ ] **Step 1: Make `verify-cli` run the skillsgist agent prompt and check for leftover keys**

Make these changes in `scripts/verify-cli.mjs`.

Change line 2 to:

```js
// Verify registry protocol compatibility against the real `npx skills`, and that the page's agent prompt installs through `npx skillsgist` without leaving the install key on disk.
```

Change line 7 to:

```js
import { basename, join, resolve } from "node:path";
```

Add this helper right after the `findFile` function:

```js
function filesContaining(root, needle) {
  const hits = [];
  if (!existsSync(root)) return hits;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        if (readlinkSync(full).includes(needle)) hits.push(full);
      } else if (st.isDirectory()) stack.push(full);
      else if (readFileSync(full).includes(needle)) hits.push(full);
    }
  }
  return hits;
}
```

Add `lstatSync` and `readlinkSync` to the `node:fs` import on line 6:

```js
import { mkdtempSync, readFileSync, existsSync, readdirSync, rmSync, statSync, lstatSync, readlinkSync } from "node:fs";
```

Replace everything from `const older = shown.replace(/\bskills add\b/, "skills@1.5.7 add");` through the closing `}` of the outer `for (const [cli, command] of ...)` loop with:

```js
  if (!shown.startsWith("npx -y skillsgist add ")) throw new Error(`the agent prompt does not run skillsgist add: ${shown}`);
  const localCli = process.env.SKILLSGIST_CLI ? join(resolve(process.env.SKILLSGIST_CLI), "dist", "cli.js") : null;
  if (localCli && !existsSync(localCli)) throw new Error(`SKILLSGIST_CLI has no dist/cli.js at ${localCli}; run npm run build there first`);
  const command = localCli ? shown.replace("npx -y skillsgist", `node ${JSON.stringify(localCli)}`) : shown;
  for (const [where, agentEnv, agentDir] of [
    ["inside Claude Code", { CLAUDECODE: "1" }, ".claude"],
    ["inside an agent the CLI does not know", {}, null],
  ]) {
    const label = `the agent prompt run with skillsgist ${where}`;
    const project = tempDir();
    const home = tempDir();
    const env = isolatedEnv(home, { ...agentEnv, npm_config_cache: tempDir("skillsgist-verify-npm-") });
    const output = await inTerminal(command, { cwd: project, env });
    const reported = /~\/\.agents\/skills\/demo-skill\b/.exec(output)?.[0];
    if (!reported) throw new Error(`${label} did not report the global directory of demo-skill:\n${output}`);
    const dir = join(home, reported.slice(2));
    if (
      !existsSync(join(dir, "SKILL.md")) ||
      !readFileSync(join(dir, "SKILL.md"), "utf8").includes("name: demo-skill") ||
      !existsSync(join(dir, "references", "api.md")) ||
      !existsSync(join(dir, "scripts", "run.sh"))
    ) {
      throw new Error(`${label} did not install demo-skill and its supporting files into ${reported}`);
    }
    expectInstalled(home, ["demo-skill"], label);
    if (agentDir && !existsSync(join(home, agentDir, "skills", "demo-skill", "SKILL.md"))) {
      throw new Error(`${label} did not install demo-skill for that agent`);
    }
    const leftovers = readdirSync(project);
    if (leftovers.length > 0) throw new Error(`${label} wrote into the project: ${leftovers.join(", ")}`);
    if (output.includes(installKey)) throw new Error(`${label} printed the install key`);
    const leaked = filesContaining(home, installKey);
    if (leaked.length > 0) throw new Error(`${label} left the install key in: ${leaked.join(", ")}`);
    log(`${label} installed demo-skill into ${reported}, left the project untouched and stored no key`);
  }
```

The block after the loop (`log("all contract checks passed")`) stays as it is.

- [ ] **Step 2: Run the contract test against the local CLI build**

```bash
(cd ../skillsgist-cli && npm run build)
SKILLSGIST_CLI=../skillsgist-cli npm run verify:cli
```

Expected: the log ends with `[verify-cli] all contract checks passed`. It includes two lines like `the agent prompt run with skillsgist inside Claude Code installed demo-skill into ~/.agents/skills/demo-skill, left the project untouched and stored no key`.

This step needs network access to `registry.npmjs.org`, because the protocol checks still run the real `npx skills`. If it fails, fix the cause before moving on. Don't loosen the checks.

- [ ] **Step 3: Update `README.md`**

Make these edits.

Replace

```
- A copyable agent prompt next to each skill's install command that has an agent install the skill with `npx skills add` and follow it right away
```

with

```
- A copyable agent prompt next to each skill's install command that has an agent install the skill with `npx skillsgist add` and follow it right away
```

Replace

```
  cli["npx skills add"] -- "GET /i/:key/.well-known/agent-skills/index.json" --> worker
```

with

```
  cli["npx skillsgist add"] -- "GET /i/:key/.well-known/agent-skills/index.json" --> worker
```

Insert this section immediately before `## Projects, accounts and roles`:

````markdown
## Install skills

Every skill page and project page shows its install command, for example:

```bash
npx skillsgist add https://skills.example.com/i/<install_key>
```

[`skillsgist`](https://www.npmjs.com/package/skillsgist) is a small installer that speaks the same discovery protocol as `npx skills` and puts skills in the same places for the same agents. Unlike `npx skills`, it keeps the install key to itself: it writes no lock file, sends no telemetry, contacts no host but your instance and masks the key in its output. `npx skills add` with the same address still works.

The key still travels in the command, so shell history and agent transcripts can keep it. npm also writes the command line of every `npx` run to `_logs` in its cache directory (usually `~/.npm/_logs`). Run `npx --logs-max=0 skillsgist add ...` to skip that, and delete old logs from earlier `npx skills` runs.

````

In `## Development`, after the code block that ends with `npm run verify:cli`, add:

```markdown
Until `skillsgist` is published to npm, point `verify:cli` at a local build of [skillsgist-cli](../skillsgist-cli): `SKILLSGIST_CLI=../skillsgist-cli npm run verify:cli`.
```

- [ ] **Step 4: Update `PRODUCT.md`**

Make these exact replacements.

1. Replace `they hold an install key and run \`npx skills add\`.` with `they hold an install key and run \`npx skillsgist add\`.`
2. Replace `and installed with a single \`npx skills add\` command.` with `and installed with a single \`npx skillsgist add\` command.`
3. Replace `and still install them with the unmodified stock CLI, on infrastructure they own.` with `and still install them with one command, on infrastructure they own, without the install key being stored on the installing machine or sent to a third party.`
4. Replace the sentence that begins `The mechanism that makes this practical:` (through `by \`npm run verify:cli\`.`) with:

   ```
   The mechanism that makes this practical: skillsgist serves the skills.sh discovery protocol (`/.well-known/agent-skills/index.json`, discovery schema `0.2.0`) directly, so any client that speaks it can install, the stock `npx skills` included. The UI recommends `npx skillsgist`, a minimal installer that speaks the same protocol and never stores the install key or sends it anywhere but the instance. `npm run verify:cli` checks both end to end.
   ```

5. In the **Installing** bullet, replace `` `npx skills add https://<domain>/i/<install_key>` `` with `` `npx skillsgist add https://<domain>/i/<install_key>` ``. Then append ` \`npx skills add\` accepts the same addresses.` to the end of that bullet.
6. Replace `- **The stock CLI is the contract.** \`npx skills\` sends no custom headers, so a private install credential can only live in the URL path.` with `- **The discovery protocol is the contract.** Clients such as \`npx skills\` send no custom headers, so a private install credential can only live in the URL path.`
7. Replace `` - `npm run verify:cli` (`scripts/verify-cli.mjs`) — a contract test run against the real `npx skills` binary, the concrete proof behind the "no custom CLI needed" claim. `` with `` - `npm run verify:cli` (`scripts/verify-cli.mjs`) — a contract test run against the real `npx skills` binary and the skillsgist CLI, the proof that the protocol works with the stock client and that the recommended one leaves no install key behind. ``
8. Replace `2. **The stock CLI is the contract.** Speak the published discovery protocol; never require a custom client, and never break \`npx skills add\`.` with `2. **The discovery protocol is the contract.** Speak the published discovery protocol so any compatible client works, and never break \`npx skills add\`. The UI recommends \`npx skillsgist\` because it does not store the install key.`

Run: `git grep -n "stock CLI\|npx skills add" PRODUCT.md`
Expected: only the two intended mentions of `npx skills add`, in edits 5 and 8.

- [ ] **Step 5: Update the issue template and the social preview**

In `.github/ISSUE_TEMPLATE/bug_report.yml`:
- Replace ``2. Run `npx skills add https://<your-domain>/i/<install_key>` `` with ``2. Run `npx skillsgist add https://<your-domain>/i/<install_key>` ``.
- Replace `- Installing with npx skills` with `- Installing with npx skillsgist`.
- Replace `label: npx skills version` with `label: npx skillsgist version`.
- Replace ``description: Only if the problem involves installing. Run `npx skills --version`.`` with ``description: Only if the problem involves installing. Run `npx skillsgist --version`.``

In `scripts/social-preview.html` line 137, replace `npx skills add https://skills.example.com/i/&lt;install_key&gt;` with `npx skillsgist add https://skills.example.com/i/&lt;install_key&gt;`.

- [ ] **Step 6: Regenerate the images**

```bash
npm run screenshots
npm run logo
git status --short docs/images public
```

Expected:
- `docs/images/home.png`, `docs/images/skill.png`, `docs/images/social-preview.png` and `public/og.png` are modified.
- Open `docs/images/skill.png` and confirm it shows `npx skillsgist add`.
- If `npm run logo` also rewrote other files, such as `docs/images/logo.png`, restore them with `git checkout -- <file>` unless they really changed.

If Chrome cannot be launched, keep the old images, skip `git add` for them in Step 7, and report it.

- [ ] **Step 7: Run everything and commit**

Run: `npm test && npm run typecheck`
Expected: all pass.

```bash
git add scripts/verify-cli.mjs README.md PRODUCT.md .github/ISSUE_TEMPLATE/bug_report.yml scripts/social-preview.html docs/images/home.png docs/images/skill.png docs/images/social-preview.png public/og.png
git commit -m "docs: recommend npx skillsgist and verify that it leaves no install key behind"
```

---

## Out of Scope (from the spec)

- **Other commands:** `update`, `remove`, `list`, `find`, `init`, `check` and `use`.
- **Other sources:** GitHub, GitLab, git and local paths.
- **Other formats:** discovery 0.1 indexes, `skill-md` entries and tar.gz archives.
- **State:** lock files, remembered agent selection and telemetry.
- **Executable bits:** not preserved from archives.
- **npm's debug logs:** not scrubbed.
- **Other key inputs:** no reading the key from an environment variable or stdin.
- **Design docs:** `DESIGN.md` and `.impeccable/` in skillsgist are left as they are.
- **Publishing:** releasing the `skillsgist` package to npm is a separate, user-run step.
