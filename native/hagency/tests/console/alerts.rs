use super::*;
use hagency_store::MAX_OPEN_CEILING_ALERTS;

/// The console alerts read: the same authority matrix the usage console test
/// applies (session exchange required; anonymous, forged cookie, and foreign
/// headers refused), the bounded limit (0 and above the cap refused, default
/// accepted), and the busy mapping carried from the store.
#[tokio::test]
async fn native_console_alerts_read() {
    let f = Fixture::new("127.0.0.1:13300".parse().unwrap(), None);
    let service = f.service();
    let anonymous = TestClient::get(format!("{BASE}/console/api/alerts"))
        .add_header("host", "127.0.0.1:13300", true)
        .send(&service)
        .await;
    assert_eq!(anonymous.status_code, Some(StatusCode::UNAUTHORIZED));
    let cookie = session(&service).await;
    for (name, value) in [
        ("host", "evil.test"),
        ("origin", "https://evil.test"),
        ("sec-fetch-site", "cross-site"),
        ("x-forwarded-for", "127.0.0.1"),
        ("cookie", "hagency_console=bad"),
        ("cookie", &format!("{cookie}; {cookie}")),
    ] {
        let response = get("/console/api/alerts", &cookie)
            .add_header(name, value, true)
            .send(&service)
            .await;
        assert!(matches!(
            response.status_code,
            Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        ));
    }
    // Foreign query parameters and an encoded payload are refused, as usage.
    for query in [
        "?limit=0",
        "?limit=201",
        "?limit=bad",
        "?after=x",
        "?limit=%31",
        "?limit=1&limit=2",
    ] {
        let response = get(&format!("/console/api/alerts{query}"), &cookie)
            .send(&service)
            .await;
        assert_eq!(
            response.status_code,
            Some(StatusCode::BAD_REQUEST),
            "{query}"
        );
    }
    // Default (no query), explicit default, and the cap boundary read fine.
    for query in [
        "",
        "?limit=100",
        "?limit=1",
        &format!("?limit={MAX_OPEN_CEILING_ALERTS}"),
    ] {
        let mut response = get(&format!("/console/api/alerts{query}"), &cookie)
            .send(&service)
            .await;
        assert_eq!(response.status_code, Some(StatusCode::OK), "{query}");
        let value = response.take_json::<Value>().await.unwrap();
        assert_eq!(
            value["alerts"].as_array().map(Vec::len),
            Some(1),
            "the seeded overrun publishes once"
        );
        assert!(value["at_ms"].as_u64().unwrap() > 0);
    }
    f.close().await;
}

/// The fixture's seeded overrun (commit 100 under a generous ceiling, lowered
/// to 50, swept at 2000) publishes with every field the client validator
/// demands; a resolved alert is absent from the read.
#[tokio::test]
async fn native_console_alerts_fixture_publishes_open_alerts() {
    let f = Fixture::new("127.0.0.1:13300".parse().unwrap(), None);
    let service = f.service();
    let cookie = session(&service).await;
    let mut response = get("/console/api/alerts", &cookie).send(&service).await;
    assert_eq!(response.status_code, Some(StatusCode::OK));
    assert_eq!(response.headers().get("cache-control").unwrap(), "no-store");
    let value = response.take_json::<Value>().await.unwrap();
    let alerts = value["alerts"].as_array().unwrap();
    assert_eq!(alerts.len(), 1);
    let alert = &alerts[0];
    let expected_id = native_resource("private_alert_pool").id();
    assert_eq!(alert["resource_id"], expected_id);
    assert_eq!(
        alert["dedupe_key"],
        format!("agent_ceiling_overrun:{expected_id}")
    );
    assert_eq!(alert["severity"], "warning", "derived for this alert type");
    assert_eq!(
        alert["status"], "open",
        "derived: the read is open-rows-only"
    );
    assert_eq!(alert["resolved"], false);
    assert_eq!(alert["occurrences"], 1);
    assert_eq!(alert["first_seen_ms"], 2000);
    assert_eq!(alert["last_seen_ms"], 2000);
    assert!(
        alert["summary"]
            .as_str()
            .unwrap()
            .contains("has drawn 100 against a ceiling of 50")
    );
    assert!(alert["summary"].as_str().unwrap().contains("50 past it"));
    assert!(
        alert["runbook"]
            .as_str()
            .unwrap()
            .contains("raise the ceiling on preset private_alert_pool")
    );
    assert!(alert["impact"].as_str().unwrap().contains("cannot retract"));
    assert!(
        alert["recovery_condition"]
            .as_str()
            .unwrap()
            .contains("falls back under the ceiling")
    );
    // detail is the parsed payload object with the raw figures.
    let detail = &alert["detail"];
    assert!(detail.is_object());
    assert_eq!(detail["committedTokens"], 100);
    assert_eq!(detail["drawnTokens"], 100);
    assert_eq!(detail["overByTokens"], 50);
    assert_eq!(detail["ceilingTokens"], 50);
    assert_eq!(detail["measuredTokens"], Value::Null);
    assert_eq!(detail["agent"], expected_id);
    assert_eq!(detail["presetId"], "private_alert_pool");

    // Resolved alerts are absent: restore the ceiling on the SAME seat (a
    // different seat would trip the seat-stability guard under the still-open
    // commitment), sweep, read again.
    let restored: hagency_core::project::Resource = serde_json::from_value(json!({
        "presetId": "private_alert_pool", "seatId": "private_alert_seat",
        "framework": "codex", "model": "gpt-5.6-sol", "reasoning": "medium",
        "ceiling": {"tokens": 9_000_000_000_000_000u64, "period": "monthly"}
    }))
    .unwrap();
    f.domain.put_resource(restored).await.unwrap();
    let outcome = f.domain.sweep_ceiling_overruns(3000).await.unwrap();
    assert_eq!(outcome.resolved, 1);
    let mut response = get("/console/api/alerts", &cookie).send(&service).await;
    let value = response.take_json::<Value>().await.unwrap();
    assert_eq!(
        value["alerts"].as_array().unwrap().len(),
        0,
        "resolved alerts must not be published"
    );
    f.close().await;
}
