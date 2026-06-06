import test from "node:test";
import assert from "node:assert/strict";

import { findAvailablePortPair } from "../app/server/lib/network.mjs";

test("findAvailablePortPair keeps api and web ports aligned when defaults are free", async () => {
  const ports = await findAvailablePortPair("127.0.0.1", {
    apiPreferredPort: 3000,
    webPreferredPort: 3001,
    attempts: 5,
    canListen: async (_host, port) => port === 3000 || port === 3001,
  });

  assert.deepEqual(ports, {
    apiPort: 3000,
    webPort: 3001,
  });
});

test("findAvailablePortPair shifts both ports together when one default port is unavailable", async () => {
  const ports = await findAvailablePortPair("127.0.0.1", {
    apiPreferredPort: 3000,
    webPreferredPort: 3001,
    attempts: 5,
    canListen: async (_host, port) => port === 3002 || port === 3003,
  });

  assert.deepEqual(ports, {
    apiPort: 3002,
    webPort: 3003,
  });
});

test("findAvailablePortPair throws when no aligned pair is available", async () => {
  await assert.rejects(
    () =>
      findAvailablePortPair("127.0.0.1", {
        apiPreferredPort: 3000,
        webPreferredPort: 3001,
        attempts: 2,
        canListen: async () => false,
      }),
    /Could not find an available local port pair/i,
  );
});
