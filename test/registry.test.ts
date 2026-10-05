import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DISCOVERY_SCHEMA, MAX_ARTIFACT_BYTES, downloadArtifact, fetchIndex, indexCandidates, parseIndex } from "../src/registry.js";
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

  it("rejects an artifact larger than the cap even without a Content-Length header", async () => {
    const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
    registry.routes.set(`/i/${KEY}/d/demo-skill/large.zip`, { body: oversized, type: "application/zip" });
    const message = await failure(
      downloadArtifact({
        name: "demo-skill",
        description: "Demo.",
        url: `${registry.origin}/i/${KEY}/d/demo-skill/large.zip`,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    );
    expect(message).toMatch(/larger than/);
  });

  it("rejects an artifact whose Content-Length is over the cap before reading it", async () => {
    const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1);
    registry.routes.set(`/i/${KEY}/d/demo-skill/large.zip`, {
      body: oversized,
      type: "application/zip",
      headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) },
    });
    const message = await failure(
      downloadArtifact({
        name: "demo-skill",
        description: "Demo.",
        url: `${registry.origin}/i/${KEY}/d/demo-skill/large.zip`,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    );
    expect(message).toMatch(/larger than/);
  });
});
