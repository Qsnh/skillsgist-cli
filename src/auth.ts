import { getLogin, type ConfigContext } from "./credentials.js";
import { bearer, isToken } from "./http.js";
import { LOOPBACK_HOSTS, registerSecret } from "./source.js";

export type Credential = { kind: "none" } | { kind: "env" | "login"; token: string };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

export function hostOrigin(value: string): string | null {
  const text = value.trim();
  if (text === "") return null;
  let url: URL;
  try {
    url = new URL(HAS_SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) return url.origin;
  return null;
}

export function envCredential(origin: string, context: ConfigContext): Credential {
  const key = context.env.SKILLSGIST_INSTALL_KEY?.trim() ?? "";
  if (key === "") return { kind: "none" };
  const skip = (why: string): Credential => {
    context.warn?.(`${why}; not sending SKILLSGIST_INSTALL_KEY`);
    return { kind: "none" };
  };
  if (key.includes("://")) {
    return skip("SKILLSGIST_INSTALL_KEY holds an address, not an install key (are SKILLSGIST_HOST and SKILLSGIST_INSTALL_KEY swapped?)");
  }
  registerSecret(key);
  if (key.startsWith("sgt_")) return skip("SKILLSGIST_INSTALL_KEY holds a publish API token, not an install key");
  if (key.startsWith("sgd_")) return skip("SKILLSGIST_INSTALL_KEY holds a sign-in token, not an install key (use skillsgist login instead)");
  if (!isToken(key)) return skip("SKILLSGIST_INSTALL_KEY has spaces or characters a header cannot carry, or is too long");
  const host = context.env.SKILLSGIST_HOST?.trim() ?? "";
  if (host === "") return skip("SKILLSGIST_HOST is not set, so the install key is not bound to any registry");
  const bound = hostOrigin(host);
  if (bound === null) return skip("SKILLSGIST_HOST is not an https address");
  if (bound !== origin) return skip(`SKILLSGIST_HOST does not name ${origin}`);
  return { kind: "env", token: key };
}

export function resolveCredential(origin: string, context: ConfigContext): Credential {
  const env = envCredential(origin, context);
  if (env.kind !== "none") return env;
  const login = getLogin(context, origin);
  if (login === null) return { kind: "none" };
  registerSecret(login.token);
  return { kind: "login", token: login.token };
}

export function authHeaders(credential: Credential): Record<string, string> {
  return credential.kind === "none" ? {} : bearer(credential.token);
}
