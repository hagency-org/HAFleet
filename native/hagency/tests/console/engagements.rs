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
    // E4 on the wire: the astral project name. The verifier truncated the
    // 260-character input to 255 Unicode SCALAR values (authority.rs:286) —
    // 510 UTF-16 code units, a name that exceeds a UTF-16 bound but never
    // the scalar one. The client validator counts code points (verified by
    // a node unit against the real validator), so both sides agree.
    let astral = rows
        .iter()
        .find(|r| r["agentName"] == "AlertWorker")
        .expect("the astral-name engagement publishes");
    let name = astral["projectName"].as_str().unwrap();
    assert_eq!(name.chars().count(), 255, "255 Unicode scalar values");
    assert_eq!(name.encode_utf16().count(), 510, "510 UTF-16 units");
    assert!(name.chars().all(|c| c == '𝕏'));
    // E3: the pagination ladder at ?limit=1. The cursor is the LAST-SERVED
    // engagement's server-assigned id (console/usage.rs:78) — an opaque
    // ordering key the store compares lexically (`WHERE id>?1 ORDER BY id`,
    // domain.rs). It names no session, no authority and no resource: a bare
    // cursor grants nothing, and every page re-authorizes through the
    // console session exactly as page one did.
    let mut response = get("/console/api/engagements?limit=1", &cookie)
        .send(&service)
        .await;
    assert_eq!(response.status_code, Some(StatusCode::OK));
    let value = response.take_json::<Value>().await.unwrap();
    let page_one = value["engagements"].as_array().unwrap();
    assert_eq!(page_one.len(), 1, "page one carries exactly one row");
    let first_id = page_one[0]["id"].as_str().unwrap().to_owned();
    let cursor = value["next_after"]
        .as_str()
        .expect("non-null opaque next_after on page one")
        .to_owned();
    assert!(!cursor.is_empty());
    assert_eq!(cursor, first_id, "the cursor is the last-served id");
    let mut seen = vec![first_id];
    let mut cursor = Some(cursor);
    // Walk to exhaustion: three seeded engagements → three one-row pages,
    // then an EMPTY page with a null cursor.
    for expected in 0..4 {
        let Some(after) = cursor.clone() else {
            break;
        };
        let mut response = get(
            &format!("/console/api/engagements?limit=1&after={after}"),
            &cookie,
        )
        .send(&service)
        .await;
        assert_eq!(response.status_code, Some(StatusCode::OK));
        let value = response.take_json::<Value>().await.unwrap();
        let rows = value["engagements"].as_array().unwrap();
        if expected < 2 {
            assert_eq!(rows.len(), 1, "content page {}", expected + 2);
            let id = rows[0]["id"].as_str().unwrap().to_owned();
            assert!(!seen.contains(&id), "each page serves a NEW engagement");
            seen.push(id.clone());
            cursor = value["next_after"].as_str().map(str::to_owned);
        } else {
            assert!(rows.is_empty(), "the page after the last row is empty");
            assert!(
                value["next_after"].is_null(),
                "the empty page carries a null cursor"
            );
            cursor = None;
        }
    }
    assert_eq!(seen.len(), 3, "all three seeded engagements were served");
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
