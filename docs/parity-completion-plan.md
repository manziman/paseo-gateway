# Full parity completion plan

Baseline: the published `v1.0.0-alpha.3` has real Claude, private Git, scheduled
worker, scoped authentication, storage lifecycle and recovery qualification.
The target is the headless single-host workflow in [epic #16](https://github.com/manziman/paseo-gateway/issues/16)
plus required unchanged client flows from the v0.1 specification. This plan does
not turn an experimental release into a full-parity support claim.

| Ticket | Implementation and acceptance | Dependencies |
| --- | --- | --- |
| [#56](https://github.com/manziman/paseo-gateway/issues/56) | Supported single-authority Codex subscription refresh, access-only worker credentials, crash/conflict safety | Pinned native/provider contract; dedicated login authority |
| [#57](https://github.com/manziman/paseo-gateway/issues/57) | Authenticated Claude/Codex/OpenCode and GitHub App renewal, expiry and recovery | Operator credentials; #56 for subscription case |
| [#58](https://github.com/manziman/paseo-gateway/issues/58) | Existing-agent schedules, authorized durable target binding, no replay | Existing scheduler/workspace operations |
| [#59](https://github.com/manziman/paseo-gateway/issues/59) | Bounded retained suspended inventory and durable workspace labels | UID-fenced records; controller snapshot hook |
| [#60](https://github.com/manziman/paseo-gateway/issues/60) | Safe attachment and HTTP download routing | Explicit supported routing context; unchanged client contract |
| [#61](https://github.com/manziman/paseo-gateway/issues/61) | EKS storage, encrypted transport, enforced policies/private egress and dedicated node-failure fixture | Qualified candidate, local/provider checks first; operator deployment last |
| [#62](https://github.com/manziman/paseo-gateway/issues/62) | Required CLI/SDK/desktop contract inventory and unchanged client acceptance | #58–60 for final scenarios |
| [#26](https://github.com/manziman/paseo-gateway/issues/26) | Exact-candidate integrated qualification and release documentation | All required implementation and live evidence above |

Work is parallelized across credentials, protocol/lifecycle, and qualification,
with central integration for chart/controller/transport changes. EKS deployment
and live validation are the final stage, performed with the operator. Read-only
preflight and generic deployment tooling can be developed first; no tests may
silently use the current Kubernetes context. Public artifacts omit environment
identity, cloud accounts, private repository names, endpoints and credentials.

Each scenario is recorded as implemented, automated-tested, live-tested,
externally blocked, or intentionally excluded. Missing credentials, missing
upstream hooks and unexecuted failure probes remain blockers. A passing fixture
or a manually filled evidence form is not independent proof of a live workflow.

API keys are additional supported credentials, not a replacement for subscription
authentication. The Codex refresh authority must own a dedicated login; copying a
cache while another host independently refreshes it violates that ownership.
Never mutate an operator's active login merely to qualify a test.

Optional voice/plugins, host filesystem browsing, host recycle/password/reboot
administration, Hub/relay, Agent Sandbox adoption and multi-replica HA remain
outside this milestone. Their exclusion preserves the agreed single-host
replacement scope rather than implying they were implemented.
