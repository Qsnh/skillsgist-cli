import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AuthError } from "../src/http.js";
import { discover, pollForToken, requestDeviceCode, revokeToken, whoami } from "../src/oauth.js";
import { installFakeAuth, type FakeAuthOptions } from "./helpers/oauth.js";
import { LOGIN_TOKEN, startRegistry, type TestRegistry } from "./helpers/registry.js";

let registry: TestRegistry;

beforeAll(async () => {
  registry = await startRegistry();
});

afterAll(() => registry.close());

beforeEach(() => {
  registry.routes.clear();
  registry.log.length = 0;
});

async function failure(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected a failure");
}

function fastClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    options: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms);
        now += ms;
      },
    },
  };
}

async function started(options: FakeAuthOptions = {}) {
  const auth = installFakeAuth(registry, options);
  const meta = await discover(registry.origin);
  const device = await requestDeviceCode(meta, { projects: ["team"], deviceName: "laptop" });
  return { auth, meta, device };
}

const host = () => new URL(registry.origin).host;

describe("discover", () => {
  it("reads the endpoints of this registry", async () => {
    installFakeAuth(registry);
    expect(await discover(registry.origin)).toEqual({
      origin: registry.origin,
      deviceEndpoint: `${registry.origin}/api/oauth/device`,
      tokenEndpoint: `${registry.origin}/api/oauth/token`,
      revocationEndpoint: `${registry.origin}/api/oauth/revoke`,
    });
  });

  it("says the registry cannot sign in yet when it has no metadata", async () => {
    expect(await failure(discover(registry.origin))).toBe(`${host()} does not support signing in yet. Ask its admin to upgrade skillsgist.`);
  });

  it.each([
    [{ issuer: "https://evil.example" }, "sent sign-in settings for another server"],
    [{ token_endpoint: "https://evil.example/api/oauth/token" }, "sent invalid sign-in settings"],
    [{ device_authorization_endpoint: undefined }, "sent invalid sign-in settings"],
    [{ grant_types_supported: ["authorization_code"] }, "does not support signing in from a terminal"],
  ])("refuses metadata with %j", async (metadata, message) => {
    installFakeAuth(registry, { metadata });
    expect(await failure(discover(registry.origin))).toBe(`${host()} ${message}`);
  });
});

describe("requestDeviceCode", () => {
  it("asks with the client id, the device name and the projects to pre-tick, as a form", async () => {
    const { auth, device } = await started();
    expect(Object.fromEntries(auth.deviceRequests[0])).toEqual({ client_id: "skillsgist-cli", device_name: "laptop", scope: "project:team" });
    expect(registry.log.find((entry) => entry.path === "/api/oauth/device")?.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(device).toEqual({
      deviceCode: "device-code-1",
      userCode: "BCDF-GHJK",
      verificationUri: `${registry.origin}/device`,
      verificationUriComplete: `${registry.origin}/device?code=BCDF-GHJK`,
      expiresIn: 600,
      interval: 0,
    });
  });

  it("leaves out the scope when there is nothing to pre-tick", async () => {
    const auth = installFakeAuth(registry);
    await requestDeviceCode(await discover(registry.origin), { projects: [], deviceName: "laptop" });
    expect(auth.deviceRequests[0].has("scope")).toBe(false);
  });

  it.each([[{ user_code: "\u001b[2JBCDF" }], [{ verification_uri: "https://evil.example/device" }], [{ expires_in: 0 }], [{ device_code: "" }]])(
    "refuses a device answer with %j",
    async (device) => {
      installFakeAuth(registry, { device });
      expect(await failure(requestDeviceCode(await discover(registry.origin), { projects: [], deviceName: "laptop" }))).toBe(
        `${host()} sent an invalid sign-in code`,
      );
    },
  );

  it("drops a pre-filled link to another server", async () => {
    installFakeAuth(registry, { device: { verification_uri_complete: "https://evil.example/device?code=BCDF-GHJK" } });
    const device = await requestDeviceCode(await discover(registry.origin), { projects: [], deviceName: "laptop" });
    expect(device.verificationUriComplete).toBeNull();
  });
});

describe("pollForToken", () => {
  it("waits while approval is pending, then returns the token and the granted projects", async () => {
    const { meta, device } = await started({ pendingPolls: 2, interval: 1, projects: ["team", "docs"] });
    const clock = fastClock();
    expect(await pollForToken(meta, device, clock.options)).toEqual({ token: LOGIN_TOKEN, projects: ["team", "docs"] });
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
  });

  it("never polls faster than once a second, even if the registry asks for interval 0", async () => {
    const { meta, device } = await started({ pendingPolls: 2 });
    const clock = fastClock();
    expect(await pollForToken(meta, device, clock.options)).toEqual({ token: LOGIN_TOKEN, projects: ["team"] });
    expect(clock.sleeps).toEqual([1000, 1000, 1000]);
  });

  it("caps the deadline so a huge expires_in cannot poll forever", async () => {
    const { auth, meta, device } = await started({ expiresIn: 1e9, pendingPolls: 100000, interval: 600 });
    expect(await failure(pollForToken(meta, device, fastClock().options))).toBe("The sign-in code expired. Run skillsgist login again.");
    expect(auth.tokenPolls).toBe(2);
  });

  it("waits five seconds longer each time it is told to slow down", async () => {
    const { meta, device } = await started({ pendingPolls: 2, slowDownOnPoll: 1, interval: 1 });
    const clock = fastClock();
    await pollForToken(meta, device, clock.options);
    expect(clock.sleeps).toEqual([1000, 6000, 6000]);
  });

  it.each([
    ["deny", "Sign-in was denied in the browser"],
    ["expire", "The sign-in code expired. Run skillsgist login again."],
    ["invalid_client", `refused the sign-in: invalid_client`],
  ] as const)("stops when the registry answers %s", async (outcome, message) => {
    const { meta, device } = await started({ outcome });
    expect(await failure(pollForToken(meta, device, fastClock().options))).toContain(message);
  });

  it("gives up once the code has expired, without asking again", async () => {
    const { auth, meta, device } = await started({ pendingPolls: 1000, interval: 5, expiresIn: 12 });
    expect(await failure(pollForToken(meta, device, fastClock().options))).toBe("The sign-in code expired. Run skillsgist login again.");
    expect(auth.tokenPolls).toBe(2);
  });

  it("reports a registry that stops answering", async () => {
    const { meta, device } = await started();
    const closed = await startRegistry();
    await closed.close();
    const gone = { ...meta, tokenEndpoint: `${closed.origin}/api/oauth/token` };
    expect(await failure(pollForToken(gone, device, fastClock().options))).toMatch(/^Could not reach /);
  });

  it.each([[{ token_type: "mac" }], [{ access_token: "has space" }]])("refuses a token answer with %j", async (tokenAnswer) => {
    const { meta, device } = await started({ tokenAnswer });
    expect(await failure(pollForToken(meta, device, fastClock().options))).toBe(`${host()} sent an invalid sign-in token`);
  });
});

describe("revokeToken", () => {
  it("posts the token to the revocation endpoint", async () => {
    const auth = installFakeAuth(registry);
    await revokeToken(await discover(registry.origin), LOGIN_TOKEN);
    expect(auth.revoked).toEqual([LOGIN_TOKEN]);
  });

  it("fails when the registry cannot revoke", async () => {
    installFakeAuth(registry, { metadata: { revocation_endpoint: undefined } });
    expect(await failure(revokeToken(await discover(registry.origin), LOGIN_TOKEN))).toBe(`${host()} does not support signing out`);
  });

  it("fails when the revocation endpoint errors", async () => {
    installFakeAuth(registry, { revokeStatus: 500 });
    expect(await failure(revokeToken(await discover(registry.origin), LOGIN_TOKEN))).toContain("answered HTTP 500");
  });
});

describe("whoami", () => {
  it("says whom a token belongs to", async () => {
    const { meta, device } = await started({ projects: ["team"] });
    const { token } = await pollForToken(meta, device, fastClock().options);
    expect(await whoami(registry.origin, token)).toEqual({ user: "alice", kind: "login", projects: ["team"] });
    expect(registry.log.at(-1)?.headers.authorization).toBe(`Bearer ${LOGIN_TOKEN}`);
  });

  it("throws an AuthError for a token the registry does not know", async () => {
    installFakeAuth(registry);
    const err = await whoami(registry.origin, "sgd_unknown0000000000").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as AuthError).status).toBe(401);
  });
});
