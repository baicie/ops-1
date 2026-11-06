//! G13-B1 slice 4: PROBLEM Event -> bounded collection -> v2 attestation ->
//! Evidence.
//!
//! The Kernel does not read Zabbix itself. It calls the plugin instance that
//! already owns the source, through the Node data proxy, with the automation
//! principal as the caller. The plugin enforces the A.2 credential binding, the
//! SSRF/DNS policy and its own budget; the Kernel then verifies the returned
//! attestation through the same evidence writer a human submission uses, with
//! audit actor AUTOMATION.
//!
//! Failure is not allowed to turn an Event into a half-written Evidence row:
//! collection/attestation errors are audited and returned, and only a complete
//! signed body reaches `append_automation_evidence`.

use crate::automation::AutomationPrincipal;
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use axum::http::StatusCode;
use serde::Serialize;
use serde_json::{json, Value};
use sqlx::FromRow;
use uuid::Uuid;

const MAX_UPSTREAM_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, FromRow)]
struct Route {
    instance_id: Uuid,
    data_endpoint: String,
    data_token: String,
    plugin_id: String,
    version: String,
    generation: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunView {
    pub status: String,
    pub collection_id: Option<Uuid>,
    pub evidence_id: Option<Uuid>,
    pub code: Option<String>,
}

impl AutomationRunView {
    pub(crate) fn failed(code: &str) -> Self {
        Self {
            status: "FAILED".into(),
            collection_id: None,
            evidence_id: None,
            code: Some(code.to_string()),
        }
    }
}

async fn route_for(state: &AppState, instance_id: Uuid) -> AppResult<Route> {
    let route = sqlx::query_as::<_, Route>(
        r#"
        SELECT i.id AS instance_id, n.data_endpoint, n.data_token,
               r.plugin_id, r.version, r.generation
        FROM kernel.activation_revisions r
        JOIN kernel.plugin_deployments d ON d.id = r.deployment_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id = p.publisher
        JOIN kernel.plugin_instances i ON i.deployment_id = d.id
        JOIN kernel.nodes n ON n.id = i.node_id
        WHERE i.id = $1
          AND r.status = 'ACTIVE'
          AND tp.trust_state = 'TRUSTED'
          AND i.state = 'READY'
          AND i.desired_action = 'START'
          AND n.revoked_at IS NULL
          AND n.status = 'READY'
          AND n.last_seen_at > now() - ($2 || ' seconds')::interval
          AND n.data_endpoint IS NOT NULL
        ORDER BY r.generation DESC
        LIMIT 1
        "#,
    )
    .bind(instance_id)
    .bind(state.config.node_stale_seconds)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        AppError::unavailable(
            "AUTOMATION_INSTANCE_UNAVAILABLE",
            "the plugin instance is not ready for an automation call",
        )
    })?;
    crate::nodes::validate_node_data_endpoint(&state.config, &route.data_endpoint)?;
    Ok(route)
}

async fn post(
    state: &AppState,
    route: &Route,
    path: &str,
    automation_token: &str,
    body: Value,
) -> AppResult<(StatusCode, Value)> {
    let url = format!(
        "{}/internal/v1/proxy/{}/{}",
        route.data_endpoint.trim_end_matches('/'),
        route.instance_id,
        path.trim_start_matches('/')
    );
    let request_id = Uuid::new_v4().to_string();
    let response = state
        .http
        .post(url)
        .bearer_auth(&route.data_token)
        .header("x-opsweave-request-id", &request_id)
        .header("x-opsweave-plugin-id", &route.plugin_id)
        .header("x-opsweave-plugin-version", &route.version)
        .header(
            "x-opsweave-activation-revision",
            route.generation.to_string(),
        )
        .header("x-opsweave-automation-context", automation_token)
        .json(&body)
        .timeout(std::time::Duration::from_secs(
            state.config.request_timeout_seconds.max(5),
        ))
        .send()
        .await
        .map_err(|_| {
            AppError::unavailable(
                "AUTOMATION_UPSTREAM_UNAVAILABLE",
                "the plugin did not answer the automation call",
            )
        })?;
    let status = response.status();
    if response
        .content_length()
        .is_some_and(|length| length > MAX_UPSTREAM_BYTES as u64)
    {
        return Err(AppError::unavailable(
            "AUTOMATION_RESPONSE_TOO_LARGE",
            "the plugin response exceeded the automation limit",
        ));
    }
    let bytes = response.bytes().await.map_err(|_| {
        AppError::unavailable(
            "AUTOMATION_UPSTREAM_UNAVAILABLE",
            "the plugin response could not be read",
        )
    })?;
    if bytes.len() > MAX_UPSTREAM_BYTES {
        return Err(AppError::unavailable(
            "AUTOMATION_RESPONSE_TOO_LARGE",
            "the plugin response exceeded the automation limit",
        ));
    }
    let body: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if !status.is_success() {
        let code = body
            .get("code")
            .and_then(Value::as_str)
            .unwrap_or("AUTOMATION_UPSTREAM_FAILED");
        return Err(AppError::new(
            status,
            match code {
                "ZBX_CREDENTIAL_ENDPOINT_MISMATCH" => "ZBX_CREDENTIAL_ENDPOINT_MISMATCH",
                "ZBX_CREDENTIAL_BINDING_REQUIRED" => "ZBX_CREDENTIAL_BINDING_REQUIRED",
                "ZBX_INSECURE_ENDPOINT_FORBIDDEN" => "ZBX_INSECURE_ENDPOINT_FORBIDDEN",
                "ZBX_USER_REQUIRED" => "AUTOMATION_PRINCIPAL_REJECTED",
                _ => "AUTOMATION_UPSTREAM_FAILED",
            },
            format!("plugin refused the automation call with {status}"),
        ));
    }
    Ok((status, body))
}

/// Run one collection + attestation + evidence append for a PROBLEM Event.
///
/// The caller has already stored the Event and the Incident; this function only
/// adds Evidence and never changes the Incident's human lifecycle.
pub async fn collect_and_append(
    state: &AppState,
    principal: &AutomationPrincipal,
    incident_id: Uuid,
    source_id: Uuid,
) -> AppResult<AutomationRunView> {
    // Budget is spent before the outbound call; a refusal is 429 and no
    // Evidence is written.
    let budget: Option<Value> = sqlx::query_scalar(
        "UPDATE kernel.automation_principals
            SET budget = jsonb_set(
                budget, '{collections}',
                to_jsonb(GREATEST(0, COALESCE((budget->>'collections')::int, 0) - 1)))
          WHERE principal_id=$1
            AND COALESCE((budget->>'collections')::int, 0) > 0
          RETURNING budget",
    )
    .bind(principal.principal_id())
    .fetch_optional(&state.db)
    .await?;
    let Some(budget) = budget else {
        return Err(AppError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "AUTOMATION_BUDGET_EXHAUSTED",
            "the automation principal has no collection budget left",
        ));
    };

    let route = route_for(state, principal.claims.instance_id).await?;
    let token = crate::automation::sign_claims(state, &principal.claims)?;

    let (_, collected) = post(
        state,
        &route,
        &format!("sources/{source_id}/collect"),
        &token,
        json!({}),
    )
    .await?;
    let outcome = collected
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("UNKNOWN");
    if matches!(outcome, "UNAVAILABLE" | "UNKNOWN" | "TIMEOUT") {
        return Err(AppError::conflict(
            "AUTOMATION_COLLECTION_NOT_ATTESTABLE",
            format!("collection outcome {outcome} is not a measurement"),
        ));
    }
    let collection_id = collected
        .get("collectionId")
        .and_then(Value::as_str)
        .and_then(|value| Uuid::parse_str(value).ok())
        .ok_or_else(|| {
            AppError::unavailable(
                "AUTOMATION_INVALID_RESPONSE",
                "the plugin returned no collection id",
            )
        })?;

    let (_, attested) = post(
        state,
        &route,
        &format!("collections/{collection_id}/attestation"),
        &token,
        json!({"incidentId": incident_id, "kind": "METRIC_SNAPSHOT"}),
    )
    .await?;
    let evidence = attested.get("evidence").cloned().ok_or_else(|| {
        AppError::unavailable(
            "AUTOMATION_INVALID_RESPONSE",
            "the plugin returned no attested evidence body",
        )
    })?;
    let evidence_bytes = serde_json::to_vec(&evidence).map_err(AppError::from)?;
    let limit = budget
        .get("evidenceBytes")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if limit > 0 && evidence_bytes.len() as i64 > limit {
        return Err(AppError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "AUTOMATION_BUDGET_EXHAUSTED",
            "the attested body exceeds the principal evidence budget",
        ));
    }

    let evidence_id = crate::incidents::append_automation_evidence(
        state,
        principal.principal_id(),
        principal.claims.workspace_id,
        incident_id,
        evidence,
    )
    .await?;
    Ok(AutomationRunView {
        status: "COLLECTED".into(),
        collection_id: Some(collection_id),
        evidence_id: Some(evidence_id),
        code: None,
    })
}

/// Record a failed attempt without leaking the upstream body. The Event itself
/// stays accepted; the failure is visible in the audit trail and the response.
pub async fn record_failure(
    state: &AppState,
    principal: &AutomationPrincipal,
    incident_id: Uuid,
    source_id: Uuid,
    error: &AppError,
) {
    let _ = crate::audit::record(
        &state.db,
        "telemetry.automation.collection_failed",
        "AUTOMATION",
        &principal.principal_id().to_string(),
        "INCIDENT",
        &incident_id.to_string(),
        "AUTOMATION_COLLECT",
        "REJECTED",
        json!({"sourceId": source_id, "code": error.code}),
        None,
    )
    .await;
}
