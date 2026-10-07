import { hostname } from "node:os";
import type { Ui } from "./add.js";
import { detectRunningAgent, type Exists } from "./agents.js";
import { envCredential, hostOrigin, resolveCredential } from "./auth.js";
import { openBrowser, type Opener } from "./browser.js";
import { deleteLogin, getLogin, readCredentials, saveLogin, type ConfigContext, type HostLogin } from "./credentials.js";
import { CliError, errorMessage } from "./errors.js";
import { AuthError } from "./http.js";
import { discover, hostOf, pollForToken, requestDeviceCode, revokeToken, whoami, type Identity, type OAuthOptions } from "./oauth.js";
import { oneLine, parseSource, registerSecret, type Source } from "./source.js";

export { hostOf } from "./oauth.js";

export interface LoginOptions {
  browser: boolean;
}

export interface AccountContext {
  ui: Ui;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  interactive: boolean;
  exists?: Exists;
  fetch?: OAuthOptions;
  platform?: NodeJS.Platform;
  hostname?: string;
  openBrowser?: Opener;
}

export function configOf(context: AccountContext): ConfigContext {
  return { home: context.home, env: context.env, platform: context.platform, warn: (message) => context.ui.warn(message) };
}

export function signInUrl(source: Source): string {
  return source.project === null ? source.origin : `${source.origin}/p/${encodeURIComponent(source.project)}`;
}

function projectList(projects: string[]): string {
  return projects.length === 0 ? "no projects" : `projects: ${projects.join(", ")}`;
}

export async function signIn(source: Source, context: AccountContext, options: LoginOptions): Promise<HostLogin> {
  const { ui } = context;
  const config = configOf(context);
  const previous = getLogin(config, source.origin);
  if (previous !== null) registerSecret(previous.token);
  const meta = await discover(source.origin, context.fetch);
  const projects = [...new Set([...(source.project === null ? [] : [source.project]), ...(previous?.projects ?? [])])];
  const deviceName = oneLine(context.hostname ?? hostname()).trim().slice(0, 64) || "unknown device";
  const device = await requestDeviceCode(meta, { projects, deviceName }, context.fetch);
  const link = device.verificationUriComplete ?? device.verificationUri;
  ui.message(
    `Open ${link}\nand check that the page shows the code ${device.userCode}.\nThen tick the projects this computer may install from, and approve.`,
  );
  if (options.browser && context.interactive && !detectRunningAgent(context.env, context.exists).inAgent) {
    (context.openBrowser ?? openBrowser)(link);
  }
  ui.step("Waiting for approval in the browser (Ctrl+C to cancel)");
  const grant = await pollForToken(meta, device, context.fetch);
  let identity: Identity;
  try {
    identity = await whoami(source.origin, grant.token, context.fetch);
  } catch (err) {
    try {
      await revokeToken(meta, grant.token, context.fetch);
    } catch (revokeErr) {
      ui.warn(`Could not revoke the new sign-in (${errorMessage(revokeErr)}). Revoke it at ${source.origin}/me`);
    }
    throw err;
  }
  const now = context.fetch?.now ?? Date.now;
  const login: HostLogin = { user: identity.user, projects: identity.projects, token: grant.token, createdAt: new Date(now()).toISOString() };
  saveLogin(config, source.origin, login);
  if (previous !== null && previous.token !== login.token) {
    try {
      await revokeToken(meta, previous.token, context.fetch);
    } catch (err) {
      ui.warn(`Could not revoke this computer's previous sign-in (${errorMessage(err)}). Revoke it at ${source.origin}/me`);
    }
  }
  return login;
}

export async function runLogin(url: string, options: LoginOptions, context: AccountContext): Promise<number> {
  const source = parseSource(url);
  if (!detectRunningAgent(context.env, context.exists).inAgent) context.ui.intro("skillsgist login");
  const login = await signIn(source, context, options);
  context.ui.outro(`Signed in to ${hostOf(source.origin)} as ${login.user} (${projectList(login.projects)})`);
  return 0;
}

export async function runLogout(url: string | null, context: AccountContext): Promise<number> {
  const { ui } = context;
  const config = configOf(context);
  const { hosts } = readCredentials(config);
  const known = Object.keys(hosts);
  const origin = url !== null ? parseSource(url).origin : known.length === 1 ? known[0] : null;
  if (origin === null) {
    if (known.length === 0) {
      ui.info("Not signed in anywhere");
      return 0;
    }
    throw new CliError(`Signed in to ${known.length} registries (${known.join(", ")}). Name one: skillsgist logout <url>`);
  }
  const login = Object.hasOwn(hosts, origin) ? hosts[origin] : null;
  if (login === null) {
    ui.info(`Not signed in to ${hostOf(origin)}`);
  } else {
    registerSecret(login.token);
    try {
      await revokeToken(await discover(origin, context.fetch), login.token, context.fetch);
    } catch (err) {
      ui.warn(`Could not revoke the sign-in on ${hostOf(origin)} (${errorMessage(err)}). Revoke it at ${origin}/me`);
    }
    deleteLogin(config, origin);
    ui.outro(`Signed out of ${hostOf(origin)}`);
  }
  if (envCredential(origin, { ...config, warn: undefined }).kind === "env") {
    ui.info("SKILLSGIST_INSTALL_KEY is still set for this registry; logout does not change it");
  }
  return 0;
}

export async function runWhoami(url: string | null, context: AccountContext): Promise<number> {
  const { ui } = context;
  const config = configOf(context);
  let origins: string[];
  if (url !== null) {
    origins = [parseSource(url).origin];
  } else {
    const envHost = context.env.SKILLSGIST_INSTALL_KEY?.trim() ? hostOrigin(context.env.SKILLSGIST_HOST ?? "") : null;
    origins = [...new Set([...Object.keys(readCredentials(config).hosts), ...(envHost === null ? [] : [envHost])])];
  }
  if (origins.length === 0) {
    ui.info("Not signed in. Run: npx skillsgist login <url>");
    return 1;
  }
  const lookup: ConfigContext = url === null ? { ...config, warn: undefined } : config;
  const lines: string[] = [];
  let failed = false;
  for (const origin of origins) {
    const credential = resolveCredential(origin, lookup);
    if (credential.kind === "none") {
      failed = true;
      lines.push(`${origin}: not signed in`);
      continue;
    }
    const via = credential.kind === "env" ? "SKILLSGIST_INSTALL_KEY" : "sign-in";
    try {
      const identity = await whoami(origin, credential.token, context.fetch);
      lines.push(`${origin}: ${identity.user} via ${via} (${projectList(identity.projects)})`);
    } catch (err) {
      failed = true;
      lines.push(err instanceof AuthError && err.status === 401 ? `${origin}: the ${via} has expired or was revoked` : `${origin}: ${errorMessage(err)}`);
    }
  }
  ui.message(lines.join("\n"));
  return failed ? 1 : 0;
}
