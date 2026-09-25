# Pinned gateway validator memory workaround

The gateway starts Node with the explicit `--no-maglev` argument. This leaves
protocol validation, the unmodified Paseo SDK, and other V8 execution tiers in
place. It applies to the gateway Docker command and `npm start`/`npm run dev`;
workspace daemons and provider runtimes are unchanged. The chart's existing
`NODE_OPTIONS=--max-old-space-size=256` heap budget remains in effect.

On Linux arm64 with Node **24.21.0**, V8 **13.6.233.17-node.53**, Paseo SDK/protocol
**0.9.1**, and Zod **4.4.3**, repeatedly validating the valid 15-byte WebSocket pong
reproduced a transient native allocation exceeding one GiB RSS. The SDK calls its
11,730,462-byte generated AOT outbound validator; the gateway separately uses the
normal Zod schema. The pinned SDK has no supported validator-selection/injection
option: its wrapper unconditionally imports AOT. Zod's runtime `jitless` setting
does not select a different SDK AOT validator.

Two minimized default-optimizer trials reached approximately 1.10 GB RSS and
1.06 GB anonymous RSS while JavaScript heap stayed below 96 MB and external
memory near 25 MB. Both completed 100,000 successful validations after the
transient allocation was released. Two matched `--no-maglev` trials stayed below
355 MB RSS. Disabling only TurboFan still caused a cgroup OOM; the ordinary Zod
schema control stayed below 138 MB. These figures use decimal bytes, not MiB.
The samples isolate a runtime optimizer interaction with this pinned generated
validator; they do not prove that a particular production frame caused a restart.

The exact binary's `node --v8-options` reports Maglev enabled by default.
`process.allowedNodeEnvironmentFlags.has('--no-maglev')` returns false, so this
flag must be a Node command argument, **not** appended to `NODE_OPTIONS`. Do not
replace it with global `--jitless`, skip validation, or patch generated dependency
code. The [Node V8 statistics API](https://nodejs.org/download/release/v24.20.0/docs/api/v8.html#v8getheapcodestatistics)
reports generated code/metadata; those counters stayed nearly flat during the
surge, so they do not exclude temporary native compiler allocations. Exact flag
availability was verified against 24.21.0 itself.

## Resource-bounded regression

Build or select a **local** gateway image and run:

```sh
npm run test:validator-memory -- LOCAL_GATEWAY_IMAGE
# Opt-in negative control; deliberately returns 17 when the spike/OOM reproduces:
npm run test:validator-memory -- LOCAL_GATEWAY_IMAGE --baseline
```

The runner refuses a missing image, unsupported architecture/version, or an
unexpected image command; it does not pull an image. Normal mode requires the
packaged command `node --no-maglev dist/main.js` and uses those same Node arguments
for its disposable probe. Baseline mode removes only `--no-maglev`. Both set the
same 256 MiB heap budget, use the image's pinned SDK validator, and JSON-parse and
validate exactly 100,000 synthetic pongs, yielding after each 16. Incorrect parse
results fail. There are no credentials, sockets, provider calls, repository
checkouts, or live payloads.

The container is read-only, network-disabled, limited to one CPU/one GiB/no swap,
and removed after completion. A small independent process samples `/proc` and
cgroup counters while the probe samples V8 counters. Normal mode passes only if
all validations finish, no OOM occurs, the runtime/flag pins match, and sampled
child peak RSS remains below 512 MiB. Output is a redacted JSON report with the
exact image digest, counters, CPU time and result. Deadline, invalid output,
unsupported runtime and missing prerequisites are failures, never passes. Cleanup
checks the invocation's unique container label before removing any survivor.

This regression is deliberately opt-in and Linux-arm64-specific; it is not a
portable timing/RSS assertion in ordinary CI. On the initial command-only
candidate, it passed at 357,650,432 bytes peak RSS, with 100,000 validations in
692 ms (588 ms user CPU, 83 ms system CPU). The same candidate without the flag
reproduced a cgroup OOM at 1,089,622,016 bytes sampled RSS. Those measurements
qualify the packaged workaround on the prior gateway code, not a combined release
or representative-load performance. Do not interpret this small hot-loop timing
as a service throughput claim.

Reevaluate this workaround on every Node/V8, SDK/protocol, or validator-generation
upgrade. Record a new baseline and mitigated comparison before changing its
scope or removing it; qualify other architectures separately. Run protocol,
provider, catalog/history and representative CPU/latency checks plus an observation
window longer than prior restart recurrence before declaring the production
memory issue fixed. Raising the heap or container limit alone does not remove the
reproduced allocation.
