/** The SDK uses ws(s) URLs, while Paseo's CLI accepts tcp://host:port with ssl=true. */
export function cliTarget(gatewayUrl) {
  let url;
  try {
    url = new URL(gatewayUrl);
  } catch {
    throw new Error("Invalid gateway endpoint");
  }
  if (
    !["ws:", "wss:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["/", "/ws"].includes(url.pathname)
  ) {
    throw new Error("Gateway endpoint must be a credential-free ws(s) URL at /ws");
  }
  const secure = url.protocol === "wss:";
  return `tcp://${url.hostname}:${url.port || (secure ? "443" : "80")}${secure ? "?ssl=true" : ""}`;
}
