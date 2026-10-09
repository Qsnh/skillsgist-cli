import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { posix, win32 } from "node:path";
import { CliError, errorMessage } from "./errors.js";
import { isToken } from "./http.js";

export interface ConfigContext {
  home: string;
  env: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  warn?: (message: string) => void;
}

export interface HostLogin {
  user: string;
  projects: string[];
  token: string;
  createdAt: string;
}

export interface Credentials {
  version: 1;
  hosts: Record<string, HostLogin>;
}

const FILE_NAME = "credentials.json";

function onWindows(context: ConfigContext): boolean {
  return (context.platform ?? process.platform) === "win32";
}

export function configDir(context: ConfigContext): string {
  const { env, home } = context;
  if (env.SKILLSGIST_CONFIG_DIR) return env.SKILLSGIST_CONFIG_DIR;
  if (onWindows(context)) return win32.join(env.APPDATA || win32.join(home, "AppData", "Roaming"), "skillsgist");
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, ".config"), "skillsgist");
}

export function credentialsPath(context: ConfigContext): string {
  return (onWindows(context) ? win32 : posix).join(configDir(context), FILE_NAME);
}

function broken(file: string, problem: string): CliError {
  return new CliError(`${file} ${problem}. Delete it and sign in again.`);
}

function isOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

function isLogin(value: unknown): value is HostLogin {
  const login = value as Partial<HostLogin> | null;
  return (
    login !== null &&
    typeof login === "object" &&
    typeof login.user === "string" &&
    typeof login.token === "string" &&
    isToken(login.token) &&
    typeof login.createdAt === "string" &&
    Array.isArray(login.projects) &&
    login.projects.every((project) => typeof project === "string")
  );
}

function tighten(file: string, context: ConfigContext): void {
  if (onWindows(context) || (statSync(file).mode & 0o077) === 0) return;
  try {
    chmodSync(file, 0o600);
    context.warn?.(`${file} was readable by other users; it is now readable only by you`);
  } catch {
    context.warn?.(`${file} is readable by other users. Run: chmod 600 ${file}`);
  }
}

export function readCredentials(context: ConfigContext): Credentials {
  const file = credentialsPath(context);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, hosts: {} };
    throw new CliError(`Could not read ${file}: ${errorMessage(err)}`);
  }
  tighten(file, context);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw broken(file, "is not valid JSON");
  }
  const record = (body !== null && typeof body === "object" ? body : {}) as { version?: unknown; hosts?: unknown };
  if (typeof record.version === "number" && record.version > 1) {
    throw new CliError(`${file} was written by a newer skillsgist. Upgrade skillsgist, or delete the file and sign in again.`);
  }
  if (record.version !== 1 || record.hosts === null || typeof record.hosts !== "object" || Array.isArray(record.hosts)) {
    throw broken(file, "is not a skillsgist credentials file");
  }
  const hosts: Record<string, HostLogin> = {};
  for (const [origin, login] of Object.entries(record.hosts)) {
    if (!isOrigin(origin) || !isLogin(login)) throw broken(file, "has an entry skillsgist cannot read");
    hosts[origin] = { user: login.user, projects: [...login.projects], token: login.token, createdAt: login.createdAt };
  }
  return { version: 1, hosts };
}

export function writeCredentials(context: ConfigContext, credentials: Credentials): void {
  const file = credentialsPath(context);
  if (Object.keys(credentials.hosts).length === 0) {
    rmSync(file, { force: true });
    return;
  }
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    mkdirSync(configDir(context), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } catch (err) {
    rmSync(temp, { force: true });
    throw new CliError(`Could not save ${file}: ${errorMessage(err)}`);
  }
}

export function getLogin(context: ConfigContext, origin: string): HostLogin | null {
  const { hosts } = readCredentials(context);
  return Object.hasOwn(hosts, origin) ? hosts[origin] : null;
}

export function saveLogin(context: ConfigContext, origin: string, login: HostLogin): void {
  const credentials = readCredentials(context);
  credentials.hosts[origin] = login;
  writeCredentials(context, credentials);
}

export function deleteLogin(context: ConfigContext, origin: string): boolean {
  const credentials = readCredentials(context);
  if (!Object.hasOwn(credentials.hosts, origin)) return false;
  delete credentials.hosts[origin];
  writeCredentials(context, credentials);
  return true;
}
