import { spawnSync } from "node:child_process";
import { stripVTControlCharacters } from "node:util";

export function redactUpstreamDiagnostics(value: string, password: string): string {
  return stripVTControlCharacters(value)
    .replaceAll(password, "[redacted]")
    .split("\n")
    .map((line) =>
      /token|password|secret|authorization|pairing|credential|qr.?code/i.test(line)
        ? "[redacted sensitive diagnostic line]"
        : line,
    )
    .join("\n")
    .slice(-8000);
}

export function reportUpstreamFailure(name: string, password: string, lastError: unknown): void {
  console.error(
    `Upstream startup failed for ${name}; last probe: ${redactUpstreamDiagnostics(String(lastError), password)}`,
  );
  for (const args of [
    ["inspect", "--format", "{{json .State}}", name],
    ["logs", "--tail", "40", name],
  ]) {
    const result = spawnSync("docker", args, {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    console.error(
      redactUpstreamDiagnostics(
        `${args[0]}: ${result.stdout ?? ""}\n${result.stderr ?? ""}${result.error?.message ?? ""}`,
        password,
      ),
    );
  }
}
