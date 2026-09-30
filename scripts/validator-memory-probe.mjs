// Disposable container probe only. Synthetic constant input; no credentials/network or heap dumps.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setImmediate as turn } from "node:timers/promises";
import { getHeapCodeStatistics } from "node:v8";

if (process.argv[2] === "supervise") {
  const flags = JSON.parse(process.env.PASEO_MEMORY_NODE_ARGS ?? "null");
  if (JSON.stringify(flags) !== "[]" && JSON.stringify(flags) !== '["--no-maglev"]')
    throw new Error("Unexpected packaged Node arguments");
  const child = spawn(process.execPath, [...flags, import.meta.filename, "probe"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  let peakRss = 0;
  let peakAnon = 0;
  let peakCgroup = 0;
  const sample = setInterval(() => {
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
      const value = (key) =>
        Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(status)?.[1] ?? 0) * 1024;
      peakRss = Math.max(peakRss, value("VmRSS"));
      peakAnon = Math.max(peakAnon, value("RssAnon"));
      peakCgroup = Math.max(
        peakCgroup,
        Number(readFileSync("/sys/fs/cgroup/memory.current", "utf8")),
      );
    } catch {
      /* Child may exit between observations. */
    }
  }, 25);
  const deadline = setTimeout(() => child.kill("SIGKILL"), 55_000);
  child.once("error", () => {
    clearInterval(sample);
    clearTimeout(deadline);
    console.log(JSON.stringify({ event: "probe_start_failed" }));
    process.exitCode = 2;
  });
  child.once("exit", (code, signal) => {
    clearInterval(sample);
    clearTimeout(deadline);
    const events = readFileSync("/sys/fs/cgroup/memory.events", "utf8");
    console.log(
      JSON.stringify({
        event: "supervisor",
        code,
        signal,
        peakRss,
        peakAnon,
        peakCgroup,
        oomKill: Number(/^oom_kill (\d+)/m.exec(events)?.[1] ?? 0),
      }),
    );
    process.exitCode = signal === "SIGKILL" ? 137 : (code ?? 2);
  });
} else if (process.argv[2] === "probe") {
  const { validateWSOutboundMessage } = await import("@getpaseo/protocol/validation/ws-outbound");
  const start = performance.now();
  const cpu = process.cpuUsage();
  const text = '{"type":"pong"}';
  let calls = 0;
  let mark = 1;
  let peakRss = 0;
  let peakHeap = 0;
  let peakExternal = 0;
  const initial = process.memoryUsage();
  function sample(event) {
    const memory = process.memoryUsage();
    const code = getHeapCodeStatistics();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    peakExternal = Math.max(peakExternal, memory.external);
    console.log(
      JSON.stringify({
        event,
        ms: Math.round(performance.now() - start),
        calls,
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        code: code.code_and_metadata_size,
      }),
    );
  }
  console.log(
    JSON.stringify({
      event: "runtime",
      node: process.version,
      sdk: JSON.parse(readFileSync("/app/node_modules/@getpaseo/client/package.json", "utf8"))
        .version,
      protocol: JSON.parse(
        readFileSync("/app/node_modules/@getpaseo/protocol/package.json", "utf8"),
      ).version,
      zod: JSON.parse(readFileSync("/app/node_modules/zod/package.json", "utf8")).version,
      v8: process.versions.v8,
      platform: process.platform,
      arch: process.arch,
      noMaglev: process.execArgv.includes("--no-maglev"),
      heapOption: process.env.NODE_OPTIONS === "--max-old-space-size=256",
      targetCalls: 100_000,
    }),
  );
  sample("initial");
  const timer = setInterval(() => sample("sample"), 50);
  while (calls < 100_000 && performance.now() - start < 45_000) {
    for (let i = 0; i < 16 && calls < 100_000; i++) {
      const result = validateWSOutboundMessage(JSON.parse(text));
      if (!result.success || result.data.type !== "pong") {
        console.log(JSON.stringify({ event: "invalid_result", calls }));
        process.exit(3);
      }
      calls++;
      if (calls === mark) {
        sample("progress");
        mark *= 2;
      }
    }
    await turn();
  }
  clearInterval(timer);
  sample("final");
  const used = process.cpuUsage(cpu);
  const nativeSurge =
    peakRss - initial.rss > 400 * 1024 * 1024 &&
    peakHeap - initial.heapUsed < 100 * 1024 * 1024 &&
    peakExternal - initial.external < 100 * 1024 * 1024;
  console.log(
    JSON.stringify({
      event: "summary",
      calls,
      peakRss,
      peakHeap,
      peakExternal,
      nativeSurge,
      elapsedMs: Math.round(performance.now() - start),
      cpuUserMicros: used.user,
      cpuSystemMicros: used.system,
    }),
  );
  process.exitCode = calls !== 100_000 ? 4 : nativeSurge ? 17 : 0;
} else {
  throw new Error("Run through scripts/validator-memory.mjs");
}
