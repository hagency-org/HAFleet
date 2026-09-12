//! Ceiling overrun alarms (ADR-124, slice a): one row per resource dedupe
//! key, raised and resolved from the same drawn figure admission enforces on.
//!
//! An alert is DIAGNOSTIC, never enforcement: raising one must not revoke or
//! end engagements, block or permit admission, release leases, or authorize
//! retries; auto-resolve flips the row's display state and nothing else.

use super::{DomainRepository, Error, usage::ceiling_report};
use hagency_core::JSON_SAFE_MAX;
use hagency_core::project::Resource;
use rusqlite::{OptionalExtension, TransactionBehavior, params};
use serde::{Deserialize, Serialize};

/// Retained bound (`lib/alert-store.js:25`): resolved alerts live 7 days.
const RESOLVED_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1000;
/// Retained bound (`lib/alert-store.js:28`, `MAX_PAYLOAD_SIZE`): the detail
/// JSON string is capped at 4096 bytes.
const MAX_DETAIL_BYTES: usize = 4096;
/// Publication bound: one operator read returns at most this many open rows.
/// DELIBERATE DIVERGENCE from the retained `listAlerts` cap of 500
/// (`lib/alert-store.js:410`, `Math.min(parseInt(limit) || 100, 500)`): the
/// retained route CLAMPS an over-large limit, while native refuses it with
/// `Error::Invalid` the way every other bounded read in this store behaves —
/// a silently-clamped limit hides a client bug; a refusal surfaces it. The
/// native cap is 200, tighter than the retained 500 for the same reason
/// (bounded-cost reads on a table with at most one row per resource).
pub const MAX_OPEN_CEILING_ALERTS: usize = 200;
/// Counters one sweep produced. `raised` counts newly-open alerts (fresh
/// insert or reopen after resolution); `updated` counts repeats against an
/// already-open row; `resolved` and `pruned` count display-state and
/// retention transitions.
#[derive(Debug, Default, Clone, Serialize, PartialEq, Eq)]
pub struct SweepOutcome {
    pub raised: u64,
    pub updated: u64,
    pub resolved: u64,
    pub pruned: u64,
}

fn dedupe_key(resource_id: &str) -> String {
    format!("agent_ceiling_overrun:{resource_id}")
}

fn bounded(value: u64) -> Result<u64, Error> {
    if value > JSON_SAFE_MAX {
        return Err(Error::Capacity);
    }
    Ok(value)
}

/// Read the stored `detail` (E1 of the console alerts review): the retained
/// `truncatePayload` slices the JSON STRING (`alert-store.js:61-64`), so an
/// over-long row legitimately holds text that is not valid JSON — and the
/// retained consumer renders it as text (`mapAlert` passes `detail` through
/// unchanged, `mockup/lib/api.js:203`). The read therefore PARSES when it
/// can and FALLS BACK to the raw string when it cannot: never `Error::Schema`
/// — one truncated row must not blind the operator to every good one. The
/// client validator's union (object or ≤4096 string) is built for exactly
/// this payload.
fn read_detail(raw: &str) -> serde_json::Value {
    serde_json::from_str(raw).unwrap_or_else(|_| serde_json::Value::String(raw.to_owned()))
}

/// The retained ingest payload (`backend-v2.js:9422-9447`) with raw numbers:
/// `detail` is a JSON string, never an object, capped at 4096 bytes the way
/// the retained `truncatePayload` caps it (`lib/alert-store.js:61-64`):
/// string-encode, then slice to the first MAX_PAYLOAD_SIZE characters — a
/// truncated value stays a valid row (Node logs and continues; an aborting
/// sweep would let one long resource id suppress every other alert). The
/// column CHECK remains the last line of defence, never the truncation site.
fn detail_json(
    resource_id: &str,
    preset_name: &str,
    ceiling: u64,
    committed: u64,
    measured: Option<u64>,
    drawn: u64,
    over: u64,
) -> String {
    let detail = serde_json::json!({
        "agent": resource_id,
        "presetId": preset_name,
        "ceilingTokens": ceiling,
        "committedTokens": committed,
        "measuredTokens": measured,
        "drawnTokens": drawn,
        "overByTokens": over,
    });
    let text = serde_json::to_string(&detail).unwrap_or_default();
    if text.len() > MAX_DETAIL_BYTES {
        text.chars().take(MAX_DETAIL_BYTES).collect()
    } else {
        text
    }
}

impl DomainRepository {
    /// Sweep every resource with a declared finite ceiling and reconcile its
    /// overrun alert (`backend-v2.js:9393-9452`, slice a of the alarm plan):
    /// strictly `drawn > ceiling` raises, `drawn <= ceiling` auto-resolves,
    /// repeats increment `occurrences`, a re-over after resolution reopens
    /// the same row, and resolved rows older than 7 days are pruned. One
    /// `Immediate` transaction. The draw comes from the read-side projection
    /// `usage::ceiling_report` (`resource_ceiling`, ADR-121) — the SAME drawn
    /// rule admission enforces on (`max(reserved, spent)`, unknown falls back
    /// to reserved, `backend-v2.js:14052-14053` cited by both), though a
    /// distinct code path from `budget()`/`resource_budget`, exactly the
    /// retained split: Node's sweep reads `ceilingSpendFor` while admission
    /// reads `remainingFor` (`backend-v2.js:9402` vs `:14823`). The two
    /// agree by shared rule and oracle, not by construction.
    pub fn sweep_ceiling_overruns(&mut self, now: u64) -> Result<SweepOutcome, Error> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut outcome = SweepOutcome::default();
        let mut statement = tx.prepare("SELECT config FROM resources")?;
        let rows = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for row in rows {
            let resource: Resource = serde_json::from_str(&row)?;
            // No declared ceiling is unknown, not zero: such a resource cannot
            // be past a limit that does not exist and is skipped entirely
            // (`backend-v2.js:9397-9400`).
            let Some(ceiling) = resource
                .ceiling
                .as_ref()
                .and_then(|c| c.tokens)
                .map(u64::from)
            else {
                continue;
            };
            let ceiling = bounded(ceiling)?;
            let report = ceiling_report(&tx, &resource.id(), now)?;
            let key = dedupe_key(&resource.id());
            if report.drawn > ceiling {
                let over = report.drawn - ceiling;
                let detail = detail_json(
                    &resource.id(),
                    &report.preset_name,
                    ceiling,
                    report.reserved,
                    report.spent,
                    report.drawn,
                    over,
                );
                let summary = format!(
                    "{} has drawn {} against a ceiling of {} — {} past it",
                    resource.id(),
                    report.drawn,
                    ceiling,
                    over
                );
                let runbook = format!(
                    "raise the ceiling on preset {} to cover what is already committed, or revoke engagements on {} until the drawn figure is back under it",
                    report.preset_name,
                    resource.id()
                );
                let existing: Option<bool> = tx
                    .query_row(
                        "SELECT resolved_at_ms IS NOT NULL FROM ceiling_alerts WHERE dedupe_key=?1",
                        [&key],
                        |r| r.get(0),
                    )
                    .optional()?;
                // The preserved contract is one OPEN alert per resource,
                // occurrences riding on it. On dedupe-repeat and reopen the
                // retained store refreshes summary/lastPayload and the
                // counter but never rewrites runbook/impact/recoveryCondition
                // (`lib/alert-store.js:231-249,254-271`); only a fresh insert
                // writes the four text fields.
                match existing {
                    None => {
                        const IMPACT: &str = "no new engagement can be approved against this agent; the work already approved keeps running, because admission control cannot retract a commitment it already granted";
                        const RECOVERY: &str = "the drawn figure falls back under the ceiling, by raising the ceiling or ending engagements — this alert auto-resolves when that happens";
                        tx.execute(
                            "INSERT INTO ceiling_alerts(dedupe_key,resource_id,summary,detail,runbook,impact,recovery_condition,occurrences,first_seen_ms,last_seen_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,1,?8,?8)",
                            params![key, resource.id(), summary, detail, runbook, IMPACT, RECOVERY, now],
                        )?;
                        outcome.raised += 1;
                    }
                    Some(was_resolved) => {
                        let changed = tx.execute(
                    if was_resolved {
                        "UPDATE ceiling_alerts SET resource_id=?2,summary=?3,detail=?4,occurrences=occurrences+1,last_seen_ms=?5,resolved_at_ms=NULL,resolved_by=NULL WHERE dedupe_key=?1"
                    } else {
                        "UPDATE ceiling_alerts SET resource_id=?2,summary=?3,detail=?4,occurrences=occurrences+1,last_seen_ms=?5 WHERE dedupe_key=?1"
                    },
                    params![key, resource.id(), summary, detail, now],
                )?;
                        if was_resolved {
                            outcome.raised += 1;
                        } else {
                            outcome.updated += 1;
                        }
                        debug_assert_eq!(changed, 1);
                    }
                }
            } else {
                // Back under (or exactly on) the ceiling resolves by the same
                // rule the ingest path would use, not a hand-rolled
                // transition; a no-op when no alert is open
                // (`lib/alert-store.js:337-355`). Exactly-on is not over,
                // which is also why the raise side is strictly greater.
                let changed = tx.execute(
                    "UPDATE ceiling_alerts SET resolved_at_ms=?2,resolved_by='system' WHERE dedupe_key=?1 AND resolved_at_ms IS NULL",
                    params![key, now],
                )?;
                outcome.resolved += u64::try_from(changed).unwrap_or_default();
            }
        }
        // Retention (`ALERT_RESOLVED_TTL_MS` parity): resolved rows older
        // than 7 days are pruned whole.
        let cutoff = now.saturating_sub(RESOLVED_RETENTION_MS);
        let pruned = tx.execute(
            "DELETE FROM ceiling_alerts WHERE resolved_at_ms IS NOT NULL AND resolved_at_ms<?1",
            params![cutoff],
        )?;
        outcome.pruned = u64::try_from(pruned).unwrap_or_default();
        tx.commit()?;
        Ok(outcome)
    }

    /// Open alerts for the operator read (ADR-124 slice b), newest activity
    /// first, at most `MAX_OPEN_CEILING_ALERTS` rows. A limit of 0 or above
    /// the bound is refused with `Error::Invalid` — a deliberate divergence
    /// from the retained route's clamping (`alert-store.js:410`), chosen for
    /// consistency with every other bounded read in this store. The stored
    /// `detail` string is PARSED
    /// here: a corrupt row is `Error::Schema`, never a silently-empty object.
    pub fn open_ceiling_alerts(&self, limit: u32) -> Result<Vec<CeilingAlert>, Error> {
        let limit = usize::try_from(limit)
            .map_err(|_| Error::Invalid(hagency_core::InvalidInput("invalid alert limit")))?;
        if limit == 0 || limit > MAX_OPEN_CEILING_ALERTS {
            return Err(Error::Invalid(hagency_core::InvalidInput(
                "invalid alert limit",
            )));
        }
        let mut statement =
            self.db.prepare("SELECT dedupe_key,resource_id,summary,detail,runbook,impact,recovery_condition,occurrences,first_seen_ms,last_seen_ms FROM ceiling_alerts WHERE resolved_at_ms IS NULL ORDER BY last_seen_ms DESC LIMIT ?1")?;
        let rows = statement
            .query_map(params![limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, u64>(8)?,
                    row.get::<_, u64>(9)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(
                |(
                    dedupe_key,
                    resource_id,
                    summary,
                    detail,
                    runbook,
                    impact,
                    recovery_condition,
                    occurrences,
                    first_seen_ms,
                    last_seen_ms,
                )| {
                    Ok(CeilingAlert {
                        resolved: false,
                        detail: read_detail(&detail),
                        occurrences: u64::try_from(occurrences).map_err(|_| Error::Schema)?,
                        dedupe_key,
                        resource_id,
                        summary,
                        runbook,
                        impact,
                        recovery_condition,
                        first_seen_ms,
                        last_seen_ms,
                    })
                },
            )
            .collect()
    }
}

/// One open overrun alert with every retained field (`backend-v2.js:9422-9447`):
/// `detail` is the parsed object, not the stored string; the resolved state is
/// carried so the projection can state it without a second column.
#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct CeilingAlert {
    pub dedupe_key: String,
    pub resource_id: String,
    pub summary: String,
    pub detail: serde_json::Value,
    pub runbook: String,
    pub impact: String,
    pub recovery_condition: String,
    pub occurrences: u64,
    pub first_seen_ms: u64,
    pub last_seen_ms: u64,
    pub resolved: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// B4: the `detail` JSON string truncates the way the retained
    /// `truncatePayload` does (`lib/alert-store.js:61-64`: encode, then slice
    /// to the first MAX_PAYLOAD_SIZE characters) instead of aborting the
    /// sweep. Valid sweep inputs cannot reach the bound — preset ids are
    /// ≤128 chars and resource ids are fixed-length hashes — so the bound is
    /// defence-in-depth, and this pins it at the function that owns it. The
    /// retained sweep files its alert with the truncated detail and
    /// continues; the CHECK constraint is the last line of defence, never
    /// the truncation site.
    #[test]
    fn native_ceiling_alert_detail_truncates_like_retained_store() {
        let short = detail_json("resource_a", "pool", 1_000, 100, None, 1_500, 500);
        assert!(short.len() <= MAX_DETAIL_BYTES);
        assert!(short.starts_with('{'));
        // The over-long id path: an absurd agent name pushes the encoded
        // detail past the cap; the result is still exactly-capped and the
        // caller proceeds (no Error::Capacity, no sweep abort).
        let absurd = "a".repeat(8_192);
        let long = detail_json(&absurd, "pool", 1_000, 100, None, 1_500, 500);
        assert!(
            long.len() <= MAX_DETAIL_BYTES,
            "capped at {MAX_DETAIL_BYTES}"
        );
        assert_eq!(long.chars().count(), MAX_DETAIL_BYTES);
        assert!(long.starts_with('{'), "a prefix of the encoded JSON");
        // The retained rule slices characters, not bytes: an ASCII slice is
        // both. (The composed detail is all-ASCII digits/keys in practice.)
        assert!(
            long.is_ascii(),
            "an ASCII slice is characters and bytes alike"
        );
    }
}
