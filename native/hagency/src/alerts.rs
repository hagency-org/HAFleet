//! Open ceiling overrun alerts behind the existing operator authentication
//! boundary (ADR-124 slice b). Publication only: an alert is diagnostic and
//! never confers authority; the sweep that writes the rows is in the store.
use crate::{refusal, resources::domain};
use hagency_store::{Error, MAX_OPEN_CEILING_ALERTS};
use salvo::prelude::*;

pub(crate) fn router() -> Router {
    Router::with_path("alerts").get(list)
}

fn limit_query(req: &Request) -> Result<u32, ()> {
    if req.uri().query().is_some_and(|q| q.len() > 64) {
        return Err(());
    }
    let fields = req.queries();
    if fields.is_empty() {
        return Ok(100);
    }
    if fields.len() != 1 {
        return Err(());
    }
    let values = fields.get_vec("limit").ok_or(())?;
    if values.len() != 1 || values[0].is_empty() || !values[0].bytes().all(|b| b.is_ascii_digit()) {
        return Err(());
    }
    let limit: u32 = values[0].parse().map_err(|_| ())?;
    // Deliberate divergence from the retained route's clamp
    // (`Math.min(parseInt(limit) || 100, 500)`, alert-store.js:410): an
    // out-of-range limit is refused, not silently clamped, matching every
    // other bounded read behind this boundary.
    if limit == 0 || limit > MAX_OPEN_CEILING_ALERTS as u32 {
        return Err(());
    }
    Ok(limit)
}

#[handler]
async fn list(req: &mut Request, depot: &mut Depot, res: &mut Response) {
    let Some(store) = domain(depot, res) else {
        return;
    };
    let Ok(limit) = limit_query(req) else {
        refusal(res, StatusCode::BAD_REQUEST, "invalid_alerts_query");
        return;
    };
    // The read clock is statement time, mirroring the retained GET /api/alerts
    // (backend-v2.js:16069-16079): no at_ms parameter exists to honor.
    let at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
        .unwrap_or_default();
    match store.open_ceiling_alerts(limit).await {
        Ok(alerts) => res.render(Json(serde_json::json!({"at_ms": at_ms, "alerts": alerts}))),
        Err(error) => {
            let (status, code) = match error {
                Error::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_alerts_query"),
                Error::Schema => (StatusCode::SERVICE_UNAVAILABLE, "alerts_corrupt"),
                Error::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
                Error::OutcomeUnknown => (StatusCode::GATEWAY_TIMEOUT, "outcome_unknown"),
                _ => (StatusCode::SERVICE_UNAVAILABLE, "alerts_unavailable"),
            };
            refusal(res, status, code);
        }
    }
}
