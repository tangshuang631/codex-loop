import net from "node:net";

export function normalizePort(value, fallback = 4318) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback;
  }

  return Math.trunc(numeric);
}

export async function findAvailablePort(host, preferredPort, attempts = 10) {
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = preferredPort + offset;
    const available = await canListen(host, port);
    if (available) {
      return port;
    }
  }

  throw new Error(
    `Could not find an available local port starting at ${preferredPort} on ${host}.`,
  );
}

function canListen(host, port) {
  return new Promise((resolve) => {
    const probe = net.createServer();

    probe.once("error", () => {
      resolve(false);
    });

    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });

    probe.listen(port, host);
  });
}
