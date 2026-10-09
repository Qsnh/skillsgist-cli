import { setTimeout as delay } from "node:timers/promises";
import { CliError } from "./errors.js";
import { authFailure, bearer, discard, isToken, readJson, request, type FetchOptions, type Reply } from "./http.js";
import { printable, redact, registerSecret } from "./source.js";

export const CLIENT_ID = "skillsgist-cli";
export const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const MAX_JSON_BYTES = 64 * 1024;
const SLOW_DOWN_MS = 5000;
const DEFAULT_INTERVAL_S = 5;
const MIN_INTERVAL_MS = 1000;
const MAX_INTERVAL_MS = 60 * 1000;
const MAX_EXPIRES_S = 30 * 60;
const USER_CODE = /^[A-Za-z0-9-]{1,32}$/;

export interface OAuthOptions extends FetchOptions {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

export interface ServerMetadata {
  origin: string;
  deviceEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint: string | null;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  expiresIn: number;
  interval: number;
}

export interface Grant {
  token: string;
}

export interface Identity {
  user: string;
  projects: string[];
}

export function hostOf(origin: string): string {
  return new URL(origin).host;
}

function fields(body: unknown): Record<string, unknown> {
  return (body !== null && typeof body === "object" && !Array.isArray(body) ? body : {}) as Record<string, unknown>;
}

function sameOrigin(value: unknown, origin: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === origin && url.username === "" && url.password === "" ? url.href : null;
  } catch {
    return null;
  }
}

function issuerOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.pathname === "/" && url.search === "" ? url.origin : null;
  } catch {
    return null;
  }
}

async function failed(reply: Reply, url: string): Promise<CliError> {
  await discard(reply);
  return new CliError(`${redact(url)} answered HTTP ${reply.res.status}`);
}

function post(url: string, form: Record<string, string>, options: OAuthOptions): Promise<Reply> {
  return request(url, options, { method: "POST", form });
}

export async function discover(origin: string, options: OAuthOptions = {}): Promise<ServerMetadata> {
  const url = `${origin}/.well-known/oauth-authorization-server`;
  const reply = await request(url, options);
  if (reply.res.status === 404) {
    await discard(reply);
    throw new CliError(`${hostOf(origin)} does not support signing in yet. Ask its admin to upgrade skillsgist.`);
  }
  if (!reply.res.ok) throw await failed(reply, url);
  const body = fields(await readJson(reply, MAX_JSON_BYTES, redact(url)));
  if (issuerOrigin(body.issuer) !== origin) throw new CliError(`${hostOf(origin)} sent sign-in settings for another server`);
  const deviceEndpoint = sameOrigin(body.device_authorization_endpoint, origin);
  const tokenEndpoint = sameOrigin(body.token_endpoint, origin);
  if (deviceEndpoint === null || tokenEndpoint === null) throw new CliError(`${hostOf(origin)} sent invalid sign-in settings`);
  if (Array.isArray(body.grant_types_supported) && !body.grant_types_supported.includes(DEVICE_GRANT)) {
    throw new CliError(`${hostOf(origin)} does not support signing in from a terminal`);
  }
  return { origin, deviceEndpoint, tokenEndpoint, revocationEndpoint: sameOrigin(body.revocation_endpoint, origin) };
}

export async function requestDeviceCode(
  meta: ServerMetadata,
  wanted: { projects: string[]; deviceName: string },
  options: OAuthOptions = {},
): Promise<DeviceCode> {
  const form: Record<string, string> = { client_id: CLIENT_ID, device_name: wanted.deviceName };
  if (wanted.projects.length > 0) form.scope = wanted.projects.map((project) => `project:${project}`).join(" ");
  const reply = await post(meta.deviceEndpoint, form, options);
  if (!reply.res.ok) throw await failed(reply, meta.deviceEndpoint);
  const body = fields(await readJson(reply, MAX_JSON_BYTES, redact(meta.deviceEndpoint)));
  const verificationUri = sameOrigin(body.verification_uri, meta.origin);
  const interval = body.interval ?? DEFAULT_INTERVAL_S;
  if (
    typeof body.device_code !== "string" ||
    body.device_code === "" ||
    typeof body.user_code !== "string" ||
    !USER_CODE.test(body.user_code) ||
    verificationUri === null ||
    typeof body.expires_in !== "number" ||
    !(body.expires_in > 0) ||
    typeof interval !== "number" ||
    !(interval >= 0)
  ) {
    throw new CliError(`${hostOf(meta.origin)} sent an invalid sign-in code`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete: sameOrigin(body.verification_uri_complete, meta.origin),
    expiresIn: body.expires_in,
    interval,
  };
}

function expired(): CliError {
  return new CliError("The sign-in code expired. Run skillsgist login again.");
}

export async function pollForToken(meta: ServerMetadata, device: DeviceCode, options: OAuthOptions = {}): Promise<Grant> {
  const sleep = options.sleep ?? ((ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal }));
  const now = options.now ?? Date.now;
  const deadline = now() + Math.min(device.expiresIn, MAX_EXPIRES_S) * 1000;
  // Clamped both ways: a huge interval would overflow the timer and fire at once, or outlast the deadline.
  let interval = Math.min(Math.max(device.interval * 1000, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
  for (;;) {
    await sleep(interval, options.signal);
    if (now() >= deadline) throw expired();
    const reply = await post(meta.tokenEndpoint, { grant_type: DEVICE_GRANT, device_code: device.deviceCode, client_id: CLIENT_ID }, options);
    if (reply.res.ok) {
      const body = fields(await readJson(reply, MAX_JSON_BYTES, redact(meta.tokenEndpoint)));
      const token = body.access_token;
      if (typeof token !== "string" || !isToken(token) || typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") {
        throw new CliError(`${hostOf(meta.origin)} sent an invalid sign-in token`);
      }
      registerSecret(token);
      return { token };
    }
    if (reply.res.status !== 400 && reply.res.status !== 401) throw await failed(reply, meta.tokenEndpoint);
    let code: unknown = null;
    try {
      code = fields(await readJson(reply, MAX_JSON_BYTES, redact(meta.tokenEndpoint))).error;
    } catch {
      // Handled below as an unknown refusal.
    }
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval = Math.min(interval + SLOW_DOWN_MS, MAX_INTERVAL_MS);
      continue;
    }
    if (code === "access_denied") throw new CliError("Sign-in was denied in the browser");
    if (code === "expired_token") throw expired();
    const why = typeof code === "string" ? `: ${printable(code).slice(0, 100)}` : "";
    throw new CliError(`${hostOf(meta.origin)} refused the sign-in${why}`);
  }
}

export async function revokeToken(meta: ServerMetadata, token: string, options: OAuthOptions = {}): Promise<void> {
  if (meta.revocationEndpoint === null) throw new CliError(`${hostOf(meta.origin)} does not support signing out`);
  const reply = await post(meta.revocationEndpoint, { token, token_type_hint: "access_token", client_id: CLIENT_ID }, options);
  if (!reply.res.ok) throw await failed(reply, meta.revocationEndpoint);
  await discard(reply);
}

export async function whoami(origin: string, token: string, options: OAuthOptions = {}): Promise<Identity> {
  const url = `${origin}/api/whoami`;
  const reply = await request(url, { ...options, headers: bearer(token) });
  if (reply.res.status === 401 || reply.res.status === 403) throw await authFailure(reply, url);
  if (!reply.res.ok) throw await failed(reply, url);
  const body = fields(await readJson(reply, MAX_JSON_BYTES, redact(url)));
  const projects = body.projects;
  if (
    typeof body.user !== "string" ||
    !Array.isArray(projects) ||
    !projects.every((project) => typeof project === "string")
  ) {
    throw new CliError(`${redact(url)} sent an answer skillsgist cannot read`);
  }
  return { user: body.user, projects: projects as string[] };
}
