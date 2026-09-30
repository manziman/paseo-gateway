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

## Fresh Desktop preferences on macOS

For the cold-start case, use upstream's `PASEO_ELECTRON_USER_DATA_DIR` hook with a
new directory instead of resetting existing Desktop preferences. Give the QA
instance a separate `PASEO_HOME` and disable built-in daemon management before
launch. The [upstream packaged-app smoke test](https://github.com/getpaseo/paseo/blob/81865852011df86aa0ad0ae411cb2f5e4078153f/packages/desktop/e2e/packaged-app-smoke.js#L132)
uses these isolation hooks; [Desktop applies the user-data override](https://github.com/getpaseo/paseo/blob/81865852011df86aa0ad0ae411cb2f5e4078153f/packages/desktop/src/main.ts#L299)
before its single-instance lock. The installed 0.9.2 bundle was also checked for
these branches. On 2026-09-30, the same isolation hooks in Desktop 0.10.2 passed
the fresh-client launch and cold-project flow; see the
[versioned evidence](local-parity-qualification.md#fresh-desktop-catalog-and-branch-selection--2026-09-30).

```sh
umask 077
paseo_qa_dir="$(mktemp -d /tmp/paseo-desktop-fresh.XXXXXX)"
mkdir "$paseo_qa_dir/user-data" "$paseo_qa_dir/daemon"
cat > "$paseo_qa_dir/user-data/desktop-settings.json" <<'JSON'
{
  "version": 1,
  "settings": {
    "releaseChannel": "stable",
    "notifications": { "playSound": true },
    "daemon": { "manageBuiltInDaemon": false, "keepRunningAfterQuit": false }
  },
  "migrations": {
    "legacyRendererSettingsImported": true,
    "daemonStopOnQuitDefaultApplied": true
  }
}
JSON
PASEO_ELECTRON_USER_DATA_DIR="$paseo_qa_dir/user-data" \
PASEO_HOME="$paseo_qa_dir/daemon" \
PASEO_TEST_APP_NAME="Paseo Fresh QA" \
  /Applications/Paseo.app/Contents/MacOS/Paseo
```

Use the separately named QA window and add only the prepared gateway through
**Add host → Direct connection**. Keep built-in daemon management disabled, leave
the original app running, and do not copy its storage into the QA profile. Quit
only the QA instance after testing. Retain its temporary directory for evidence
until cleanup. This isolates preferences and daemon home, not all filesystem
writes: the app can create its ordinary macOS log directory under
`~/Library/Logs/Paseo Fresh QA`.

Fresh client preferences alone do not make the server catalog cold. Coordinate
zero Ready workspaces and a new or intentionally invalidated fixture catalog
scope with the operator before performing the first prompted Chat check.

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
results do not complete the remaining checklist. The separate fresh-preference,
zero-Ready cold-start scenario subsequently passed on 2026-09-30, including
nondefault branch selection and automatic first-turn activity. Its observed
discovery delays are recorded separately from functional success.

On 2026-09-30, the operator also opened a newly captured stopped conversation in
the fresh Desktop 0.10.2 profile and confirmed its saved prompt, command activity
and exact reply without resuming or resending. The workspace remained Suspended
with the same UID. This completes the manual stopped-history check for the
recorded candidate; older uncaptured histories retain the documented limits.

The same Desktop 0.10.2 session subsequently passed permission denial in one
workspace and approval in another, with stale tabs for deleted fixtures left
open. Read-only checks confirmed that denial left the other request pending and
only the approved write created its file. Idle **Reload agent** also preserved
the same conversation and prompt count. **Stop agent** subsequently cancelled a
fresh permission-pending write without creating its file or changing the other
agent. This does not establish cancellation of an already executing shell.
See the [local evidence](local-parity-qualification.md#stale-tab-isolation-and-desktop-permissions--2026-09-30).

The same open terminals subsequently survived a gateway replacement. The
operator printed new distinct markers in each tab without creating replacement
terminals; SDK checks confirmed unchanged terminal and workspace/Pod identities
and isolated retained output. The operator also edited and saved a text file
through the built-in Files panel; SDK checks verified the exact saved contents
and absence from the other workspace. Closing both root agent chat tabs then
archived those agents successfully. Native and gateway reads preserved every
original user prompt; native archival reconstructed message identifiers and
sequence numbers, which are not claimed to remain unchanged. The operator
then archived both disposable workspaces from the sidebar; both reached Archived,
their Pods were removed, and their original PVC identities were preserved.

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

Do not substitute a blank workspace or Terminal launch for this acceptance
case: those paths do not verify the first prompted Chat flow. On a failure,
record the exact stage and inspect the created agent before resending anything.

1. **Connection and projects:** Connect, select the gateway host, and confirm its project list. Disconnect/reconnect once and verify the same host and projects reappear. Check that an incorrect password is rejected, then restore the correct one.
2. **Two-workspace isolation and live activity:** Create two test workspaces in the authorized project. Start one agent in each with distinct short prompts. Verify each conversation and workspace shows only its own prompt, reply, and status. In an existing chat, send a second harmless prompt such as `Run pwd once, then reply STREAM-OK`. Without refreshing or fetching history, verify tool activity and the final reply appear and the running state clears. Reasoning widgets depend on whether the provider emits reasoning; their absence alone is not a failure. Switch between the two chats and verify live activity stays with the selected agent. Note the provider and any error displayed; do not copy credential details into evidence. Missing live events despite completed stored history is tracked in [#69](https://github.com/manziman/paseo-gateway/issues/69).
3. **History after reconnect:** For stopped-history acceptance, first complete a short conversation using the candidate workspace image, then coordinate its suspension and confirm the snapshot receipt exists and the daemon Pod is absent. Open it from a fresh Desktop preference profile: the saved messages must appear without resuming the workspace or resending a prompt. A previously cached chat alone does not prove this path. See [retained history](retained-history.md) for old-image migration and truncation limits. Separately, close and reopen the desktop while the agents are idle. Reconnect to the gateway host. Both completed conversations should retain their exact user/assistant turn counts, with no duplicate prompt. If a controlled gateway replacement is coordinated, repeat this check afterward; do not resend an uncertain prompt merely because the connection dropped.
4. **Files and terminal:** Where the desktop exposes them, attach a small non-sensitive text file to one agent and verify its content in that workspace. Download or open a generated file if the UI offers it. For editing in Desktop 0.10.2 on macOS, select the workspace and press **⌘⇧E** to open Paseo’s built-in **Files** panel, open the text file, edit it, then press **⌘S**. The workspace menu’s **Open in file manager** invokes Finder and cannot open the pod’s remote path. In each workspace terminal, print a different marker and verify the output stays in the correct tab/workspace. Record an unavailable control as **BLOCKED/not exposed**.
5. **Labels, suspended inventory, and permissions:** If label controls are visible, assign a unique test label to one workspace and check it survives reconnect. Inspect any already-suspended test workspace: retained agents should appear as unavailable/closed, not as a falsely empty workspace. If an agent actually asks for permission, resolve it in the intended workspace and verify the other workspace is unaffected. Do not force a destructive action to manufacture a prompt.
6. **New-agent schedule:** Open **Schedules** from the sidebar. Create a small **new-agent** schedule for the authorized test project and provider, choosing a cadence whose next automatic run is after this test. Verify its name, cadence, and status in the list. Edit its cadence, pause and resume it, use **Run now** once, and verify exactly one new agent/turn and the row's last-run time. Delete the schedule after recording the result.
7. **Existing-agent heartbeat:** Ask the operator to create a heartbeat through the CLI/SDK for a Ready agent in one of this run's test workspaces. In **Schedules**, verify that its target names the correct available agent, edit its cron cadence, then delete this owned heartbeat. Its row does not offer pause, resume, or run-now. Record a false **Target gone** badge or **Agent unavailable** target as **FAIL**, even if cadence edit/delete work. This is tracked in [#64](https://github.com/manziman/paseo-gateway/issues/64); new-agent schedule success does not cover it.
8. **Cleanup:** After recording evidence, archive only the workspaces created for this run through the desktop. Verify their status changes. Leave pre-existing suspended fixtures and their retained volumes alone.

The pinned 0.9.1 desktop [sidebar](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/components/sidebar/sidebar-nav-rows.tsx), [schedule screen](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/screens/schedules-screen.tsx), [row actions](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/components/schedules/schedule-row.tsx), and [form](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/components/schedules/schedule-form-sheet.tsx) establish those controls. Its screen does not expose run logs, and its form creates new-agent schedules; existing-agent heartbeat creation is a CLI/SDK action. The pinned [target lookup](https://github.com/getpaseo/paseo/blob/v0.9.1/packages/app/src/schedules/schedule-derivation.ts) compares an agent's public ID to the schedule's GUID target; the installed 0.9.2 desktop bundle retains that comparison. The gateway now implements [durable GUID projection](guid-agent-identity-plan.md) to align those identities while accepting registered legacy scoped IDs. On 2026-09-25, the operator confirmed that the prepared existing-agent heartbeat displayed the correct available target without a false warning. The operator subsequently confirmed cadence edit and deletion, completing this manual heartbeat check. The exact diagnostic deployment and qualification limits are recorded in the local qualification document.

Use [the full client acceptance matrix](client-acceptance.md) for scenario IDs and `scripts/client-acceptance.mjs` for evidence completeness. Keep passwords, private endpoints, account IDs, repository names, and raw prompts out of public evidence.
