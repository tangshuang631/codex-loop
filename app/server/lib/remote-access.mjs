import { spawn } from "node:child_process";
import os from "node:os";

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
}

function isLocalOnlyUrl(value) {
  const text = safeText(value, "");
  return /\/\/(127\.0\.0\.1|localhost|\[::1\]|::1)(:\d+)?/i.test(text);
}

function normalizePort(value, fallback = 3001) {
  const port = Number(value);
  return Number.isFinite(port) && port > 0 ? port : fallback;
}

function isTailscaleAddress(address) {
  return /^100\./.test(safeText(address, ""));
}

function isPrivateLanAddress(address) {
  const text = safeText(address, "");
  return (
    /^10\./.test(text) ||
    /^192\.168\./.test(text) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(text)
  );
}

function isLowValueAdapterName(name) {
  const text = safeText(name, "").toLowerCase();
  return (
    /vmware|virtualbox|vbox|docker|wsl|vethernet|hyper-v|npcap|loopback|bluetooth|tap-|tun-|本地连接\*/i.test(text)
  );
}

function buildCandidateUrls({ webPort, networkInterfaces = os.networkInterfaces } = {}) {
  const interfaces = networkInterfaces() || {};
  const candidates = [];
  const seen = new Set();

  for (const [name, addresses] of Object.entries(interfaces)) {
    if (isLowValueAdapterName(name)) {
      continue;
    }

    for (const addressInfo of addresses || []) {
      if (!addressInfo || addressInfo.internal || addressInfo.family !== "IPv4") {
        continue;
      }

      const address = safeText(addressInfo.address, "");
      if (!address || address === "127.0.0.1" || seen.has(address)) {
        continue;
      }

      const tailscale = isTailscaleAddress(address) || /tailscale/i.test(name);
      const lan = isPrivateLanAddress(address);
      if (!tailscale && !lan) {
        continue;
      }

      seen.add(address);
      candidates.push({
        url: `http://${address}:${webPort}`,
        label: tailscale ? "Tailscale 地址" : `${name || "局域网"} 局域网地址`,
        transport: tailscale ? "tailscale" : "lan",
        address,
      });
    }
  }

  return candidates.sort((a, b) => {
    if (a.transport === b.transport) {
      return a.url.localeCompare(b.url);
    }
    return a.transport === "tailscale" ? -1 : 1;
  });
}

async function commandExists(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

export async function readRemoteAccessStatus({
  launcherStatus = {},
  existsCommand = commandExists,
  networkInterfaces = os.networkInterfaces,
} = {}) {
  const tailscaleInstalled = await existsCommand("tailscale", ["version"]);
  const cloudflaredInstalled = await existsCommand("cloudflared", ["--version"]);
  const publicBaseUrl = safeText(launcherStatus.webUrl, "");
  const isLocalOnly = isLocalOnlyUrl(publicBaseUrl);
  const mobileReachable = Boolean(publicBaseUrl && !isLocalOnly);
  const webPort = normalizePort(launcherStatus.webPort, 3001);
  const candidateUrls = buildCandidateUrls({ webPort, networkInterfaces });
  const primaryMobileUrl = mobileReachable
    ? publicBaseUrl
    : candidateUrls[0]?.url || "";
  const mobileUrlHint = isLocalOnly
    ? primaryMobileUrl || `http://这台电脑的 Tailscale 地址或局域网 IP:${webPort}`
    : publicBaseUrl;

  const recommendedTransport = tailscaleInstalled
    ? "tailscale"
    : cloudflaredInstalled
      ? "cloudflared"
      : "tailscale";

  const recommendedSteps = tailscaleInstalled
    ? [
        "在这台机器登录 Tailscale。",
        "把 codex-loop 前端端口通过 Tailnet 暴露给你的手机。",
        "手机安装 Tailscale 后直接访问这台设备上的 codex-loop 地址。",
      ]
    : cloudflaredInstalled
      ? [
          "使用 cloudflared 为本机 codex-loop 建一个临时或固定隧道。",
          "把生成的地址保存到手机浏览器。",
          "通过 codex-loop 页面直接执行开始、停止、查看记录等基础操作。",
        ]
      : [
          "优先安装 Tailscale，这是最简单、最稳的跨网络手机访问方案。",
          "安装后把本机 codex-loop 地址加入 Tailnet 访问。",
          "这样不需要自建云服务器，也能在外网安全访问本机进程。",
        ];

  const headline = "手机查看 codex-loop";
  const summary = tailscaleInstalled
    ? "已检测到 Tailscale。手机接入同一个 Tailnet 后，就可以用这台电脑的 Tailscale 地址查看当前 loop。"
    : cloudflaredInstalled
      ? "已检测到 cloudflared。可以创建隧道，把 codex-loop 页面临时暴露给手机查看。"
      : "建议安装 Tailscale。它是最简单、最稳的手机远程查看方案。";
  const warning = isLocalOnly
    ? "当前地址是本机地址，手机不能直接打开。请换成这台电脑的 Tailscale 地址或同一局域网 IP。"
    : "";
  const statusText = mobileReachable
    ? "手机可以打开这个地址。"
    : "手机暂时不能直接打开当前地址。";
  const nextAction = mobileReachable
    ? "用手机浏览器打开上面的地址，就能查看 codex-loop 进程。"
    : primaryMobileUrl
      ? "优先用推荐的 Tailscale 地址在手机浏览器打开；不通时再试局域网地址。"
      : "请先使用 Tailscale 地址或局域网 IP，再用手机打开。";

  return {
    headline,
    summary,
    warning,
    statusText,
    nextAction,
    mobileReachable,
    mobileUrlHint,
    primaryMobileUrl,
    candidateUrls,
    recommendedTransport,
    tailscaleInstalled,
    cloudflaredInstalled,
    remoteReady: Boolean(tailscaleInstalled || cloudflaredInstalled),
    isLocalOnly,
    url: publicBaseUrl,
    publicBaseUrl,
    recommendedSteps,
  };
}
