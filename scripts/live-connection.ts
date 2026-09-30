import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ConnectionOptions } from "node:tls";
import { createWebSocketTransportFactory } from "@getpaseo/client/internal/daemon-client-websocket-transport";
import { type ClientOptions, WebSocket } from "ws";

/** Local acceptance configuration only; never serialize this object or credential values. */
export interface LiveConnectionConfig {
  identitySecret: string;
  tls?: { ca: string; serverName: string };
}

/** TLS is opt-in for legacy loopback installs, but never falls back after a TLS failure. */
export async function liveConnectionConfig(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LiveConnectionConfig> {
  const identitySecret = env.PASEO_IDENTITY_SECRET ?? "paseo-identity";
  const caFile = env.PASEO_TEST_CA_FILE;
  const serverName = env.PASEO_TEST_TLS_SERVER_NAME;
  if (
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(identitySecret) ||
    Boolean(caFile) !== Boolean(serverName) ||
    (serverName && !/^[a-zA-Z0-9.-]{1,253}$/.test(serverName))
  )
    throw new Error("Invalid live connection configuration");
  if (!caFile || !serverName) return { identitySecret };
  try {
    return { identitySecret, tls: { ca: await readFile(caFile, "utf8"), serverName } };
  } catch {
    throw new Error("Live connection trust file unavailable");
  }
}

/** Verified HTTP and WebSocket clients for the same operator-owned loopback forward. */
export function liveConnection(port: number, config: LiveConnectionConfig) {
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid live connection port");
  const base = `${config.tls ? "https" : "http"}://127.0.0.1:${port}`;
  const url = `${config.tls ? "wss" : "ws"}://127.0.0.1:${port}/ws`;
  const security: Pick<ConnectionOptions, "ca" | "servername" | "rejectUnauthorized"> = {
    rejectUnauthorized: true,
    ...(config.tls ? { ca: config.tls.ca, servername: config.tls.serverName } : {}),
  };
  const socket = (headers?: ClientOptions["headers"], protocols?: string | string[]) => {
    const options: ClientOptions & Pick<ConnectionOptions, "servername"> = {
      ...security,
      headers,
      perMessageDeflate: false,
      handshakeTimeout: 10_000,
    };
    const result = new WebSocket(url, protocols, options);
    result.on("error", () => {}); // Consumers observe failure; no unhandled raw diagnostic.
    return result;
  };
  const transportFactory = createWebSocketTransportFactory((address, options) => {
    if (address !== url) throw new Error("Live transport endpoint changed");
    const ws = socket(options?.headers, options?.protocols);
    return {
      get readyState() {
        return ws.readyState;
      },
      send: (data) => ws.send(data),
      close: (code, reason) => ws.close(code, reason),
      on: (event, listener) => ws.on(event, listener),
      off: (event, listener) => ws.off(event, listener),
    };
  });
  const http = (path: string, token: string, body?: object): Promise<Response> => {
    if (!/^\/(?!\/)/.test(path) || /[\\\r\n]/.test(path))
      return Promise.reject(new Error("Invalid live HTTP path"));
    return new Promise((resolve, reject) => {
      const request = (config.tls ? httpsRequest : httpRequest)(
        new URL(path, base),
        {
          ...security,
          method: body ? "POST" : "GET",
          headers: {
            authorization: `Bearer ${token}`,
            ...(body ? { "content-type": "application/json" } : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) request.destroy(new Error("Response too large"));
            else chunks.push(chunk);
          });
          response.on("error", fail);
          response.on("end", () => {
            clearTimeout(deadline);
            const headers = new Headers();
            for (const [key, value] of Object.entries(response.headers))
              if (value !== undefined)
                headers.set(key, Array.isArray(value) ? value.join(", ") : value);
            const status = response.statusCode ?? 502;
            resolve(
              new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
                status,
                headers,
              }),
            );
          });
        },
      );
      const deadline = setTimeout(() => request.destroy(new Error("Deadline")), 10_000);
      function fail() {
        clearTimeout(deadline);
        reject(new Error("Live HTTP request failed"));
      }
      request.on("error", fail);
      request.end(body ? JSON.stringify(body) : undefined);
    });
  };
  return { url, transportFactory, socket, http };
}
