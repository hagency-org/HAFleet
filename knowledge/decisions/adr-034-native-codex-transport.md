---
kind: decision
id: ADR-034
title: Own asynchronous runner streams without claiming execution custody
status: Accepted
requirements: [REQ-RUST-MIGRATION-EXECUTION, REQ-THREAD-SCOPED-SESSIONS]
---

## Context

The wire protocol needs owned asynchronous streams with finite writes, reads and cancellation behavior, without introducing another process owner.

## Decision

### Boundary

The next M4 slice connects ADR-032's protocol to host-supplied owned `AsyncRead`
stdout/stderr and `AsyncWrite` stdin streams. The `hagency-runtime` driver creates
no process, descriptor, channel or background task. It is not wired to the native
server and cannot read or mutate the domain store. The existing Codex 0.153.4
protocol baseline remains unchanged. Tokio's existing locked dependency supplies
IO utilities; its paused-clock utilities are a test-only feature.

The host must establish the correct child identity, inherited-channel isolation,
guardian relationship, current dispatch, leases and effective sandbox before
supplying streams. A stream type is not proof of any of these. ADR-029's current
guardian still launches work with inactive stdio; this driver does not change that
launch path or assert that guardian handoff is complete.

### One owner and ordered writes

A `Driver` owns all three streams and its `Connection`. Each `send` operation
admits one protocol command and writes its entire encoded frame, then flushes it.
Only a completed write and flush returns `TransportWrite`. The receipt records
the upstream request ID where applicable and total byte count. It proves only
that the host-supplied writer accepted/flushed these bytes. It is not a verified
child-wrapper input acknowledgement, RPC response, durable admission result,
Agent completion or canonical task transition.

The driver pumps stdout and stderr while a write waits. A response can therefore
be queued before the last stdin byte is accepted; it never shortens the write or
creates a write receipt. The exclusive mutable borrow prevents another command
from overtaking initialized, a partial request or an unfinished flush. There is
no outgoing queue, concurrent sender or reconnect/replay operation.

### Deadlines and cancellation

The driver measures elapsed time from its own Tokio `Instant`, never from a peer
timestamp or caller-provided clock. Defaults are a 10-second write timeout,
60-second event wait and 20-minute connection lifetime. Every configured limit
must be nonzero and no greater than 20 minutes. Protocol request and partial-line
deadlines remain absolute and may expire earlier. The earliest deadline drives
the timer while input is silent; before and after every IO/parse step the driver
checks the original deadlines again. Notifications, stderr, partial bytes and
repeated `next_event` calls cannot extend the connection or request deadline.

Each pump iteration and each event operation cooperatively yields. Always-ready
streams therefore cannot keep the host from polling cancellation, and clock
checks do not depend on a randomized select branch winning against a flood.
The driver creates no timer task: while an operation is pending it polls IO and
its timer itself. If the host keeps a driver idle without polling an operation,
its next operation still checks the original elapsed deadlines before IO.

An operation guard runs synchronously when an in-flight future is dropped,
including cancellation by a surrounding `select` or `timeout`. It poisons the
connection and drops all streams. Failed writes/flushes, write-zero, stdout EOF,
malformed data, deadline expiry and event overflow do the same. A later operation
returns closed; neither a partial frame nor partially accepted output can resume.

`Termination` retains the first cause, accepted and total bytes for an unconfirmed
write, and unresolved host/server request counts. The driver snapshots pending
counts before a protocol call so a protocol error that clears its own maps does
not erase reconciliation evidence. Even fully accepted bytes remain unconfirmed
if flush or the enclosing operation failed. Diagnostic strings are fixed and do
not include input or IO-error fragments.

Every termination is unresolved with respect to execution. Closing stdin/stdout
does not prove an Agent or its descendants stopped. A clean frame-boundary EOF
does not prove a turn finished. The future host adapter must fence the dispatch,
observe/stop the guardian, retain or inspect resource custody and follow the
existing outcome-unknown policy. No driver path releases leases or completes tasks.

### Bounded input and private diagnostics

Stdout and stderr each use a fixed 16 KiB read buffer. The protocol decoder keeps
its existing 1 MiB frame and depth-64 limits. Up to 16 events may wait while a
write is pending, with a separate 2 MiB accounting budget for complete serialized
JSON payloads plus retained event/ID/method/scope metadata. Response accounting
includes host-side metadata absent from a compact upstream reply. This is a
payload budget, not a claimed 2 MiB process-RSS ceiling; frame/depth/count limits
also bound parsed collection overhead, whose device budget remains to measure.

When either event limit is exceeded the driver returns a capacity failure and
closes the connection, retaining unresolved request counts. It never treats an
overflowing approval request as successfully delivered or silently continues
after dropping it. Once the connection fails, queued events are discarded because
they can no longer authorize a current response; host reconciliation is mandatory.

Stderr is a separate byte stream, not JSON protocol input. The driver continuously
drains it into a private 16 KiB tail and counts all received bytes. Older diagnostic
bytes are deliberately evicted from the tail; the total count makes that truncation
observable. Stderr EOF alone leaves stdout usable. Diagnostic snapshots have no
Serialize/Debug projection and are never automatically logged or sent to a console.
They may contain secrets and require a separately reviewed privacy boundary.

### Validation and remaining gates

Offline tests use real bounded Tokio duplex streams. They exercise partial and
blocked writes, a deliberately stalled flush over a real duplex writer, a response
arriving before write completion, broken IO, partial and idle EOF, dropped send/read
futures, silence, slow partial frames, request/lifetime deadlines, event count and
large-payload pressure, stderr truncation, and preserved unresolved request counts.
Most timing tests use Tokio's deterministic clock. A real timer test separately
checks silence and continuously ready stdout with no producer sleep. Fixture joins
and line reads are bounded too. No model, network service or deployed process is
contacted by these tests.

Still required: actual guardian-to-runtime stdio transfer without descriptor leaks;
verified complete child input acknowledgement; runtime version/platform and sandbox
qualification; exact thread/turn/item and capability binding; approved permission
decisions; Agent/MCP activity and usage; process stop/inspection; durable completion
and delivery. Transport tests establish none of these process or business gates.

## Consequences

One driver retains ordered stream operations and explicit uncertainty. Its duplex fixtures do not supply child-process custody, dispatch authority or installed-runtime qualification.

## Alternatives Considered

Detached reader tasks or replaying a cancelled write would split stream ownership and make uncertain input appear safe to resend. This adapter therefore remains separate from the guardian launcher.

## Cooperative host control and original prepared frames

The bounded runtime control-pump contract adds a private leaf-IO operation. It
borrows a caller-owned pinned future and selects that future alongside single
cancel-safe stdout/stderr reads while the original Driver operation guard remains
alive. A successful Control return retains all partial bytes, decoder state,
queues, stderr and connection identity. It does not drop a public read, synthesize
an event, or spawn another reader. Dropping the new started public operation still
poisons the original transport. The host consumes a completed control output once;
the API never polls that completed future again on its own.

Preparation synchronously reserves the original callback and encodes its exact
once/decline frame. The original non-cloneable frame remains retained before any
host response-begin await. Reservation is not domain authority or an observation
of bytes sent. Before the first physical byte, the sole writer drains buffered
and ready stdout, including completing any existing partial frame under its
original deadline. Each resulting event is returned to the session/host before
continuing. The same original byte vector may move into the writer and back only
at offset zero; it is never reconstructed or re-encoded. The first send invocation
starts one fixed write deadline, including time spent handling returned updates.
A new callback or slow host recheck can exhaust that bound; neither allows a
fresh write clock or a replacement frame. After any byte is accepted the original
frame must finish/flush or fail with its retained unconfirmed-byte evidence.

Callback owner and response deadlines are derived from the connection's original
monotonic callback admission, with at most 16 retained session callbacks. Policy
requires a nonzero owner wait, a response reserve at least the existing transport
write timeout, and a total no greater than the existing 20-minute ceiling. Both
initial opt-in and each callback admission must fit the ORIGINAL connection
lifetime. It is not extended. The earliest original pending owner bound governs
silent parked maintenance. Preparation must happen before that callback's owner
bound and permits only its fixed response deadline for admission and writing;
unprepared siblings still expire at their original owner bounds. Partial-frame
and protocol deadlines can expire first.
A normal event wait persists across Control returns and ends only upon an actual
typed read result. Prepared-send buffer drains do not reset that read clock.
No host execution budget, write timeout, partial-frame or request policy changes.


## Amendment (2026-09-12, withdrawn): the mid-write parse hold and its read guard

A previous amendment made `step()` hold parsing while a frame had accepted
bytes and was not yet flushed, so a `serverRequest/resolved` for the frame
being written could not be parsed between its write and its receipt, and
guarded the select's stdout read arm (`read_ready`) so the held bytes could
not be overwritten. **Both are withdrawn**, together with their test
(`native_transport_hold_keeps_unparsed_input`): the hold contradicted this
ADR's own transport contract. Two pinned integration tests fail under it —
`native_codex_transport_write_complete_and_early_rpc_response` requires an
upstream response written while only a prefix of a 32 768-byte stdin request
was accepted to be **parsed and queued by receipt time** (`queued_events()
== 1`), and `native_codex_transport_pressure_event_count_and_bytes` requires
flood bytes arriving mid-write to be **parsed and counted as capacity
pressure** (`Error::Capacity`) rather than discovered by the write deadline
(`Error::Timeout`). Upstream bytes ready while the host's write is mid-flight
are exactly the window the hold suppressed, and no scoping narrower than
"hold everything" classifies a message before parsing it, which is itself a
parse. `step()` is restored to its pre-hold shape: parse-first when input is
pending, and the select's read arm is reachable only with an empty buffer —
the invariant the original early return always provided. The read guard's
sentence is retired with the hold: nothing relies on it once `step()` drains
`input` before arming a read again.

One read-only projection introduced with the hold survives:
`prepared_admissible(id)` (whether the connection still holds the prepared
server request, false once its `serverRequest/resolved` was parsed). It
carries no authority, admits no resend, and changes no verdict; the approval
adapter's send path uses it to drop — not send — a frame whose transmit path
is already gone. `write_progress()` is withdrawn with the hold: no stamp
remains that reads it.

