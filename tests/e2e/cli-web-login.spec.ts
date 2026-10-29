import { expect, test } from "@playwright/test";
import { disposeCliWebRuntime, startCliWebServer, type CliWebRuntime } from "./cli-web-runtime";

const cliWebAuthToken = "playwright-cli-web-login-token";
const cliWebLoginPassword = "playwright login password";

let runtime: CliWebRuntime | undefined;

test.beforeAll(async () => {
  runtime = await startCliWebServer(cliWebAuthToken, cliWebLoginPassword);
});

test.afterAll(async () => {
  if (!runtime) {
    return;
  }
  await disposeCliWebRuntime(runtime);
  runtime = undefined;
});

test("redirects unauthenticated visits to the login page", async ({ page }) => {
  const current = requireRuntime();

  await page.goto(current.baseUrl);
  await expect(page).toHaveURL(/\/pages\/login\/index\.html$/);
  await expect(page.locator("#password")).toBeVisible();
  // The console shell must not be reachable before signing in.
  await expect(page.locator("#root")).toHaveCount(0);
});

test("never places a credential in the URL", async ({ page }) => {
  const current = requireRuntime();

  await page.goto(current.baseUrl);
  await expect(page).toHaveURL(/\/pages\/login\/index\.html$/);
  expect(page.url()).not.toContain("ccr_web_token");

  await page.goto(`${current.baseUrl}/pages/login/index.html`);
  await expect(page.locator("#password")).toBeVisible();
  expect(page.url()).not.toContain("ccr_web_token");
});

test("rejects a wrong password without issuing a session", async ({ request }) => {
  const current = requireRuntime();

  const response = await request.post(`${current.baseUrl}/api/ccr/login`, {
    data: { password: "definitely-not-the-password" }
  });

  expect(response.status()).toBe(401);
  expect((await response.json()).ok).toBe(false);
  expect(response.headers()["set-cookie"]).toBeUndefined();
});

test("signs in with the configured password and serves the console", async ({ page }) => {
  const current = requireRuntime();

  await page.goto(current.baseUrl);
  await expect(page).toHaveURL(/\/pages\/login\/index\.html$/);
  await page.fill("#password", cliWebLoginPassword);
  await page.click("#submit");

  await expect(page).toHaveTitle("Helix Router", { timeout: 15_000 });
  await expect(page.locator("#root")).toBeAttached();
  expect(page.url()).not.toContain("ccr_web_token");

  const cookies = await page.context().cookies();
  const session = cookies.find((cookie) => cookie.name === "ccr_web_session");
  expect(session, "sign-in must set the session cookie").toBeTruthy();
  expect(session?.httpOnly).toBe(true);
});

test("reports authentication state without leaking credentials", async ({ request }) => {
  const current = requireRuntime();

  const anonymous = await request.get(`${current.baseUrl}/api/ccr/auth-status`);
  expect(anonymous.status()).toBe(200);
  expect(await anonymous.json()).toEqual({ authenticated: false, loginRequired: true, ok: true });

  const tokenized = await request.get(`${current.baseUrl}/api/ccr/auth-status`, {
    headers: { "x-ccr-web-auth": current.token }
  });
  expect(await tokenized.json()).toEqual({ authenticated: true, loginRequired: true, ok: true });
});

test("keeps the token header working for non-browser callers", async ({ request }) => {
  const current = requireRuntime();

  const response = await request.post(`${current.baseUrl}/api/ccr/rpc`, {
    data: { args: [], method: "getAppInfo" },
    headers: { "x-ccr-web-auth": current.token }
  });
  const payload = await response.json();

  expect(response.status()).toBe(200);
  expect(payload.ok).toBe(true);
  expect(payload.value.name).toBe("Helix Router");
});

test("logs out and re-locks the console", async ({ page }) => {
  const current = requireRuntime();

  await page.goto(current.baseUrl);
  await page.fill("#password", cliWebLoginPassword);
  await page.click("#submit");
  await expect(page).toHaveTitle("Helix Router", { timeout: 15_000 });

  const logout = await page.request.post(`${current.baseUrl}/api/ccr/logout`);
  expect(logout.status()).toBe(200);

  await page.goto(current.baseUrl);
  await expect(page).toHaveURL(/\/pages\/login\/index\.html$/);
});

function requireRuntime(): CliWebRuntime {
  if (!runtime) {
    throw new Error("CLI web runtime was not started.");
  }
  return runtime;
}
