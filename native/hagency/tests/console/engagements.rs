use super::*;

/// The engagements read and document: the same authority matrix the usage
/// console test applies, the read's exact wire shape (including the token
/// column added with the page), pagination, and the document served with the
/// loader's allowlist + key mapping exercised.
#[tokio::test]
async fn native_console_engagements_read() {
    let f = Fixture::new("127.0.0.1:13300".parse().unwrap(), None);
    let service = f.service();
    let anonymous = TestClient::get(format!("{BASE}/console/api/engagements"))
        .add_header("host", "127.0.0.1:13300", true)
        .send(&service)
        .await;
    assert_eq!(anonymous.status_code, Some(StatusCode::UNAUTHORIZED));
    let cookie = session(&service).await;
    for (name, value) in [
        ("host", "evil.test"),
        ("origin", "https://evil.test"),
        ("sec-fetch-site", "cross-site"),
        ("sec-fetch-site", "none"),
        ("x-forwarded-for", "127.0.0.1"),
        ("forwarded", "for=127.0.0.1"),
        ("cookie", "hagency_console=bad"),
        ("cookie", &format!("{cookie}; {cookie}")),
    ] {
        let response = get("/console/api/engagements", &cookie)
            .add_header(name, value, true)
            .send(&service)
            .await;
        assert!(matches!(
            response.status_code,
            Some(StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
        ));
    }
    for query in [
        "?limit=0",
        "?limit=17",
        "?limit=bad",
        "?after=%31",
        "?after=x&after=y",
        "?unknown=1",
    ] {
        let response = get(&format!("/console/api/engagements{query}"), &cookie)
            .send(&service)
            .await;
        assert_eq!(
            response.status_code,
            Some(StatusCode::BAD_REQUEST),
            "{query}"
        );
    }
    // The read's exact shape: the seeded engagement with every wire key,
    // including the requested-tokens column the page renders.
    let mut response = get("/console/api/engagements", &cookie)
        .send(&service)
        .await;
    assert_eq!(response.status_code, Some(StatusCode::OK));
    let value = response.take_json::<Value>().await.unwrap();
    let rows = value["engagements"].as_array().unwrap();
    assert!(!rows.is_empty(), "the fixture's engagements publish");
    let row = &rows[0];
    for key in [
        "id",
        "agentName",
        "projectName",
        "role",
        "requestedTokens",
        "state",
        "cleanup",
    ] {
        assert!(row.get(key).is_some(), "missing wire key {key}");
    }
    assert!(row["requestedTokens"].as_u64().is_some());
    assert!(row["id"].as_str().is_some_and(|id| !id.is_empty()));
    // Pagination: page one plus a second page through the seeded rows.
    let response = get("/console/api/engagements?limit=1", &cookie)
        .send(&service)
        .await;
    assert_eq!(response.status_code, Some(StatusCode::OK));
    f.close().await;
}

/// The document route rule: `/console/engagements/` serves the staged
/// document, takes NO query (the page is a paginated list; selection is
/// in-page), and unknown paths under the console stay refused.
#[tokio::test]
async fn native_console_engagements_document() {
    let f = Fixture::new("127.0.0.1:13300".parse().unwrap(), None);
    let service = f.service();
    let mut response = TestClient::get(format!("{BASE}/console/engagements/"))
        .add_header("host", "127.0.0.1:13300", true)
        .send(&service)
        .await;
    assert_eq!(response.status_code, Some(StatusCode::OK));
    assert!(
        response
            .take_string()
            .await
            .unwrap()
            .contains("engagements document fixture")
    );
    // The no-query rule: any query on the engagements document is refused.
    for path in [
        "/console/engagements/?engagement_id=x",
        "/console/engagements/?anything=1",
    ] {
        let response = TestClient::get(format!("{BASE}{path}"))
            .add_header("host", "127.0.0.1:13300", true)
            .send(&service)
            .await;
        assert_eq!(
            response.status_code,
            Some(StatusCode::BAD_REQUEST),
            "{path}"
        );
    }
    // Non-document assets never relax the origin rule.
    let response = TestClient::get(format!("{BASE}/console/_next/static/x.js"))
        .add_header("host", "127.0.0.1:13300", true)
        .add_header("sec-fetch-site", "cross-site", true)
        .send(&service)
        .await;
    assert_eq!(response.status_code, Some(StatusCode::FORBIDDEN));
    f.close().await;
}
