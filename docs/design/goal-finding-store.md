# The finding store — what a goal actually needs

Status: design, revised. §§0–5 are the original argument; §6 places it in the accepted
roadmap (ADR step 2) and §7 corrects two conclusions after reading the source. The
companion swarm/fleet merge plan is **drawered** — see
[`swarm-fleet-merge.md`](swarm-fleet-merge.md).

Follows the requirements derived in conversation from
[`A2OH/westlake-piercing`](https://github.com/A2OH/westlake-piercing), whose
`docs/agent-memory/` is a hand-built version of everything below.

The prior rounds of this discussion argued about **who executes** — `WorkerKind` versus
`WorkerGrant`, which crate owns the lease. That was the wrong axis. The Android→OHOS port
does not lack executors. It lacks a place to put what it learns.

This document specifies three things, in the order they have to exist:

1. the **finding** — the durable unit of learning
2. the **frontier** — the shape of an exploration that is not a DAG
3. the **digest** — what the master reads instead of transcripts

---

## 0. Why the plan abstraction does not fit

`DurablePlan` + `deps` assumes the tasks are known at plan time and that a task ends
`Accepted` or `Rejected`. The wall map violates both on its first screen:

- Walls **#7 (Resources/drawables)** and **#8 (Room/SQLite)** are marked `PREDICTED` —
  asserted from source analysis before anyone confirmed they exist.
- Wall **#6** was cleared by two fixes in two different binaries, and the first attempt
  targeted the wrong one: *"the launch re-parse runs in the BRIDGE; that was the
  wrong-`.so` trap."*
- Then the highest-value output in the document **re-parents the walls**:

  > the remaining walls cluster into ~3 ROOT efforts (not N empirical walls) … (A) Adapter
  > resource-ID / AXML resolution → clears #6 (theme) AND #7 (drawables) together

A plan cannot express "these three tasks turned out to be one task." That is not a
scheduling event; it is a change in the understanding of the problem, and it is the thing
the master exists to produce.

So: **findings are primary, the frontier is a view over them, and the plan is downstream of
both.**

---

## 1. The finding

```
Finding {
  id
  claim          // one falsifiable sentence, scoped to a configuration
  status         // confirmed | predicted | ruled_out | superseded
  confidence     // for `predicted` only: what would confirm or kill it

  evidence[]     // log lines, commit hashes, captures, device state — never prose alone
  config         // the build state the claim holds under
  path           // which exploration produced it
  component      // what the claim is *about* — the clustering key

  supersedes[]   // findings this one overturns
  cost           // what it took to learn: wall-clock, tokens, device cycles
  by, at
}
```

### `status: ruled_out` is a first-class result, not an absence

The store is worth building mostly because of these. From `docs/agent-memory/`:

- `battery-power-not-relevant.md`
- `catalog-badboot-is-fontconfig-not-aeskeygenprobe.md`
- *"NOT libapk_installer.so — the launch re-parse runs in the BRIDGE"*
- *"the hijack is in **libhwui** … NOT liboh_adapter_bridge.so; I'd guessed wrong"*

Every one of those cost real time and every one prevents a repeat. `ChildResultSnapshot {
output: String, success: bool }` discards all of it — a failed attempt and a *proven dead
end* are the same row.

A ruled-out finding needs the **same evidence discipline** as a confirmed one. Without it,
"we tried X and it didn't work" becomes noise that nobody trusts and everybody re-runs.

### `config` is not metadata

Every conclusion in the wall map is stamped: `libart 56f3caea`, `bridge 7446144d`,
`adapter-runtime-bcp 848f414e`, `installer 3d4d9d5f`. A finding without the build state it
holds under is not a weaker finding — it is an untrustworthy one, because the next agent
cannot tell whether it still applies.

This also gives the store its invalidation rule: when a component version changes, findings
scoped to the old version become **stale, not wrong** — a third state the reader must see.

### `supersedes` is what stops the store rotting

*"I'd guessed wrong"* has to be expressible. Without an explicit overturn edge, a knowledge
base accumulates contradictions and readers learn to distrust it, at which point it is worse
than nothing.

### `claim` must be falsifiable and scoped

Not "EGL is broken". This:

> A second `eglCreateWindowSurface` on a reused OH ProducerSurface returns `EGL_NO_SURFACE`,
> under bridge `7446144d`, when a relayout drops and re-creates the surface.

The test of a good claim: another agent can attempt to falsify it without asking anyone a
question.

---

## 2. The frontier

Not a DAG. Two layers, and the second is mutable by the master:

```
Wall {
  id, name
  status          // predicted | active | cleared | ruled_out
  position        // where in the natural sequence (startup path, boot order, …)
  blocked_by[]    // other walls, or an external gate
  root            // → Root.id, reassignable
  next_action     // ONE line. the single cheapest next step
}

Root {
  id, name        // a hypothesis that several walls share a cause
  walls[]
  leverage        // how many walls it clears
  rationale       // why the master believes they cluster
}
```

Three properties a plan does not have:

**Walls are discovered.** `PREDICTED` is a legitimate starting state. A wall can be created
from source analysis before anything runs, and can dissolve without ever being worked —
which is exactly what happens to #7 if root (A) lands.

**Roots are created after the fact and re-parent walls.** This is the master's synthesis
move, and it must be a first-class, recorded, reversible edit — not a re-plan that discards
history.

**Order of discovery ≠ order of work.** The walls are numbered along noice's startup path.
The work order is by leverage: *"(A) first (highest leverage + unblocks the visible
splash)"*. Two orderings over one set, both needed.

### External gates are a normal state

> **BUILD GATE:** libhwui is an AOSP cross-build … likely OPERATOR build

Blocking on a human with access the agent does not have is not a failure and not a timeout.
It is a parked state with a named resume condition, and it must survive restarts, because
the human may take days.

---

## 3. The digest — what the master reads

This is the requirement that decides whether a goal feature works at all. **If the master
reads transcripts, the master's context window is the ceiling on problem complexity**, and
the architect degrades into a clerk relaying between workers.

The master reads a **bounded** view, and the bound is fixed — it must not grow with the
project:

| section | content | why |
|---|---|---|
| **Frontier** | one line per active wall: status, next action, what it waits on | *"NEXT: instrument the hijack to log `eglGetError()` (1 line)"* — tiny action, huge context behind it. The master needs the action, not the context. |
| **New findings** | a diff since the last synthesis, not the corpus | the master reads what changed |
| **Contradictions** | findings that supersede or conflict with each other | the one class of thing only the master can settle |
| **Stale** | findings whose `config` no longer matches the current build | prevents acting on expired knowledge |
| **Cost vs. yield** | per path: effort spent against findings produced | the input to abandoning a path |
| **Cluster hints** | paths whose recent findings cite the same `component` | see below |

### The synthesis job is partly mechanizable

You cannot compute *"the remaining walls cluster into ~3 ROOT efforts."* That is the
insight.

But you **can** compute: *paths A and C have both cited the adapter resource-ID resolver in
their last five findings.* That is a mechanical join on `component`, and putting it in front
of the master is most of what makes the insight available. The master still decides whether
the cluster is real and what the root is.

This is the difference between a master that has to read everything to notice a pattern, and
one that is shown candidate patterns and judges them.

### The hard budget

The digest gets a fixed token budget, enforced. When it would overflow, the answer is
**compress harder or archive a path**, never *let it grow*. A digest that scales with the
project rebuilds the exact problem this design exists to solve.

---

## 4. What this does to the peer-agent question

Earlier I argued an interactive session breaks three kernel invariants: the lease gets
reaped, the budget has no `projected` count, and the hard timeout kills it.

**Durable findings demote all three.** If what matters is written out as it is learned, the
session becomes *disposable*:

- a lease expiring is a **checkpoint**, not a data loss
- the budget only has to cover *until the next finding lands*, not a whole conversation
- a timeout kills a process, not the knowledge

So the build order inverts the earlier argument. Build the finding store first and Phase 2b
gets easier, because you are no longer trying to keep a session alive. Build Phase 2b first
and you will fight the kernel's invariants to preserve something that should never have
needed preserving.

The multi-turn burden the master was carrying does not move to a worker. **It moves to
disk.**

---

## 5. Build order

*Revised after reading the source. See §7 — this is smaller than it first looked.*

1. **The finding record**, as an extension to the kernel's existing records — five fields,
   reusing `EvidenceRef` unchanged.
2. **The digest**, thin, straight over raw findings, with its token budget enforced from the
   first commit. This is the piece to get right; everything else is plumbing around it.
3. **The frontier last**, shaped by whatever the digest turns out to need — so no structure
   gets built that nothing reads.
4. **Then** peer agent as a *finding producer*, which is when the interactive session-worker
   becomes a normal feature instead of a fight.

Digest before frontier: the digest is what proves the design, the frontier is presentation.

---

## 6. Where this sits in the accepted roadmap

`docs/FLEET-RUNTIME-ADR.md` (Proposed, 2026-07-27) already decides the architecture this
document was reasoning toward, and sequences the work:

1. **Kernel v1** — shipped.
2. **Goal on *stateless* workers — the goal win.** *"Progress lives in the plan + ledger,
   not context — the goal-drift fix … Ships without the interactive-session-worker
   durability problem."*
3. Durable interactive session-worker.
4. Converge swarm + pipeline.

**This document belongs to step 2**, the current frontier. It answers one of the ADR's own
listed open questions:

> The durable plan schema — task IDs, dependencies, acceptance criteria, **decision log,
> evidence**, revision/fencing.

Two other things the ADR settles, which had been argued from scratch:

- **The peer-agent-as-`WorkerKind` question.** Option A (one pluggable worker kind) and
  option B (peers keep a separate runtime) were both considered and **rejected**. The chosen
  option C is a shared kernel with two *distinct* worker-kinds: *"Do not force a parking
  session and a one-shot batch call into a single 'worker' abstraction — that seam is the
  fault line."*
- **Whether a peer may drive fleet.** *"The owner must be an opaque, server-checked
  capability … **depth-1 still applies** unless an escalation model is added."*

---

## 7. Correction — the kernel already has two thirds of this

Read after the ADR, against `octos` at `c61c8f28`. The finding store is an **extension to
existing kernel records**, not a new subsystem:

| needed | status |
|---|---|
| `evidence[]` | ✅ `EvidenceRef { kind, locator, sha256, captured_at_ms }` — content-addressed, better than §1 specified. Produced from `AcceptanceVerdict` via `verdict_evidence()`, wired in `fleet.rs` and `worker.rs` |
| append-only log | ✅ `DecisionEntry { seq, at_ms, actor, kind, note }`, seq-ordered, called from production at `fleet.rs:642` |
| `claim` — a falsifiable assertion | ❌ nearest is `DecisionEntry.note`, free text |
| `status` — confirmed / predicted / **ruled_out** | ❌ `AcceptanceVerdict` judges a *task*, not a *claim* |
| `config` — per-component versions | ❌ |
| `component` — the clustering key | ❌ |
| `supersedes` | ❌ the log is append-only but carries no overturn edge |

So the work is **five fields**, not a store.

### A conclusion to reverse

It was argued in discussion that the finding store needs no kernel at all — append-only
writes with unique ids, so `write-temp + rename()` on the filesystem suffices, and §4's
"frontier as a view" is what removes the need for a transaction.

**That reasoning was sound but the premise was incomplete.** It was made without knowing
`EvidenceRef` and the decision log already live in redb. Splitting findings out now would
put a finding in a file and its own evidence in a database — strictly worse than either
option alone.

The filesystem argument still holds for a *greenfield* finding store. It does not hold here.
**Extend the kernel records.**

This is the third time in this design's history that reading the source moved a conclusion,
which is itself the argument for step 1 being a small PR against real code rather than more
design.

## 8. The test

Not a unit test — the acceptance criterion for the whole design:

**Could this system have produced the "~3 ROOT efforts" insight?**

That means: could a master, reading only the digest, having never seen a transcript, look at
walls #6, #7 and #8 and say *"#6 and #7 share a root, and it is the adapter's resource-ID
resolution — do that one first"*?

If yes, the goal feature is real. If it needs the master to read the raw exploration to get
there, it is not, and no amount of `WorkerKind` design will make it so.
