import { spawn } from "node:child_process";

function safeText(value, fallback = "") {
  if (value === null || value === undefined) {
    return fallback;
  }
  const text = String(value).trim();
  return text || fallback;
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
} = {}) {
  const tailscaleInstalled = await existsCommand("tailscale", ["version"]);
  const cloudflaredInstalled = await existsCommand("cloudflared", ["--version"]);
  const publicBaseUrl = safeText(launcherStatus.webUrl, "");

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

  return {
    recommendedTransport,
    tailscaleInstalled,
    cloudflaredInstalled,
    remoteReady: Boolean(tailscaleInstalled || cloudflaredInstalled),
    publicBaseUrl,
    recommendedSteps,
  };
}
