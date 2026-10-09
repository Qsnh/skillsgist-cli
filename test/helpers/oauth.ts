import { DEVICE_GRANT } from "../../src/oauth.js";
import { LOGIN_TOKEN, LOGIN_TOKEN_2, type Route, type TestRegistry } from "./registry.js";

export interface FakeAuthOptions {
  user?: string;
  projects?: string[];
  tokens?: string[];
  pendingPolls?: number;
  slowDownOnPoll?: number;
  outcome?: "approve" | "deny" | "expire" | "invalid_client";
  interval?: number;
  expiresIn?: number;
  installKeys?: Record<string, string>;
  metadata?: Record<string, unknown>;
  device?: Record<string, unknown>;
  tokenAnswer?: Record<string, unknown>;
  revokeStatus?: number;
}

export interface FakeAuth {
  deviceRequests: URLSearchParams[];
  tokenPolls: number;
  revoked: string[];
  live: Set<string>;
}

const json = (status: number, body: unknown): Route => ({ status, type: "application/json", body: JSON.stringify(body) });
const REFUSALS = { deny: "access_denied", expire: "expired_token", invalid_client: "invalid_client" } as const;

// A registry's OAuth side as the token-auth plan's §4 contract describes it.
// Each device request starts a new sign-in; the n-th one issues tokens[n - 1].
export function installFakeAuth(registry: TestRegistry, options: FakeAuthOptions = {}): FakeAuth {
  const { origin } = registry;
  const state: FakeAuth = { deviceRequests: [], tokenPolls: 0, revoked: [], live: new Set() };
  const tokens = options.tokens ?? [LOGIN_TOKEN, LOGIN_TOKEN_2];
  const projects = options.projects ?? ["team"];
  let issued = false;
  registry.routes.set(
    "/.well-known/oauth-authorization-server",
    json(200, {
      issuer: origin,
      device_authorization_endpoint: `${origin}/api/oauth/device`,
      token_endpoint: `${origin}/api/oauth/token`,
      revocation_endpoint: `${origin}/api/oauth/revoke`,
      grant_types_supported: [DEVICE_GRANT],
      ...options.metadata,
    }),
  );
  registry.routes.set("/api/oauth/device", {
    body: "",
    handler: (request) => {
      state.deviceRequests.push(new URLSearchParams(request.body));
      state.tokenPolls = 0;
      issued = false;
      return json(200, {
        device_code: "device-code-1",
        user_code: "BCDF-GHJK",
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?code=BCDF-GHJK`,
        expires_in: options.expiresIn ?? 600,
        interval: options.interval ?? 0,
        ...options.device,
      });
    },
  });
  registry.routes.set("/api/oauth/token", {
    body: "",
    handler: (request) => {
      const form = new URLSearchParams(request.body);
      if (issued || form.get("grant_type") !== DEVICE_GRANT || form.get("device_code") !== "device-code-1" || form.get("client_id") !== "skillsgist-cli") {
        return json(400, { error: "invalid_grant" });
      }
      state.tokenPolls += 1;
      if (state.tokenPolls === options.slowDownOnPoll) return json(400, { error: "slow_down" });
      if (state.tokenPolls <= (options.pendingPolls ?? 1)) return json(400, { error: "authorization_pending" });
      const outcome = options.outcome ?? "approve";
      if (outcome !== "approve") return json(400, { error: REFUSALS[outcome] });
      issued = true;
      const token = tokens[Math.min(state.deviceRequests.length, tokens.length) - 1];
      state.live.add(token);
      return json(200, { access_token: token, token_type: "Bearer", scope: projects.map((project) => `project:${project}`).join(" "), ...options.tokenAnswer });
    },
  });
  registry.routes.set("/api/oauth/revoke", {
    body: "",
    handler: (request) => {
      const token = new URLSearchParams(request.body).get("token") ?? "";
      state.revoked.push(token);
      state.live.delete(token);
      return { status: options.revokeStatus ?? 200, body: "" };
    },
  });
  registry.routes.set("/api/whoami", {
    body: "",
    handler: (request) => {
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "";
      if (state.live.has(bearer)) return json(200, { user: options.user ?? "alice", kind: "login", projects });
      const project = options.installKeys?.[bearer];
      if (project !== undefined) return json(200, { user: options.user ?? "alice", kind: "install_key", projects: [project] });
      return json(401, { error: "invalid_token" });
    },
  });
  return state;
}
