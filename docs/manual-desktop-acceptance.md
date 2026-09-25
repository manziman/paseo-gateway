# Manual Paseo Desktop acceptance

Use an unmodified Paseo Desktop app against the operator's prepared, localhost-only gateway connection. Record the version shown in **Settings → About** before testing. The gateway, daemon, SDK, and CLI are pinned to **0.9.1**; an unmodified newer desktop that completes the actions below is valid versioned desktop acceptance. An exact-version replay is useful if behavior differs. For that, get the official [Paseo 0.9.1 release](https://github.com/getpaseo/paseo/releases/tag/v0.9.1) and install the matching macOS DMG in a separate location after quitting the currently running Paseo app. The [Apple Silicon DMG](https://github.com/getpaseo/paseo/releases/download/v0.9.1/Paseo-0.9.1-arm64.dmg) has SHA-256 `80145c4d12521f0685159032c5aa9c4743ff38cc259463ecb4dacbb5039d227a`; the release also provides an x64 DMG. Confirm **About** says 0.9.1 when reporting an exact-pin result.

## Connect

For the prepared local session, keep the operator's port-forward and loopback relay running. In **Settings → Hosts → Add host → Direct connection**, enter:

| Field | Value |
| --- | --- |
| Host | `127.0.0.1` |
| Port | `6769` |
| Use SSL | Off for this loopback relay |
| Password | Paste from the operator-provided private file; do not put it in notes or screenshots |

The relay accepts connections only on localhost and verifies TLS to the gateway. This path tests the desktop protocol and authentication, **not** desktop certificate validation. A direct TLS test instead uses the gateway's forwarded TLS port, **Use SSL** on, and a certificate trusted by the desktop; do not disable certificate checks. Run the forward and relay independently of the desktop process before testing app quit/reopen; helper sessions owned by the app under test may terminate with it. If the local connection stops, ask the operator to restore the forward and relay before retrying. Select the newly added host rather than the app's built-in local daemon.

## Run and record

On 2026-09-25, the operator confirmed that the corrected fresh Claude chat flow
displayed command activity and its reply without reopening or refreshing. See
[the recorded qualification](local-parity-qualification.md#first-turn-catalog-handoff-and-latency)
for the tested images and limits. The operator also confirmed that two Claude
chats in separate workspaces kept their messages and activity separate when
switching between them. After the local connection helpers were restored, the
operator confirmed a connected host and both histories intact following app
quit/reopen. Terminals in both test workspaces also displayed their own distinct
markers correctly when switching between them. A text file uploaded through the
desktop attachment control was read by the agent with matching contents. After
the #73 routing fix, the operator also opened an agent-generated file through
its chat link and confirmed the contents matched. These
results do not complete the remaining checklist or the fresh-preference,
zero-Ready cold-start scenario.

Use only an authorized small test project and clearly named test workspaces. Mark each item **PASS**, **FAIL**, or **BLOCKED** with the app version, timestamp, a short observed result, and a redacted screenshot or local evidence reference. A missing UI action is **BLOCKED/not exposed**, not a protocol failure.

Existing suspended acceptance fixtures can have red workspace dots: the pinned
desktop has no suspended status, and the gateway reports their unavailable
workspace as `failed`. This does not mean the host connection failed. Start a
fresh fixture with the sidebar's **New workspace (+)**, select the intended
**Project**, choose **Launch → Chat**, then select the provider in the composer
and submit the test prompt. Use the project's displayed name; it can differ from
its internal ID. For the cold-start check, first use a fresh desktop preference
state with **zero Ready workspaces** (existing fixtures may remain Suspended).
The provider/model picker and source checkout status must populate for the
selected project, and that initial prompted Chat submission must create the
first workspace and agent. Repeat with saved worktree isolation: a detached
source revision may truthfully have no current branch, yet submission should
use the Project's configured revision without inventing a branch-off request.
Record the time to discover providers, a bounded diagnostic error if it fails,
and whether retry works. After the new Workspace appears, its separate model
catalog must become ready and the draft must open the agent automatically,
without refreshing, reopening, or resending the prompt. Record time to Workspace
Ready and time to visible tool/reply separately; a completed server turn alone
does not qualify this handoff (tracked in #71). A saved provider preference or a previously Ready
workspace invalidates this cold-start check. It is tracked in
[#65](https://github.com/manziman/paseo-gateway/issues/65).

Until that check passes, a manual workaround is to submit a **blank** New
Workspace Chat composer, wait for its workspace to become Ready, then select
the provider and create Chat **inside that same workspace**. Launching a blank
Terminal can also create a workspace without selecting a provider. Neither
path verifies the first prompted Chat flow or repairs project-scoped provider
discovery on the New Workspace screen.

1. **Connection and projects:** Connect, select the gateway host, and confirm its project list. Disconnect/reconnect once and verify the same host and projects reappear. Check that an incorrect password is rejected, then restore the correct one.
2. **Two-workspace isolation and live activity:** Create two test workspaces in the authorized project. Start one agent in each with distinct short prompts. Verify each conversation and workspace shows only its own prompt, reply, and status. In an existing chat, send a second harmless prompt such as `Run pwd once, then reply STREAM-OK`. Without refreshing or fetching history, verify tool activity and the final reply appear and the running state clears. Reasoning widgets depend on whether the provider emits reasoning; their absence alone is not a failure. Switch between the two chats and verify live activity stays with the selected agent. Note the provider and any error displayed; do not copy credential details into evidence. Missing live events despite completed stored history is tracked in [#69](https://github.com/manziman/paseo-gateway/issues/69).
3. **History after reconnect:** Close and reopen the desktop while the agents are idle. Reconnect to the gateway host. Both completed conversations should retain their exact user/assistant turn counts, with no duplicate prompt. If a controlled gateway replacement is coordinated, repeat this check afterward; do not resend an uncertain prompt merely because the connection dropped.
4. **Files and terminal:** Where the desktop exposes them, attach a small non-sensitive text file to one agent and verify its content in that workspace. Download or open a generated file if the UI offers it. In each workspace terminal, print a different marker and verify the output stays in the correct tab/workspace. Record an unavailable control as **BLOCKED/not exposed**.
5. **Labels, suspended inventory, and permissions:** If label controls are visible, assign a unique test label to one workspace and check it survives reconnect. Inspect any already-suspended test workspace: retained agents should appear as unavailable/closed, not as a falsely empty workspace. If an agent actually asks for permission, resolve it in the intended workspace and verify the other workspace is unaffected. Do not force a destructive action to manufacture a prompt.
6. **New-agent schedule:** Open **Schedules** from the sidebar. Create a small **new-agent** schedule for the authorized test project and provider, choosing a cadence whose next automatic run is after this test. Verify its name, cadence, and status in the list. Edit its cadence, pause and resume it, use **Run now** once, and verify exactly one new agent/turn and the row's last-run time. Delete the schedule after recording the result.
7. **Existing-agent heartbeat:** Ask the operator to create a heartbeat through the CLI/SDK for a Ready agent in one of this run's test workspaces. In **Schedules**, verify that its target names the correct available agent, edit its cron cadence, then delete this owned heartbeat. Its row does not offer pause, resume, or run-now. Record a false **Target gone** badge or **Agent unavailable** target as **FAIL**, even if cadence edit/delete work. This is tracked in [#64](https://github.com/manziman/paseo-gateway/issues/64); new-agent schedule success does not cover it.
8. **Cleanup:** After recording evidence, archive only the workspaces created for this run through the desktop. Verify their status changes. Leave pre-existing suspended fixtures and their retained volumes alone.

The pinned 0.9.1 desktop [sidebar](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/components/sidebar/sidebar-nav-rows.tsx), [schedule screen](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/screens/schedules-screen.tsx), [row actions](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/components/schedules/schedule-row.tsx), and [form](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/components/schedules/schedule-form-sheet.tsx) establish those controls. Its screen does not expose run logs, and its form creates new-agent schedules; existing-agent heartbeat creation is a CLI/SDK action. The pinned [target lookup](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/schedules/schedule-derivation.ts) compares an agent's public ID to the schedule's GUID target; the installed 0.9.2 desktop bundle retains that comparison. The gateway now implements [durable GUID projection](guid-agent-identity-plan.md) to align those identities while accepting registered legacy scoped IDs. On 2026-09-25, the operator confirmed that the prepared existing-agent heartbeat displayed the correct available target without a false warning. Cadence edit and deletion of that heartbeat remain pending; the exact diagnostic deployment and qualification limits are recorded in the local qualification document.

Use [the full client acceptance matrix](client-acceptance.md) for scenario IDs and `scripts/client-acceptance.mjs` for evidence completeness. Keep passwords, private endpoints, account IDs, repository names, and raw prompts out of public evidence.
