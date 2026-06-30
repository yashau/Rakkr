import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  secretKeyRequired,
} from "../src/secret-box.js";
import { decryptPrivateKey, encryptPrivateKey } from "../src/node-ssh-credential-crypto.js";

const KEYS = [
  "NODE_ENV",
  "RAKKR_REQUIRE_SECRET_KEY",
  "RAKKR_SECRET_KEY",
  "RAKKR_NODE_SSH_MASTER_KEY",
] as const;

function withEnv(overrides: Record<string, string | undefined>, run: () => void) {
  const saved = new Map(KEYS.map((key) => [key, process.env[key]]));

  try {
    for (const key of KEYS) {
      delete process.env[key];
    }

    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }

    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("secretKeyRequired tracks production and the explicit override", () => {
  withEnv({ NODE_ENV: "production" }, () => assert.equal(secretKeyRequired(), true));
  withEnv({ NODE_ENV: "development" }, () => assert.equal(secretKeyRequired(), false));
  withEnv({}, () => assert.equal(secretKeyRequired(), false));
  withEnv({ RAKKR_REQUIRE_SECRET_KEY: "1" }, () => assert.equal(secretKeyRequired(), true));
  withEnv({ NODE_ENV: "production", RAKKR_REQUIRE_SECRET_KEY: "0" }, () =>
    assert.equal(secretKeyRequired(), false),
  );
});

test("upload-secret encryption refuses the dev fallback key in production", () => {
  withEnv({ RAKKR_REQUIRE_SECRET_KEY: "1" }, () => {
    assert.throws(() => encryptSecret("smb-password"), /not set; refusing to use the insecure/u);
  });
  withEnv({ RAKKR_REQUIRE_SECRET_KEY: "1", RAKKR_SECRET_KEY: "too-short" }, () => {
    assert.throws(() => encryptSecret("smb-password"), /too short/u);
  });
});

test("upload-secret encryption round-trips with a strong production key", () => {
  withEnv(
    { RAKKR_REQUIRE_SECRET_KEY: "1", RAKKR_SECRET_KEY: "a-strong-32-byte-production-key!!" },
    () => {
      const sealed = encryptSecret("smb-password");

      assert.equal(isEncryptedSecret(sealed), true);
      assert.equal(decryptSecret(sealed), "smb-password");
    },
  );
});

test("upload-secret encryption still works with the dev fallback outside production", () => {
  withEnv({}, () => {
    const sealed = encryptSecret("smb-password");

    assert.equal(decryptSecret(sealed), "smb-password");
  });
});

test("SSH private-key encryption refuses the dev fallback master key in production", () => {
  withEnv({ RAKKR_REQUIRE_SECRET_KEY: "1" }, () => {
    assert.throws(
      () => encryptPrivateKey("-----BEGIN KEY-----"),
      /not set; refusing to use the insecure/u,
    );
  });
});

test("SSH private-key encryption round-trips with a strong production master key", () => {
  withEnv(
    {
      RAKKR_REQUIRE_SECRET_KEY: "1",
      RAKKR_NODE_SSH_MASTER_KEY: "a-strong-ssh-master-key-32bytes!",
    },
    () => {
      const sealed = encryptPrivateKey("-----BEGIN KEY-----");

      assert.equal(decryptPrivateKey(sealed), "-----BEGIN KEY-----");
    },
  );
});
