# codex review — finding record + controller digest

gpt-5.6-sol, max reasoning, `workspace-write`. Reviewed `origin/main...HEAD`
(`c705c7332`, `733f2157e`). Ran `cargo test -p octos-fleet` (114 passed) plus
standalone probes for concurrent append, serialization size, watermark resumption,
input ordering and append scaling. Read the pinned redb 2.6.3 transaction source.

---

Verdict: block these commits. The redb append transaction is safe and the schema-version decision is correct. The central digest budget, watermark semantics, lifecycle fencing, and scale claims are not.

## 1. Correctness of `append_finding`

The scan and insert are transactionally correct under valid store state.

- The shared `io_gate` is acquired before blocking work at [store.rs:2523](crates/octos-fleet/src/store.rs:2523).
- Scan, reference validation, sequence allocation, and insert all occur in one write transaction beginning at [store.rs:2526](crates/octos-fleet/src/store.rs:2526), with the only commit at [store.rs:2574](crates/octos-fleet/src/store.rs:2574).
- I checked redb 2.6.3’s implementation, not just its docs: `start_write_transaction` blocks while another writer exists at [transaction_tracker.rs:117](/Users/yuechen/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/redb-2.6.3/src/transaction_tracker.rs:117), and uncommitted transactions abort on drop at [transactions.rs:2349](/Users/yuechen/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/redb-2.6.3/src/transactions.rs:2349).

Therefore:

- No duplicate sequence is produced by concurrent appends.
- No committed append is lost.
- A rejected `supersedes` append writes nothing.
- A concurrent guessed reference either runs after its target and succeeds, or before it and fails; it cannot commit dangling.
- There is currently no production deletion path that could later dangle an edge.

A 64-task concurrent probe returned exactly the unique sequences `1..=64`.

The test suite does not test this concurrency; its sequence test is entirely sequential at [store.rs:4193](crates/octos-fleet/src/store.rs:4193).

## 2. The append-only claim

The narrow claim is true: release code exposes no finding update/delete method. The only overwrite path is the test-only raw writer at [store.rs:4642](crates/octos-fleet/src/store.rs:4642).

The broader conclusion is wrong.

“No write ever contends with another” at [records.rs:442](crates/octos-fleet/src/records.rs:442) is false. Every append contends on the store-wide mutex, redb’s single-writer slot, and the shared next-sequence invariant.

More importantly, append-only storage does not eliminate stale-writer fencing:

- `append_finding` does not accept or check an attempt ID, generation, lease, or owner epoch.
- It does not check that the fleet exists.
- It does not check that `task_id` exists or is still running.
- It does not check fleet/task terminal state.
- `by` is an unauthenticated arbitrary string.

A worker can be cancelled or superseded, then append afterward because the method validates only key syntax, claim, and component at [store.rs:2504](crates/octos-fleet/src/store.rs:2504). My probe successfully appended a `Confirmed` finding to a nonexistent fleet and nonexistent task with empty evidence, empty config, and empty `by`.

That also directly contradicts the record contract:

- `Confirmed` is documented as demonstrated “with evidence” at [records.rs:422](crates/octos-fleet/src/records.rs:422).
- A finding without config is called “untrustworthy” at [records.rs:472](crates/octos-fleet/src/records.rs:472).

Both are accepted.

Other missing cross-row semantics:

- Two writers can both supersede the same live finding; both succeed and both replacements remain live.
- Duplicate IDs inside one `supersedes` vector are accepted and produce duplicate overturn events.
- Cancellation after commit followed by retry creates duplicate semantic findings with different sequences; there is no idempotency key.

A CAS is unnecessary merely to allocate the next sequence, but generation/lease/capability predicates are orthogonal to mutation. The commit conflates those two concerns.

## 3. Scale

This implementation is not viable for a high-cardinality finding log.

At [store.rs:2534](crates/octos-fleet/src/store.rs:2534), every append:

- scans the entire global findings table, including other fleets;
- JSON-decodes every row belonging to the target fleet;
- builds a `BTreeSet` of every existing ID—even when `supersedes` is empty.

Thus one append is approximately `O(global_rows + fleet_rows log fleet_rows)`. Building an N-row fleet by repeated appends is quadratic or worse.

`list_findings` repeats a global scan and then sorts data whose padded keys were already ordered at [store.rs:2596](crates/octos-fleet/src/store.rs:2596). The global gate means these scans block unrelated fleet transitions, reads, decisions, and outbox operations.

`digest()` is actually `O(N log N)` in several places because of its `BTreeSet`/`BTreeMap` construction, with `O(N)` extra memory and string cloning. Worse, it builds the unbounded result first and trims only afterward. `max_chars` does not bound read cost or peak memory.

An indicative debug-build probe with tiny rows took:

- First 250 appends: 1.80s
- Next 250: 2.84s
- Next 250: 3.75s
- Last 250: 4.65s
- Total for 1,000: 13.06s

That is not a production benchmark, but the rising batch times expose the algorithm immediately.

`append_decision` is bad precedent, not justification. It has the same global scan, but decisions are expected to be much less numerous and it does not decode/build the full fleet ID set. The proper shape is a transactional per-fleet counter, direct lookups for the few superseded IDs, and prefix/range iteration.

## 4. The budget

The budget is doubly broken.

First, `Digest::size()` does not measure characters or any serialized representation. At [digest.rs:145](crates/octos-fleet/src/digest.rs:145), it uses `str::len()`—bytes, not characters—and omits:

- JSON/rendering field names, punctuation, quoting, and escaping;
- status and task ID;
- overturn IDs;
- stale IDs and the entire drift map;
- cluster `finding_ids`;
- most numeric fields;
- `dropped`;
- watermark.

Ignored fields can be arbitrarily large, so this is not even a bounded-error estimate.

My 60-finding probe with `max_chars = 500` returned:

- `Digest::size() == 267`
- serialized JSON size: 726 bytes/characters
- only 3 new findings retained

The budget test passes because it asserts the same estimator used by the implementation at [digest.rs:625](crates/octos-fleet/src/digest.rs:625). It proves only that `size() <= max_chars` after a loop conditioned on `size()`.

Second, truncation causes permanent data loss. The watermark is set to the global maximum before trimming at [digest.rs:189](crates/octos-fleet/src/digest.rs:189). The vectors are newest-first, and `truncate` removes older pending entries at [digest.rs:315](crates/octos-fleet/src/digest.rs:315).

In the same probe:

- 57 findings were declared dropped.
- Watermark was nevertheless 60.
- Calling again with `since_seq = 60` returned zero new findings.

Those 57 findings are unrecoverable through the documented watermark protocol. “Dropped” is not sufficient without a resumable cursor or omitted sequence range.

Termination proof:

- Let `M` be the total number of elements across the five cuttable vectors.
- Every entered iteration chooses a nonempty vector and changes its length from `n` to `floor(n/2)`, so `M` strictly decreases.
- Once every vector is empty, `size()` is zero because it ignores `dropped` and watermark; `0 > max_chars` is false for every `usize`.
- Therefore it terminates.

The trailing branch at [digest.rs:346](crates/octos-fleet/src/digest.rs:346) does absolutely nothing. It is the final statement of the loop, so both taking `continue` and falling through start the next iteration. `before` and that entire branch can be deleted without changing behavior. The preceding “nothing left” `else` is also unreachable under the current `size()` definition.

## 5. Schema version

No schema bump is correct.

The discipline at the top of `records.rs` uses `SCHEMA_VERSION` for persisted row-shape compatibility. Adding a new table does not change the shape of any existing row:

- A new binary creates the missing table at [store.rs:210](crates/octos-fleet/src/store.rs:210).
- An old binary ignores the unknown table.
- Existing v3 rows remain readable.
- New `Finding` rows are stamped v3 and future versions can use the same higher-version probe.

The higher-version-row test validates the probe, not the no-bump decision, but the decision itself is sound.

## 6. Tests

There are 16 new tests, not 15: seven in `store.rs` and nine in `digest.rs`. The first commit’s message says six while actually adding seven.

Several tests genuinely constrain small mechanics: persistence across reopen, future-row filtering, single dangling-reference rejection, enum/config round trips, stale detection, and basic supersession filtering.

The important claims are not constrained:

- The headline test is a tautology. Its fixture directly assigns `"adapter-resource-id"` to both desired paths at [digest.rs:403](crates/octos-fleet/src/digest.rs:403), and the implementation groups exact component strings. The supposed root-cause conclusion is already encoded in the fixture. There is no controller, producer, normalization, transcript boundary, or synthesis decision in the test.
- The component field is not normalized, so `"adapter-resource-id"`, `"adapter resource id"`, and `"AdapterResourceId"` never cluster. The fixture hides the hard part.
- The budget test is self-referential and misses actual serialization.
- The zero-budget test passes while the serialized digest necessarily exceeds zero because `dropped` and watermark remain.
- The watermark test uses an unlimited budget, so it misses permanent loss after truncation.
- Every digest fixture is sequence-sorted. Public `digest()` never sorts; it just reverses input. A probe with input sequences `[3,1,2]` produced `["f-2","f-1","f-3"]`, violating “newest first.”
- There is no concurrent finding append test.
- There is no stale/cancelled-attempt test, missing-fleet/task test, retry/idempotency test, double-supersession test, or confirmed-without-evidence/config rejection test.
- Neither new API has a production caller anywhere on this branch. The alleged acceptance criterion cannot be end-to-end.

## Verified

- Read the full `origin/main...HEAD` diff and all production/test references to findings and digest.
- Read the relevant fleet ADR/spec; neither defines the missing finding lifecycle policy.
- Read the pinned redb 2.6.3 transaction implementation.
- Ran `cargo test -p octos-fleet`: **114 passed, 0 failed, 0 ignored; doc tests 0** in 10.62s.
- Ran separate probes for concurrent append, orphan/stale validation gaps, serialization size, watermark resumption, unordered input, and append scaling.
- The repository worktree remains clean.

## Could not verify

- An actual controller/rendering contract: neither `append_finding` nor `digest()` is wired into production code.
- A production-scale breakpoint: there is no expected row count, SLA, row-size distribution, or release benchmark. The debug timing is indicative only.
- Crash/power-loss behavior via fault injection. Transaction atomicity was verified from redb’s implementation and normal execution, not process-kill testing.
- Whether multiple concurrent superseders or post-cancellation findings are intentionally allowed; no finding contract exists in the fleet spec. The current commit nevertheless claims safety without defining that policy.
