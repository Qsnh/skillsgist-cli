import { CliError } from "./errors.js";
import { redact } from "./source.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_ERROR_BODY_BYTES = 64 * 1024;

export interface FetchOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

export interface Watchdog {
  signal: AbortSignal;
  reset(): void;
  stop(): void;
}

export interface Reply {
  res: Response;
  watchdog: Watchdog;
}

export interface RequestInit {
  method?: "GET" | "POST";
  form?: Record<string, string>;
}

export class AuthError extends CliError {
  constructor(
    readonly status: number,
    readonly code: string | null,
    readonly project: string | null,
    url: string,
  ) {
    super(`${redact(url)} answered HTTP ${status}`);
    this.name = "AuthError";
  }
}

function reason(err: unknown): string {
  if (err instanceof Error && err.name === "TimeoutError") return "timed out";
  const cause = err instanceof Error ? (err.cause as { code?: string; message?: string } | undefined) : undefined;
  return cause?.code ?? cause?.message ?? (err instanceof Error ? err.message : String(err));
}

function watchdog(ms: number): Watchdog {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms).unref();
  };
  reset();
  return { signal: controller.signal, reset, stop: () => clearTimeout(timer) };
}

export async function request(url: string, options: FetchOptions, init: RequestInit = {}): Promise<Reply> {
  const dog = watchdog(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([dog.signal, options.signal]) : dog.signal;
  const body = init.form === undefined ? undefined : new URLSearchParams(init.form);
  try {
    const res = await fetch(url, { method: init.method ?? "GET", headers: { ...options.headers }, body, redirect: "error", signal });
    dog.reset();
    return { res, watchdog: dog };
  } catch (err) {
    dog.stop();
    throw new CliError(`Could not reach ${redact(url)}: ${redact(reason(err))}`);
  }
}

export async function discard({ res, watchdog }: Reply): Promise<void> {
  watchdog.stop();
  await res.body?.cancel();
}

export async function readCapped({ res, watchdog }: Reply, limit: number, label: string, failure: string): Promise<Uint8Array> {
  try {
    if (Number(res.headers.get("content-length") ?? 0) > limit) {
      await res.body?.cancel();
      throw new CliError(`${label} is larger than ${limit} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (res.body) {
      for await (const chunk of res.body) {
        watchdog.reset();
        total += chunk.length;
        if (total > limit) throw new CliError(`${label} is larger than ${limit} bytes`);
        chunks.push(chunk);
      }
    }
    return Buffer.concat(chunks, total);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(`${failure}: ${redact(reason(err))}`);
  } finally {
    watchdog.stop();
  }
}

export async function readJson(reply: Reply, limit: number, label: string): Promise<unknown> {
  const bytes = await readCapped(reply, limit, label, `Could not reach ${label}`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CliError(`${label} is not valid JSON`);
  }
}

export async function authFailure(reply: Reply, url: string): Promise<AuthError> {
  let body: unknown = null;
  try {
    body = await readJson(reply, MAX_ERROR_BODY_BYTES, redact(url));
  } catch {
    // The reason in the body is optional.
  }
  const record = (body !== null && typeof body === "object" ? body : {}) as { error?: unknown; project?: unknown };
  return new AuthError(
    reply.res.status,
    typeof record.error === "string" ? record.error : null,
    typeof record.project === "string" ? record.project : null,
    url,
  );
}
