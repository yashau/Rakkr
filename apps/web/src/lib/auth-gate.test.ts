import assert from "node:assert/strict";
import test from "node:test";
import { ApiError } from "./api-error";
import { authGateState } from "./auth-gate";

test("no token is unauthenticated", () => {
  assert.equal(
    authGateState({ error: null, hasToken: false, isError: false, isPending: false }),
    "unauthenticated",
  );
});

test("a 401/403 invalidates the session (re-login)", () => {
  for (const status of [401, 403]) {
    assert.equal(
      authGateState({
        error: new ApiError(status),
        hasToken: true,
        isError: true,
        isPending: false,
      }),
      "unauthenticated",
    );
  }
});

test("a transient 5xx / network error keeps the session and shows a retry state", () => {
  // Pre-fix: any error forced re-login (and left a stale token). A 503 or a
  // bare network Error must NOT be treated as unauthenticated.
  assert.equal(
    authGateState({
      error: new ApiError(503),
      hasToken: true,
      isError: true,
      isPending: false,
    }),
    "session-error",
  );
  assert.equal(
    authGateState({
      error: new Error("network down"),
      hasToken: true,
      isError: true,
      isPending: false,
    }),
    "session-error",
  );
});

test("pending and success states resolve correctly", () => {
  assert.equal(
    authGateState({ error: null, hasToken: true, isError: false, isPending: true }),
    "loading",
  );
  assert.equal(
    authGateState({ error: null, hasToken: true, isError: false, isPending: false }),
    "authed",
  );
});
