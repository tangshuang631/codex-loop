import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  confirmDevicePairing,
  createDevicePairingSession,
  readDevicePairingStatus,
  verifyPairedDevice,
} from "../app/server/lib/runtime-governance/device-pairing.mjs";

async function createWorkspace() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-loop-pairing-"));
  await fs.writeFile(
    path.join(tempRoot, "config.json"),
    `${JSON.stringify({ projectName: "pairing", currentRunId: "pairing-run" }, null, 2)}\n`,
    "utf8",
  );
  return tempRoot;
}

test("device pairing creates a scan session without storing the raw code", async () => {
  const configRoot = await createWorkspace();

  const session = await createDevicePairingSession(
    configRoot,
    {
      mobileBaseUrl: "http://100.64.0.10:3001",
    },
    {
      now: () => new Date("2026-06-09T07:00:00.000Z"),
      randomToken: () => "fixed-random",
    },
  );

  assert.equal(session.status, "waiting_scan");
  assert.match(session.pairingCode, /^[A-Z0-9-]+$/);
  assert.match(session.qrPayload, /codex-loop:\/\/pair/);
  assert.match(session.qrPayload, /sessionId=/);
  assert.match(session.qrPayload, /code=/);
  assert.match(session.nextAction, /手机|扫码|确认/);

  const stored = await fs.readFile(
    path.join(configRoot, "settings", "local", "device-pairing.json"),
    "utf8",
  );
  assert.doesNotMatch(stored, new RegExp(session.pairingCode));
  assert.match(stored, /"codeHash"/);
});

test("device pairing confirms a scan into a reusable long-term device token", async () => {
  const configRoot = await createWorkspace();
  const session = await createDevicePairingSession(
    configRoot,
    {
      mobileBaseUrl: "http://100.64.0.10:3001",
    },
    {
      now: () => new Date("2026-06-09T07:00:00.000Z"),
      randomToken: () => "first-random",
    },
  );

  const paired = await confirmDevicePairing(configRoot, {
    sessionId: session.sessionId,
    pairingCode: session.pairingCode,
    deviceName: "iPhone 15 Pro",
  }, {
    now: () => new Date("2026-06-09T07:01:00.000Z"),
    randomToken: () => "device-token-random",
  });

  assert.equal(paired.status, "paired");
  assert.equal(paired.device.name, "iPhone 15 Pro");
  assert.ok(paired.deviceToken);
  assert.doesNotMatch(paired.deviceToken, /fixed-random|first-random/);

  const statusAfterRestart = await readDevicePairingStatus(configRoot);
  assert.equal(statusAfterRestart.pairedDeviceCount, 1);
  assert.equal(statusAfterRestart.hasReusablePairing, true);
  assert.match(statusAfterRestart.summary, /已绑定|手机/);

  const verified = await verifyPairedDevice(configRoot, {
    deviceId: paired.device.id,
    deviceToken: paired.deviceToken,
  }, {
    now: () => new Date("2026-06-09T07:02:00.000Z"),
  });

  assert.equal(verified.valid, true);
  assert.equal(verified.device.name, "iPhone 15 Pro");
});

test("device pairing rejects expired or mismatched scan confirmations", async () => {
  const configRoot = await createWorkspace();
  const session = await createDevicePairingSession(
    configRoot,
    {},
    {
      now: () => new Date("2026-06-09T07:00:00.000Z"),
      randomToken: () => "expire-random",
    },
  );

  await assert.rejects(
    () =>
      confirmDevicePairing(configRoot, {
        sessionId: session.sessionId,
        pairingCode: "WRONG-CODE",
        deviceName: "iPhone",
      }, {
        now: () => new Date("2026-06-09T07:01:00.000Z"),
      }),
    /配对码不正确|重新扫码/,
  );

  await assert.rejects(
    () =>
      confirmDevicePairing(configRoot, {
        sessionId: session.sessionId,
        pairingCode: session.pairingCode,
        deviceName: "iPhone",
      }, {
        now: () => new Date("2026-06-09T07:30:00.000Z"),
      }),
    /已过期|重新扫码/,
  );
});
