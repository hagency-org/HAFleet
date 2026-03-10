# Live Matrix Duplicate-Bridge Anti-Recurrence Design

## Scope
Design only.

This note defines the smallest durable correction to prevent the accepted live duplicate-reply incident from recurring.

Out of scope:
- implementation
- Matrix timeout residual narrowing
- backend/control-plane work
- UI changes
- hook work

## Accepted Incident Baseline
The live incident is already narrowed and accepted:
- two `bridge-matrix.js` processes were active at once
- both used cwd `/home/shisui/laplace/agent-chat-live`
- both used `AGENT_CHAT_RUNTIME_DIR=/home/shisui/laplace/agent-chat-live-runtime`
- both used the same Matrix bot identity inputs
- one owner was tmux-managed (`agentchat-live-bridge`)
- one owner was `bridge-matrix.service`
- duplicate replies were a direct consequence of dual owners consuming the same bridge state and delivery path

## Supported Ownership Model
### Stable rule
Exactly one live Matrix bridge owner is supported per runtime root.

The ownership key is:
- `AGENT_CHAT_RUNTIME_DIR`

For any one runtime root, only one process may own:
- `data/matrix/bridge-state.json`
- `data/matrix/bot-store.json`
- the EventSource subscription(s) to the backend
- outbound Matrix delivery for that runtime root

### Current live deployment shape
For the current live stack, the supported owner should be:
- tmux-managed `agentchat-live-bridge`

Unsupported for the same live runtime root:
- a second tmux session running `bridge-matrix.js`
- a systemd unit running `bridge-matrix.js`
- any detached/orphaned shell-launched process running `bridge-matrix.js`

Reason:
- backend and web are already being operated as the live tmux-managed stack
- the accepted incident came from a second owner started outside that stack
- keeping one explicit live owner avoids split operational authority

## Durable Fix Choice
### Decision
The durable fix should be both:
1. operator-owned removal/disable of the stray systemd owner for the current live runtime root
2. in-process single-owner locking in `bridge-matrix.js`

### Why both
#### Operator-owned disable/removal is required immediately
Without removing or disabling `bridge-matrix.service`, the exact proven duplicate-owner path can recur on:
- reboot
- manual service start
- package/unit restart

A design that relies only on a future code lock leaves the already-proven competing owner configured and enabled.

#### In-process locking is still required structurally
Operator cleanup alone is not sufficient as a long-term contract because a second owner could still be started by:
- an accidental second tmux launch
- a shell background launch
- a copied service/unit pointed at the same runtime root
- another operator using the same checkout/runtime root without noticing

The process itself should reject a second owner for the same runtime root instead of assuming deployment hygiene is perfect.

## Single-Owner Lock Contract
### Lock scope
One lock per `AGENT_CHAT_RUNTIME_DIR`.

The lock file should live under the runtime root, alongside the owned Matrix state, for example:
- `<runtimeRoot>/data/matrix/bridge-owner.lock`

### Ownership semantics
On startup, `bridge-matrix.js` should attempt to acquire exclusive ownership for that runtime root before:
- loading or mutating `bridge-state.json`
- loading `bot-store.json`
- opening backend EventSource subscriptions
- starting Matrix sync

If ownership is acquired:
- continue normal startup
- persist owner metadata sufficient for diagnostics:
  - pid
  - start time
  - cwd
  - hostname
  - runtime root
  - optional launcher tag (`tmux`, `systemd`, `unknown`)

If ownership is already held by a live process:
- fail fast
- emit a precise error naming the existing owner metadata
- do not start sync
- do not send Matrix messages
- do not mutate bridge state files

If the lock exists but the recorded owner is dead/stale:
- reclaim the lock
- log that stale ownership was recovered

## Failure And Boot Semantics
### First owner boot
- acquires lock
- starts backend EventSource and Matrix sync
- becomes the sole supported delivery owner for that runtime root

### Second owner boot while first owner is live
Required behavior:
- immediate startup failure
- exit non-zero
- diagnostic message must identify:
  - runtime root
  - current lock owner pid
  - owner cwd / launcher metadata if available
- no partial bridge activity is allowed before exit

This keeps the failure loud and operationally obvious instead of silently duplicating delivery.

### Second owner boot when existing lock is stale
Required behavior:
- detect stale owner
- take ownership
- log stale-lock recovery explicitly
- continue normal startup

### Manual kill / crash of active owner
- lock must be releasable automatically by process exit semantics or detectable as stale on the next start
- the next owner may start only after stale-owner validation

### Current live deployment during operator cleanup
If the current tmux owner is intended to remain live:
- disabling/removing the systemd unit should not interrupt the tmux owner
- if the service is started again before code locking lands, recurrence is still possible
- this is why operator cleanup and code locking are separate required layers

## Smallest Correction Order
### Step 1. Operator-owned removal/disable of `bridge-matrix.service`
For the current live runtime root:
- stop the service if it is running
- disable it so reboot/manual restart does not recreate the duplicate owner
- remove the unit if tmux is the permanent live ownership model

Why first:
- it closes the exact proven recurrence path immediately
- it does not require waiting for a code deploy

### Step 2. Add runtime-root single-owner locking in `bridge-matrix.js`
- enforce one owner per `AGENT_CHAT_RUNTIME_DIR`
- fail fast on second-owner startup
- allow stale-lock recovery only after validating the recorded owner is dead

Why second:
- it closes all other accidental dual-owner paths, not only the current systemd one

### Step 3. Make launcher identity explicit in bridge diagnostics
- record whether the owner was started by tmux/systemd/other
- include that in lock metadata and startup failure logs

Why third:
- not required to prevent duplicates
- but it shortens future incident triage materially

## Non-goals For The First Correction Slice
- do not redesign Matrix sync/event handling
- do not change message dedup semantics inside the bot logic
- do not conflate this with the accepted Matrix timeout residual
- do not broaden into backend/service orchestration redesign
- do not change current live backend/web ownership model

## Minimum Proof Required For Later Implementation
- with one active bridge owner, a second startup against the same runtime root exits fast before any sync/message activity
- stale lock recovery works after killing the first owner
- tmux owner can remain the live owner while a systemd start attempt is rejected cleanly
- the timeout residual remains unaffected and is still tracked separately
