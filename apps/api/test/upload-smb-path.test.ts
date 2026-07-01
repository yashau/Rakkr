import assert from "node:assert/strict";
import test from "node:test";
import { smbPathSegments } from "../src/upload-smb.js";

test("smb path segments drop traversal so a pathOverride cannot escape the share", () => {
  const segments = smbPathSegments("recordings", "meetings", "../../escape", "clip.mp3");

  // Pre-fix the `..` segments were kept verbatim, letting the remote path climb
  // above share/path on the SMB server.
  assert.deepEqual(segments, ["recordings", "meetings", "escape", "clip.mp3"]);
  assert.ok(!segments.includes(".."));
  assert.ok(!segments.includes("."));
});

test("smb path segments keep normal subfolders and the filename", () => {
  assert.deepEqual(smbPathSegments("recordings", "2026", "council", "clip.mp3"), [
    "recordings",
    "2026",
    "council",
    "clip.mp3",
  ]);
});
