import test from "node:test";
import assert from "node:assert/strict";

import { readRemoteAccessStatus } from "../app/server/lib/remote-access.mjs";

test("remote access status exposes a copyable mobile entry and plain Chinese guidance", async () => {
  const status = await readRemoteAccessStatus({
    launcherStatus: {
      webUrl: "http://127.0.0.1:3001",
    },
    existsCommand: async (command) => command === "tailscale",
  });

  assert.equal(status.url, "http://127.0.0.1:3001");
  assert.equal(status.publicBaseUrl, "http://127.0.0.1:3001");
  assert.equal(status.remoteReady, true);
  assert.equal(status.isLocalOnly, true);
  assert.match(status.headline, /手机查看/);
  assert.match(status.summary, /Tailscale|手机/);
  assert.match(status.warning, /127\.0\.0\.1|本机地址|手机/);
  assert.ok(status.recommendedSteps.length >= 3);
  assert.ok(status.recommendedSteps.every((step) => !/[{}_]/.test(step)));
});

test("remote access status explains when the copied url is computer-only", async () => {
  const status = await readRemoteAccessStatus({
    launcherStatus: {
      host: "127.0.0.1",
      webPort: 3001,
      webUrl: "http://127.0.0.1:3001",
    },
    existsCommand: async () => false,
    networkInterfaces: () => ({}),
  });

  assert.equal(status.isLocalOnly, true);
  assert.equal(status.mobileReachable, false);
  assert.equal(status.url, "http://127.0.0.1:3001");
  assert.match(status.statusText, /手机暂时不能直接打开/);
  assert.match(status.nextAction, /Tailscale|局域网 IP/);
  assert.match(status.mobileUrlHint, /http:\/\/这台电脑的.*:3001/);
  assert.doesNotMatch(status.statusText, /[{}_]/);
  assert.doesNotMatch(status.nextAction, /[{}_]/);
});

test("remote access status marks non-local dashboard url as phone-ready", async () => {
  const status = await readRemoteAccessStatus({
    launcherStatus: {
      host: "100.64.0.10",
      webPort: 3001,
      webUrl: "http://100.64.0.10:3001",
    },
    existsCommand: async (command) => command === "tailscale",
  });

  assert.equal(status.isLocalOnly, false);
  assert.equal(status.mobileReachable, true);
  assert.equal(status.url, "http://100.64.0.10:3001");
  assert.match(status.statusText, /手机可以打开|可用/);
  assert.match(status.nextAction, /手机浏览器/);
});

test("remote access status suggests phone-ready urls from local network interfaces", async () => {
  const status = await readRemoteAccessStatus({
    launcherStatus: {
      host: "127.0.0.1",
      webPort: 3001,
      webUrl: "http://127.0.0.1:3001",
    },
    existsCommand: async (command) => command === "tailscale",
    networkInterfaces: () => ({
      "Tailscale": [
        { address: "100.101.102.103", family: "IPv4", internal: false },
      ],
      "Wi-Fi": [
        { address: "192.168.31.25", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
      "Loopback": [
        { address: "127.0.0.1", family: "IPv4", internal: true },
      ],
    }),
  });

  assert.equal(status.mobileReachable, false);
  assert.equal(status.primaryMobileUrl, "http://100.101.102.103:3001");
  assert.equal(status.candidateUrls.length, 2);
  assert.deepEqual(
    status.candidateUrls.map((candidate) => candidate.url),
    ["http://100.101.102.103:3001", "http://192.168.31.25:3001"],
  );
  assert.match(status.candidateUrls[0].label, /Tailscale/);
  assert.match(status.candidateUrls[1].label, /局域网|Wi-Fi/);
  assert.match(status.nextAction, /优先.*Tailscale|手机浏览器/);
});

test("remote access status hides low-value virtual adapter urls by default", async () => {
  const status = await readRemoteAccessStatus({
    launcherStatus: {
      host: "127.0.0.1",
      webPort: 3001,
      webUrl: "http://127.0.0.1:3001",
    },
    existsCommand: async () => false,
    networkInterfaces: () => ({
      "以太网": [
        { address: "172.30.202.40", family: "IPv4", internal: false },
      ],
      "VMware Network Adapter VMnet8": [
        { address: "192.168.10.1", family: "IPv4", internal: false },
      ],
      "vEthernet (WSL)": [
        { address: "172.29.128.1", family: "IPv4", internal: false },
      ],
      "DockerNAT": [
        { address: "10.0.75.1", family: "IPv4", internal: false },
      ],
      "本地连接* 2": [
        { address: "192.168.137.1", family: "IPv4", internal: false },
      ],
    }),
  });

  assert.deepEqual(
    status.candidateUrls.map((candidate) => candidate.url),
    ["http://172.30.202.40:3001"],
  );
  assert.equal(status.primaryMobileUrl, "http://172.30.202.40:3001");
  assert.doesNotMatch(
    status.candidateUrls.map((candidate) => candidate.label).join("\n"),
    /VMware|WSL|Docker|本地连接\*/,
  );
});
