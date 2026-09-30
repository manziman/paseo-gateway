# Durable gateway schedules

The gateway implements the pinned upstream `schedule/create`, `list`, `inspect`,
`update`, `pause`, `resume`, `delete`, `logs`, and `run-once` RPCs. `ScheduleService`
owns persistence and scheduling; injected dispatch/observe adapters own workspace
lifecycle and upstream agent execution. Initialize the service before readiness,
then poll `tick()` once per second. Only one scheduler process is supported; the
HA prerequisites in [ha-design.md](ha-design.md) also apply to this scheduler.

The poll waits for durable fire reservation and intent storage, then lets backend
dispatch proceed in a tracked task pool. A cold workspace does not block other
due schedules. Dispatch and observation have separate concurrency limits, each
defaulting to eight and configurable from 1 to 64 through
`maxInflightDispatches`/`maxInflightObservations`. Observations rotate across runs
and never overlap for the same run. Saturated dispatch skips a cron occurrence
with a `schedule_dispatch_capacity_exceeded` diagnostic event; manual run-once
reports capacity exhaustion. There is no unbounded queue or later backfill.
Wire `onError` to log its sanitized event name; backend error objects are not
passed to this callback. Manual run-once and run-on-create acknowledge after the
durable reservation and intent exist, before waiting for a cold workspace or agent
creation. Their run record initially has null agent/workspace IDs; callers inspect
or poll schedule logs for dispatch outcome. Acknowledgment means durable acceptance,
not that the agent is ready. An identical run-once request ID cannot replay a pending
dispatch, including when the schedule is paused.

Shutdown calls `close(timeoutMs)`, defaulting to a 30-second drain. It immediately
stops accepting new fires and waits for tracked dispatches, observations and the
current poll. The result reports whether it drained and the remaining task counts.
It does not cancel accepted backend mutations. If shutdown exceeds the budget,
terminate the process according to the deployment's grace period; persisted
unfinished intents are reconciled as unknown at next startup, never replayed.

Create a `new-agent` target with `cwd` set to a configured `/projects/<id>` or
`/workspaces/<id>`. The gateway persists the selected project and credential
profile alongside the pinned schedule DTO, including provider, model, mode,
thinking option, prompt, cadence and expiry/run limits. Every dispatch receives
that binding and a durable run ID. The lifecycle adapter must create an isolated
workspace/agent and attach the `paseo.schedule-id` agent label; it must return the
workspace ID and the upstream agent GUID. Schedule run DTOs require GUID agent IDs,
so logs carry the GUID plus workspace ID; aggregate inventory can carry the scoped
gateway agent ID. They must be mapped when navigating from logs to an agent.

Existing-agent and self targets are explicitly rejected because the upstream
GUID-only schema does not establish a safe gateway workspace binding. Advanced
provider options, feature values, custom system prompts and MCP configuration are
also rejected until the lifecycle adapter can preserve them. Rejected options are
not silently dropped. Updating a schedule may not switch its project/profile;
create a new schedule for a different binding.

The service supports five-field cron syntax from the pinned upstream validator
and IANA timezones, defaulting to UTC. `cron-parser` 5.10.1 computes future times;
the dependency's [timezone and DST behavior](https://github.com/harrisiirak/cron-parser#timezone-support)
is covered by regression cases for America/Chicago's spring-forward and fall-back
transitions. A spring 02:30 occurrence shifts to 03:30 on the missing-hour day;
the repeated fall 01:30 is not dispatched twice. Rolling `every` intervals must
be at least one second. Restart recalculates stale next-run timestamps into the
future. A tick delayed by more than one second skips the missed occurrence and
computes the next future time, so outages do not create a burst of catch-up work.

Concurrency is persisted per schedule. `Forbid` is the default and prevents a new
fire while a previous run is running or has an unknown dispatch outcome. `Allow`
permits overlap, bounded to 16 outstanding runs per schedule. The upstream RPC
schema has no concurrency field; deployments configure the default with
`ScheduleOptions.defaultConcurrency`, and trusted integration code can change an
existing schedule with the authorized `setConcurrency` method. This is not an
additional upstream CLI flag. A cron occurrence blocked by Forbid is skipped,
not queued; manual run-once returns an error. Paused schedules accept explicit
run-once without resuming the cadence. Expiration and maximum-run limits still
apply to manual runs.

Each fire first compare-and-swaps a reservation into the schedule ConfigMap. That
single write reserves the concurrency slot and advances the schedule/run counter.
A separate run record is then persisted with dispatch intent, before any backend
side effect. A cron fire's ID is deterministic from schedule ID and scheduled time;
a manual fire uses its request ID. Conflicting writers cannot both reserve the
same state. Manual request-ID deduplication lasts while the run record is retained;
this is not an unlimited idempotency service.

The dispatch callback is never automatically replayed. A generic dispatch error
or a process death with reserved/dispatching intent records an interrupted,
unknown outcome. The upstream run schema has no `unknown` status, so the wire
representation is `failed` with an explicit unknown-outcome error; the durable
record retains `phase: unknown`. Forbid continues blocking until an operator
inspects the backend and explicitly resolves the run using `completeRun`.
`ScheduleDispatchRejected` is reserved for adapter failures known to precede agent
acceptance; those release the concurrency slot. If storage becomes unavailable
after acceptance, do not retry the agent creation on recovery.

Runs with acknowledged workspace/agent IDs remain `running` across gateway
replacement. The injected observer queries their existing backend state and
completes them when terminal; it must return no outcome while work is still
running or backend state is unavailable. Completion releases the concurrency
slot. Gateway restart therefore observes existing work rather than replacing it.
Scheduler polling/observation errors must surface in operator diagnostics; a
failing backend is not evidence of a successful or empty run.

New-agent runs capture `archiveOnFinish` in their durable fire reservation. The
upstream default is true: completion archives the workspace after teardown. Explicit
false leaves the completed agent and workspace active, including a terminal failed
run. Editing the schedule after a fire has been accepted does not change that run's
cleanup policy, and the captured preference survives gateway restart. Run records
created before this field existed retain the previous true behavior. Existing-agent
schedule completion never archives its target workspace.

History retains 50 terminal runs per schedule by default, configurable from 1 to
200. Output is limited to 8 KiB characters and error text to 2 KiB characters.
Active/unknown runs are preserved separately and bounded by the outstanding-run
limit. Total run counts remain durable even after history pruning, so `maxRuns`
cannot be bypassed by retention. A schedule with active or unresolved runs cannot
be deleted. Once resolved, delete removes its history records; worker/PVC cleanup
belongs to the workspace retention policy, never an implicit schedule replay.

Schedule records contain prompts and configuration, so protect their namespaced
ConfigMaps with RBAC and the cluster's storage policy. They contain no bearer,
signing key or provider credential. A scoped caller can list/manage only schedules
matching both its project and credential profile. A created schedule is a durable
automation with a persisted role binding: its lifetime is separate from the
creator's short-lived bearer. Pause/delete the schedule to revoke that automation.

`tests/schedules.test.ts` verifies protocol responses, invalid configuration,
timezone/DST behavior, role isolation, competing reservations, Forbid/Allow,
paused behavior, restart without backfill/replay, partially persisted intent,
failed spawn, bounded history, and record cleanup. Real provider dispatch,
schedule-label inventory, worker cleanup and replacement during agent creation
still require the live deployment acceptance suite.
