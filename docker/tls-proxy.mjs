import { readFile } from "node:fs/promises";
import net from "node:net";
import tls from "node:tls";
import { pathToFileURL } from "node:url";

/** Encrypt the upstream daemon's loopback-only TCP listener without modifying Paseo.
 * Streams use Node backpressure; peers cannot choose the fixed local destination.
 */
export async function startTlsProxy({
  cert,
  key,
  port = 6768,
  backendPort = 6767,
  host = "0.0.0.0",
}) {
  const sockets = new Set();
  const server = tls.createServer(
    { cert, key, minVersion: "TLSv1.2", handshakeTimeout: 10000 },
    (client) => {
      const backend = net.connect({ host: "127.0.0.1", port: backendPort });
      sockets.add(backend);
      const close = () => {
        client.destroy();
        backend.destroy();
      };
      backend.setTimeout(10000, close);
      backend.once("connect", () => {
        backend.setTimeout(0);
        client.pipe(backend);
        backend.pipe(client);
      });
      client.once("error", close);
      backend.once("error", close);
      client.once("close", close);
      backend.once("close", () => {
        sockets.delete(backend);
        client.destroy();
      });
    },
  );
  server.maxConnections = 128;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
  });
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(resolve);
      }),
  };
}

async function main() {
  if (process.argv[2] === "probe") {
    const socket = net.connect({ host: "127.0.0.1", port: 6767 });
    socket.setTimeout(2000);
    socket.once("connect", () => socket.end());
    socket.once("timeout", () => {
      process.exitCode = 1;
      socket.destroy();
    });
    socket.once("error", () => {
      process.exitCode = 1;
      socket.destroy();
    });
    return;
  }
  const proxy = await startTlsProxy({
    cert: await readFile("/run/paseo-tls/tls.crt"),
    key: await readFile("/run/paseo-tls/tls.key"),
  });
  // Projected Secret volumes update atomically. Keep the previous valid context if a
  // partial/invalid certificate update arrives; new connections use the next valid pair.
  const timer = setInterval(async () => {
    try {
      const [cert, key] = await Promise.all([
        readFile("/run/paseo-tls/tls.crt"),
        readFile("/run/paseo-tls/tls.key"),
      ]);
      proxy.server.setSecureContext({ cert, key, minVersion: "TLSv1.2" });
    } catch {
      process.stderr.write("Workspace TLS certificate reload failed\n");
    }
  }, 30000);
  const shutdown = async () => {
    clearInterval(timer);
    await proxy.close();
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    process.stderr.write("Workspace TLS transport failed\n");
    process.exitCode = 1;
  });
}
