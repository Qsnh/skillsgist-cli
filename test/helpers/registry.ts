import { createHash } from "node:crypto";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { strToU8, zipSync } from "fflate";
import { DISCOVERY_SCHEMA } from "../../src/registry.js";

export const PROJECT = "team";
export const INSTALL_KEY = "sgi_0123456789abcdef0123456789abcdef";
export const LOGIN_TOKEN = "sgd_fedcba9876543210fedcba9876543210";
export const LOGIN_TOKEN_2 = "sgd_00112233445566778899aabbccddeeff";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Route {
  status?: number;
  body: string | Uint8Array;
  type?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  bodyDelayMs?: number;
  waitFor?: () => Promise<unknown>;
  trickle?: { pieces: number; everyMs: number };
  hangUpAfterBytes?: number;
  handler?: (request: RecordedRequest) => Route | Promise<Route>;
}

export interface TestRegistry {
  origin: string;
  requests: string[];
  log: RecordedRequest[];
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
  const log: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    requests.push(path);
    const sendBody = (route: Route) => {
      const body = Buffer.from(route.body);
      if (route.hangUpAfterBytes !== undefined) {
        res.write(body.subarray(0, route.hangUpAfterBytes), () => res.destroy());
      } else if (route.trickle) {
        const { pieces, everyMs } = route.trickle;
        const size = Math.ceil(body.length / pieces);
        const next = (offset: number) => {
          if (res.destroyed) return;
          if (offset >= body.length) {
            res.end();
            return;
          }
          res.write(body.subarray(offset, offset + size));
          setTimeout(() => next(offset + size), everyMs);
        };
        next(0);
      } else {
        res.end(route.body);
      }
    };
    const send = (route: Route | undefined) => {
      if (!route) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(route.status ?? 200, { "content-type": route.type ?? "application/octet-stream", ...route.headers });
      if (route.bodyDelayMs) {
        res.flushHeaders();
        setTimeout(() => sendBody(route), route.bodyDelayMs);
      } else {
        sendBody(route);
      }
    };
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded: RecordedRequest = { method: req.method ?? "GET", path, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      log.push(recorded);
      const found = routes.get(path);
      void Promise.resolve(found?.handler ? found.handler(recorded) : found).then((route) => {
        if (route?.waitFor) void route.waitFor().then(() => send(route));
        else if (route?.delayMs) setTimeout(() => send(route), route.delayMs);
        else send(route);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    log,
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

// Like the server: without a token the index lists no skills (none are public)
// and artifacts are missing; a token not in `tokens` gets 401 invalid_token.
export function publishPrivate(registry: TestRegistry, basePath: string, skills: Published[], tokens: string[]): void {
  publishIndex(registry, basePath, skills);
  for (const [path, open] of [...registry.routes]) {
    if (!path.startsWith(`${basePath}/`) || open.handler) continue;
    registry.routes.set(path, {
      body: "",
      handler: ({ headers }) => {
        const token = /^Bearer (.+)$/.exec(headers.authorization ?? "")?.[1];
        if (token === undefined) {
          return path.endsWith("/index.json")
            ? { type: "application/json", body: JSON.stringify({ $schema: DISCOVERY_SCHEMA, skills: [] }) }
            : { status: 404, body: "not found" };
        }
        return tokens.includes(token) ? open : { status: 401, type: "application/json", body: JSON.stringify({ error: "invalid_token" }) };
      },
    });
  }
}
