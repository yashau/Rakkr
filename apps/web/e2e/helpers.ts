import type { APIRequestContext, Page } from "@playwright/test";

const authTokenKey = "rakkr.authToken";

const adminEmail = process.env.RAKKR_LOCAL_ADMIN_EMAIL ?? "admin@rakkr.local";
const adminPassword = process.env.RAKKR_LOCAL_ADMIN_PASSWORD ?? "rakkr-local-dev-password";

/**
 * Authenticate against the controller and seed the session token into
 * localStorage so the SPA boots straight into the authenticated shell,
 * skipping the login screen.
 */
export async function loginAndOpen(page: Page, request: APIRequestContext, path = "/") {
  const response = await request.post("/api/v1/auth/login", {
    data: { email: adminEmail, password: adminPassword },
  });

  if (!response.ok()) {
    throw new Error(`Login failed (${response.status()}): ${await response.text()}`);
  }

  const body = (await response.json()) as { data: { token: string } };

  // Establish the page origin before touching localStorage, seed the token,
  // then load the target route as an authenticated operator.
  await page.goto("/");
  await page.evaluate(([key, token]) => window.localStorage.setItem(key, token), [
    authTokenKey,
    body.data.token,
  ] as const);
  await page.goto(path);
}
