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
