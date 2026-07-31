# agent-spec Node verification boundary

As of agent-spec 1.2.0 (upstream revision
`03724856ce453118915d80ee740f3a68a864ebed`), the built-in `TestVerifier`
locates a Cargo workspace and executes `cargo test`. It does not dispatch
Vitest selectors.

For hafleet:

- use agent-spec for Task Contract parsing, linting, boundary checks, lifecycle
  audit output, KLL governance, and requirement traceability;
- run each contract's exact `Test:` selectors with Vitest as separate mechanical
  evidence;
- treat lifecycle `skip` as unresolved, never as a pass;
- do not mark a requirement `proven` until the verification path can represent
  all required scenarios without skips.

This is an observed tool limitation, not permission to weaken the contract.
A future Node runner adapter should replace this temporary two-command evidence
path without changing the acceptance scenarios.
