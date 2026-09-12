mod common;
use common::*;
use hagency_core::project::Resource;
use hagency_core::tasks::*;
use hagency_metering::{Framework, observation::UsageObservation};
use hagency_store::{DomainRepository, EffectOutcome, Error, SweepOutcome};
use rusqlite::{Connection, OptionalExtension};
use serde_json::json;
use std::path::PathBuf;

/// JSON-safe generous ceiling: `Tokens` refuses anything above JSON_SAFE_MAX,
/// so an unrepresentable "infinite" figure would panic at deserialization.
const GENEROUS: u64 = 9_000_000_000_000_000;

/// Compact alarm fixture: one resource, optional approved engagement, and
/// the dispatch machinery needed to bind a usage source and measure it.
struct Alarm {
    root: tempfile::TempDir,
    db: DomainRepository,
}

fn open(framework: Framework, ceiling: u64) -> Alarm {
    let root = tempfile::tempdir().unwrap();
    let mut db = DomainRepository::open(&root.path().join("state")).unwrap();
    db.register(&registration()).unwrap();
    let mut pool = resource("alarm_pool", "alarm_seat", ceiling);
    if framework == Framework::Claude {
        pool.framework = "claude".into();
        pool.model = "claude-sonnet-5".into();
        pool.reasoning = None;
    }
    db.put_resource(&pool).unwrap();
    Alarm { root, db }
}

/// The ceiling the sweep must see; the engagement is made at a generous
/// ceiling first (the retained commit-then-lower flow) so approve itself
/// succeeds — an overrun exists precisely because a ceiling was lowered
/// under commitments that were admissible when made.
fn set_ceiling(alarm: &mut Alarm, framework: Framework, ceiling: u64) {
    let mut pool = resource("alarm_pool", "alarm_seat", ceiling);
    if framework == Framework::Claude {
        pool.framework = "claude".into();
        pool.model = "claude-sonnet-5".into();
        pool.reasoning = None;
    }
    alarm.db.put_resource(&pool).unwrap();
}

fn engaged(alarm: &mut Alarm, id: &str, tokens: u64, at: u64) -> String {
    let pool = resource("alarm_pool", "alarm_seat", GENEROUS);
    let ask = request(id, "Worker", &pool, tokens);
    let proof = proof(&ask);
    alarm.db.admit(&proof, at).unwrap();
    alarm
        .db
        .approve(&format!("approve_{id}"), &proof, at)
        .unwrap();
    // A usage source needs an active engagement: apply the approval effect
    // exactly as the usage fixture does (tests/usage.rs), otherwise session
    // registration is refused as runner authority.
    let effect = alarm.db.claim_effect().unwrap().unwrap();
    alarm
        .db
        .observe_effect(
            &effect.id,
            effect.fence,
            &EffectOutcome::Applied {
                receipt: "offline fixture".into(),
            },
        )
        .unwrap();
    ask.engagement_id().unwrap()
}

fn record(alarm: &mut Alarm, engagement: &str, observation: &UsageObservation, at: u64) {
    let session = "alarm_session_1";
    alarm
        .db
        .register_session(&SessionBinding {
            id: session.into(),
            engagement_id: engagement.into(),
            room_id: "!project:example.test".into(),
            thread_root: Some("$alarm_thread".into()),
        })
        .unwrap();
    alarm
        .db
        .create_canonical_task(session, session, "Observe usage", at)
        .unwrap();
    alarm.db.register_workspace(session).unwrap();
    alarm
        .db
        .enqueue_dispatch(&DispatchInput {
            id: session.into(),
            session_id: session.into(),
            task_id: Some(session.into()),
            resources: vec![ResourceLease {
                id: session.into(),
                exclusive: true,
            }],
            payload: json!({"untrusted_agent_hint":"someone else"}),
        })
        .unwrap();
    let cap = alarm
        .db
        .claim_dispatch("alarm_runner", at, 60000, 120000, 128)
        .unwrap()
        .unwrap();
    let scope = alarm.db.owned_dispatch_scope(&cap, at + 1).unwrap();
    let started = alarm
        .db
        .start_owned_dispatch(&cap, scope.fingerprint(), at + 2)
        .unwrap();
    let source = alarm.db.bind_usage_source(&cap, &started, at + 3).unwrap();
    alarm
        .db
        .record_usage_observation(&source, "alarm_call", observation, at + 4)
        .unwrap();
}

fn claude(input: u64, output: u64, write: u64, read: u64) -> UsageObservation {
    UsageObservation::parse(
        Framework::Claude,
        &json!({"uuid":"message","message":{"usage":{"input_tokens":input,"output_tokens":output,"cache_creation_input_tokens":write,"cache_read_input_tokens":read}}}).to_string(),
    )
    .unwrap()
}

/// Direct row read: the sweep's outcome counts come back typed, and the row
/// contents are inspected exactly the way retained tests read the API body.
/// (summary, detail, runbook, impact, occurrences, resolved_at_ms, resolved_by)
type AlertRow = (
    String,
    String,
    String,
    String,
    i64,
    Option<u64>,
    Option<String>,
);

fn row(alarm: &Alarm) -> Option<AlertRow> {
    let sql = Connection::open(state_path(alarm)).unwrap();
    sql.query_row(
        "SELECT summary,detail,runbook,impact,occurrences,resolved_at_ms,resolved_by FROM ceiling_alerts",
        [],
        |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, Option<u64>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        },
    )
    .optional()
    .unwrap()
}

fn state_path(alarm: &Alarm) -> PathBuf {
    alarm.root.path().join("state/domain.sqlite3")
}

/// THE RETAINED CONTRACT (`tests/api-ceiling-overrun-alarm.test.js:86`):
/// committed 1.5M then ceiling lowered to 1M → one alert whose four
/// actionable fields are all present — which is exactly what makes it a
/// WARNING rather than a note (`buildActionability`, alert-store.js:102-138);
/// a port missing any field would file an `info` nobody pages on.
#[test]
fn native_ceiling_alert_sweep_files_warning_with_actionable_fields() {
    let mut alarm = open(Framework::Codex, GENEROUS);
    engaged(&mut alarm, "overcommit", 1_500_000, 1000);
    set_ceiling(&mut alarm, Framework::Codex, 1_000_000);
    let outcome = alarm.db.sweep_ceiling_overruns(1_000_000).unwrap();
    assert_eq!(
        outcome,
        SweepOutcome {
            raised: 1,
            updated: 0,
            resolved: 0,
            pruned: 0
        }
    );
    let (summary, detail, runbook, impact, occurrences, resolved_at, resolved_by) =
        row(&alarm).expect("one open alert");
    assert!(summary.contains("has drawn 1500000 against a ceiling of 1000000"));
    assert!(summary.contains("500000 past it"));
    assert!(runbook.contains("raise the ceiling on preset alarm_pool"));
    assert!(runbook.contains("revoke engagements on resource_"));
    assert!(impact.contains("no new engagement can be approved"));
    assert!(impact.contains("cannot retract a commitment it already granted"));
    assert_eq!(occurrences, 1);
    assert!(resolved_at.is_none() && resolved_by.is_none());
    // detail is a JSON STRING (retained storage shape) with the raw numbers.
    let detail: serde_json::Value = serde_json::from_str(&detail).unwrap();
    assert_eq!(detail["committedTokens"], 1_500_000);
    assert_eq!(detail["measuredTokens"], serde_json::Value::Null);
    assert_eq!(detail["drawnTokens"], 1_500_000);
    assert_eq!(detail["overByTokens"], 500_000);
    assert_eq!(detail["ceilingTokens"], 1_000_000);
    // An alert is diagnostic, never enforcement (ADR-124): with the alert
    // open, admission still refuses by its own rule and nothing else moved.
    let pool = resource("alarm_pool", "alarm_seat", 1_000_000);
    // A distinct agent name: a live engagement named "Worker" already holds
    // this project, and admit refuses a name collision before any ceiling rule.
    let ask = request("post_alert", "PostAlert", &pool, 1_000_000);
    alarm.db.admit(&proof(&ask), 1000).unwrap();
    assert!(matches!(
        alarm.db.approve("approve_post_alert", &proof(&ask), 1000),
        Err(Error::OverCommit { .. })
    ));
}

/// The mutant-killer (`:122`): 1.2M FRESH tokens against a 1M ceiling,
/// cacheRead deliberately huge and excluded. `drawn` must be the fresh
/// figure, never the committed-only figure and never the four-kind total.
/// The retained seed commits zero; a native usage source requires a holding
/// engagement, so committed is the fixture's own 1 and the assertion pins
/// drawn/measured/over — the properties that kill both mutants.
#[test]
fn native_ceiling_alert_measured_over_raises_with_nothing_committed() {
    let mut alarm = open(Framework::Claude, GENEROUS);
    let engagement = engaged(&mut alarm, "measured", 1, 1000);
    record(
        &mut alarm,
        &engagement,
        &claude(900_000, 250_000, 50_000, 9_000_000),
        2000,
    );
    set_ceiling(&mut alarm, Framework::Claude, 1_000_000);
    let outcome = alarm.db.sweep_ceiling_overruns(1_000_000).unwrap();
    assert_eq!(outcome.raised, 1);
    let (_, detail, _, _, _, _, _) = row(&alarm).unwrap();
    let detail: serde_json::Value = serde_json::from_str(&detail).unwrap();
    assert_eq!(detail["measuredTokens"], 1_200_000);
    assert_eq!(detail["drawnTokens"], 1_200_000);
    assert_eq!(detail["overByTokens"], 200_000);
    assert_eq!(detail["committedTokens"], 1);
}

/// Inside (`:179`) and exactly ON (`:187`) raise nothing: `>=` would page an
/// operator whose configuration is exactly right.
#[test]
fn native_ceiling_alert_inside_and_on_boundary_raise_nothing() {
    let mut inside = open(Framework::Codex, GENEROUS);
    engaged(&mut inside, "inside", 500_000, 1000);
    set_ceiling(&mut inside, Framework::Codex, 2_000_000);
    let outcome = inside.db.sweep_ceiling_overruns(1_000_000).unwrap();
    assert_eq!(
        outcome,
        SweepOutcome {
            raised: 0,
            updated: 0,
            resolved: 0,
            pruned: 0
        }
    );
    assert!(row(&inside).is_none());
    let mut exact = open(Framework::Codex, GENEROUS);
    engaged(&mut exact, "exact", 1_000_000, 1000);
    set_ceiling(&mut exact, Framework::Codex, 1_000_000);
    let outcome = exact.db.sweep_ceiling_overruns(1_000_000).unwrap();
    assert_eq!(outcome.raised, 0);
    assert!(row(&exact).is_none());
}

/// Raising the ceiling back resolves without an operator closing anything
/// (`:199`): `resolved_by = 'system'`, same-row transition.
#[test]
fn native_ceiling_alert_resolves_when_draw_falls_back_under() {
    let mut alarm = open(Framework::Codex, GENEROUS);
    engaged(&mut alarm, "resolve_me", 1_500_000, 1000);
    set_ceiling(&mut alarm, Framework::Codex, 1_000_000);
    alarm.db.sweep_ceiling_overruns(1_000_000).unwrap();
    set_ceiling(&mut alarm, Framework::Codex, 2_000_000);
    let outcome = alarm.db.sweep_ceiling_overruns(4_600_000).unwrap();
    assert_eq!(outcome.resolved, 1);
    let (_, _, _, _, _, resolved_at, resolved_by) = row(&alarm).unwrap();
    assert_eq!(resolved_at, Some(4_600_000));
    assert_eq!(resolved_by.as_deref(), Some("system"));
}

/// One alert per resource however many times the sweep runs (`:233`): the
/// repeat count rides ON the row (occurrences), never a second row.
#[test]
fn native_ceiling_alert_dedupes_across_repeated_sweeps() {
    let mut alarm = open(Framework::Codex, GENEROUS);
    engaged(&mut alarm, "dedupe_me", 1_500_000, 1000);
    set_ceiling(&mut alarm, Framework::Codex, 1_000_000);
    let mut total = SweepOutcome::default();
    for at in [1_000_000u64, 4_600_000, 8_200_000] {
        let outcome = alarm.db.sweep_ceiling_overruns(at).unwrap();
        total.raised += outcome.raised;
        total.updated += outcome.updated;
    }
    assert_eq!(total.raised, 1);
    assert_eq!(total.updated, 2);
    let sql = Connection::open(state_path(&alarm)).unwrap();
    let (count, occurrences): (i64, i64) = sql
        .query_row(
            "SELECT COUNT(*), MAX(occurrences) FROM ceiling_alerts",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(count, 1);
    assert_eq!(occurrences, 3);
    // B3 sentinel: the retained store never rewrites the four text fields on
    // dedupe/reopen (`alert-store.js:231-249,254-271` update summary,
    // lastPayload, occurrences — not runbook/impact/recoveryCondition). Plant
    // a sentinel runbook, sweep twice more, and assert it survived: an UPDATE
    // that rewrote runbook would restore the composed wording and fail here.
    drop(sql);
    let sql = Connection::open(state_path(&alarm)).unwrap();
    sql.execute(
        "UPDATE ceiling_alerts SET runbook='sentinel_runbook_unmodified'",
        [],
    )
    .unwrap();
    drop(sql);
    alarm.db.sweep_ceiling_overruns(11_800_000).unwrap();
    let sql = Connection::open(state_path(&alarm)).unwrap();
    let (runbook, occurrences): (String, i64) = sql
        .query_row("SELECT runbook, occurrences FROM ceiling_alerts", [], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .unwrap();
    drop(sql);
    assert_eq!(runbook, "sentinel_runbook_unmodified");
    assert_eq!(occurrences, 4);
}

/// No declared ceiling is unknown, not zero (`:220`): such a resource is
/// skipped entirely rather than reported as past a limit nobody chose.
#[test]
fn native_ceiling_alert_no_ceiling_resource_is_skipped() {
    let root = tempfile::tempdir().unwrap();
    let mut db = DomainRepository::open(&root.path().join("state")).unwrap();
    db.register(&registration()).unwrap();
    let ceilingless: Resource = serde_json::from_value(
        json!({"presetId":"no_ceiling","seatId":"seat_nc","framework":"codex","model":"gpt-5.6-sol","reasoning":"medium"}),
    )
    .unwrap();
    db.put_resource(&ceilingless).unwrap();
    let outcome = db.sweep_ceiling_overruns(1_000_000).unwrap();
    assert_eq!(outcome, SweepOutcome::default());
    let sql = Connection::open(root.path().join("state/domain.sqlite3")).unwrap();
    let count: i64 = sql
        .query_row("SELECT COUNT(*) FROM ceiling_alerts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 0);
}

/// Oracle replay: the fixture's sweep vectors (computed by the retained
/// JavaScript pinned by sha256) against the native store, plus the
/// reopen-after-resolution transition. Commit-then-lower is the flow every
/// commitment-based vector uses; the month-rollover vector pins
/// unknown-not-zero — a new unmeasured period falls back to reserved and the
/// closed period's overrun resolves.
#[test]
fn native_ceiling_alerts_match_javascript() {
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/ceiling-vectors.json")).unwrap();
    for vector in fixture["sweeps"].as_array().unwrap() {
        let name = vector["name"].as_str().unwrap();
        if name == "no-ceiling" {
            // No declared ceiling: skipped, nothing materialized.
            let root = tempfile::tempdir().unwrap();
            let mut db = DomainRepository::open(&root.path().join("state")).unwrap();
            db.register(&registration()).unwrap();
            let ceilingless: Resource = serde_json::from_value(
                json!({"presetId":"no_ceiling","seatId":"seat_nc","framework":"codex","model":"gpt-5.6-sol","reasoning":"medium"}),
            )
            .unwrap();
            db.put_resource(&ceilingless).unwrap();
            assert_eq!(db.sweep_ceiling_overruns(1_000_000).unwrap().raised, 0);
            continue;
        }
        let ceiling = vector["ceilingTokens"].as_u64().unwrap();
        let reserved = vector["reserved"].as_u64().unwrap();
        let measured = vector["spent"].as_u64();
        let framework = if measured.is_some() {
            Framework::Claude
        } else {
            Framework::Codex
        };
        let mut alarm = open(framework, GENEROUS);
        // The retained seed may commit zero, but a native usage source needs a
        // holding engagement and a scoped request never asks for zero tokens;
        // one committed token leaves the drawn rule (max of reserved and
        // measured) and every expected sweep state unchanged.
        let engagement = engaged(&mut alarm, &format!("oracle_{name}"), reserved.max(1), 1000);
        if let Some(spent) = measured {
            record(
                &mut alarm,
                &engagement,
                &claude(spent, 0, 0, 9_000_000),
                2000,
            );
        }
        set_ceiling(&mut alarm, framework, ceiling);
        for state in vector["expected"]["states"].as_array().unwrap() {
            let at = state["at"].as_u64().unwrap();
            let outcome = alarm.db.sweep_ceiling_overruns(at).unwrap();
            assert_eq!(
                outcome.raised,
                state["raised"].as_u64().unwrap(),
                "{name}@{at}"
            );
            assert_eq!(
                outcome.updated,
                state["updated"].as_u64().unwrap(),
                "{name}@{at}"
            );
            assert_eq!(
                outcome.resolved,
                state["resolved"].as_u64().unwrap(),
                "{name}@{at}"
            );
        }
        let final_row = &vector["expected"]["finalRow"];
        match row(&alarm) {
            None => assert!(final_row.is_null(), "{name}"),
            Some((_, _, _, _, occurrences, resolved_at, resolved_by)) => {
                assert_eq!(
                    u64::try_from(occurrences).unwrap(),
                    final_row["occurrences"].as_u64().unwrap(),
                    "{name}"
                );
                assert_eq!(
                    resolved_at.is_some(),
                    !final_row["resolvedAt"].is_null(),
                    "{name}"
                );
                if final_row["resolvedBy"].is_string() {
                    assert_eq!(resolved_by.as_deref(), Some("system"), "{name}");
                }
            }
        }
    }
    // Reopen after resolution (the retained store's :254-271 window, here as
    // the same-row reopen the ADR records): over → resolve → over again.
    let mut alarm = open(Framework::Codex, GENEROUS);
    engaged(&mut alarm, "reopen", 1_500_000, 1000);
    set_ceiling(&mut alarm, Framework::Codex, 1_000_000);
    alarm.db.sweep_ceiling_overruns(1_000_000).unwrap();
    set_ceiling(&mut alarm, Framework::Codex, 2_000_000);
    alarm.db.sweep_ceiling_overruns(2_000_000).unwrap();
    set_ceiling(&mut alarm, Framework::Codex, 1_000_000);
    let outcome = alarm.db.sweep_ceiling_overruns(3_000_000).unwrap();
    assert_eq!(outcome.raised, 1, "re-over reopens the same row");
    let sql = Connection::open(state_path(&alarm)).unwrap();
    let (count, occurrences, resolved): (i64, i64, i64) = sql
        .query_row(
            "SELECT COUNT(*), occurrences, resolved_at_ms IS NULL FROM ceiling_alerts",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!((count, occurrences, resolved), (1, 2, 1));
}
