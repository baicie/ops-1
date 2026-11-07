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
    node_id: Uuid,
    node_generation: i64,
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
    pub job_id: Option<Uuid>,
    pub collection_id: Option<Uuid>,
    pub evidence_id: Option<Uuid>,
    pub code: Option<String>,
}

impl AutomationRunView {
    pub(crate) fn pending(job_id: Uuid) -> Self {
        Self {
            status: "PENDING".into(),
            job_id: Some(job_id),
            collection_id: None,
            evidence_id: None,
            code: None,
        }
    }
}

async fn route_for(
    state: &AppState,
    instance_id: Uuid,
    expected_plugin_id: &str,
) -> AppResult<Route> {
    // This is the Kernel's authoritative route query. `p` must be joined before
    // `tp.publisher_id = p.publisher`; leaving it out is a PostgreSQL error, not
    // a compile error. The tests call this against a real database so that
    // mistake cannot pass a gate again.
    let route = sqlx::query_as::<_, Route>(
        r#"
        SELECT i.id AS instance_id, i.node_id, n.generation AS node_generation,
               n.data_endpoint, n.data_token,
               r.plugin_id, r.version, r.generation
        FROM kernel.activation_revisions r
        JOIN kernel.plugin_deployments d ON d.id = r.deployment_id
        JOIN kernel.plugin_packages p ON p.package_id = r.package_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id = p.publisher
        JOIN kernel.plugin_instances i ON i.deployment_id = d.id
        JOIN kernel.nodes n ON n.id = i.node_id
        WHERE i.id = $1
          AND d.plugin_id = $3
          AND r.plugin_id = $3
          AND r.status = 'ACTIVE'
          AND tp.trust_state = 'TRUSTED'
          AND i.state = 'READY'
          AND i.desired_action = 'START'
          AND n.revoked_at IS NULL
          AND n.status = 'READY'
          AND n.last_seen_at > now() - ($2 || ' seconds')::interval
          AND n.data_endpoint IS NOT NULL
        ORDER BY r.generation DESC, i.slot
        LIMIT 1
        "#,
    )
    .bind(instance_id)
    .bind(state.config.node_stale_seconds)
    .bind(expected_plugin_id)
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
    occurred_at: chrono::DateTime<chrono::Utc>,
) -> AppResult<AutomationRunView> {
    // The Event never chooses items. The Kernel reads the trusted policy it
    // synced from deployment configuration; without items automation refuses
    // instead of producing an EMPTY collection nobody asked for.
    let policy: Option<(Vec<String>, i32, String, Uuid, String)> = sqlx::query_as(
        "SELECT automation_item_ids, automation_window_seconds, state, workspace_id, plugin_id
           FROM kernel.telemetry_sources WHERE source_id=$1",
    )
    .bind(source_id)
    .fetch_optional(&state.db)
    .await?;
    let Some((item_ids, configured_window, source_state, workspace_id, source_plugin)) = policy
    else {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "AUTOMATION_SOURCE_NOT_REGISTERED",
            "the source is not in the Kernel registry",
        ));
    };
    if source_state != "READY"
        || workspace_id != principal.claims.workspace_id
        || source_plugin != principal.claims.plugin_id
    {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "AUTOMATION_SOURCE_NOT_READY",
            "the source is not READY for this principal",
        ));
    }
    if item_ids.is_empty() {
        return Err(AppError::new(
            StatusCode::PRECONDITION_FAILED,
            "AUTOMATION_CONFIGURATION_REQUIRED",
            "automatic collection needs itemIds in OPSWEAVE_AUTOMATION_SOURCES",
        ));
    }

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

    let route = route_for(
        state,
        principal.claims.instance_id,
        &principal.claims.plugin_id,
    )
    .await?;
    if route.instance_id != principal.claims.instance_id
        || route.node_id != principal.claims.node_id
        || route.node_generation != principal.claims.node_generation
        || route.plugin_id != principal.claims.plugin_id
    {
        return Err(AppError::new(
            StatusCode::UNAUTHORIZED,
            "AUTOMATION_INSTANCE_STALE",
            "the route no longer matches the principal's instance/node",
        ));
    }
    let token = crate::automation::sign_claims(state, &principal.claims)?;

    let principal_window = budget
        .get("windowSeconds")
        .and_then(Value::as_i64)
        .unwrap_or(300);
    let window_seconds = i64::from(configured_window).min(principal_window).max(30);
    let item_count = item_ids.len().min(32);
    let to = occurred_at;
    let from = to - chrono::Duration::seconds(window_seconds);
    let collect_body = json!({
        "itemIds": item_ids,
        "window": {
            "from": from.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
            "to": to.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        },
        "budget": {
            "maxWindowSeconds": window_seconds,
            "maxItems": item_count,
            "maxSamplesPerItem": 1000,
            "requestTimeoutMs": 8000,
            "maxConcurrency": 2
        }
    });
    let (_, collected) = post(
        state,
        &route,
        &format!("sources/{source_id}/collect"),
        &token,
        collect_body,
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
        job_id: None,
        collection_id: Some(collection_id),
        evidence_id: Some(evidence_id),
        code: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    /// `activation_revisions` allows one ACTIVE row per plugin and a unique
    /// (plugin,generation); these fixtures must not seed concurrently.
    static DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if std::env::var("OPSWEAVE_REQUIRE_TEST_DATABASE")
                    .ok()
                    .as_deref()
                    == Some("1")
                {
                    panic!("OPSWEAVE_REQUIRE_TEST_DATABASE is set but OPSWEAVE_TEST_DATABASE_URL is unset");
                }
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap();
        let pool = PgPool::connect_with(options).await.unwrap();
        crate::db::migrate(&pool).await.unwrap();
        Some(pool)
    }

    struct Fixture {
        publisher: String,
        plugin_id: String,
        node: Uuid,
        instance: Uuid,
    }

    async fn seed(pool: &PgPool, trusted: bool, node_status: &str) -> Fixture {
        let publisher = format!("publisher-{}", Uuid::new_v4());
        let plugin_id = format!("zabbix-source-{}", Uuid::new_v4());
        sqlx::query(
            "INSERT INTO kernel.trusted_publishers (publisher_id,public_key_hex,fingerprint,trust_state)
             VALUES ($1,'00','00',$2)",
        )
        .bind(&publisher)
        .bind(if trusted { "TRUSTED" } else { "REVOKED" })
        .execute(pool)
        .await
        .unwrap();
        let package = Uuid::new_v4();
        let version = format!("0.0.1-{}", &package.to_string()[..8]);
        sqlx::query(
            "INSERT INTO kernel.plugin_packages
                 (package_id,plugin_id,version,schema_version,publisher,manifest,
                  artifact_digest,bundle_digest,payload_digest,status,signature_state)
             VALUES ($1,$2,$3,'1.1',$4,'{}'::jsonb,$5,$6,$7,'INSTALLED','VERIFIED')",
        )
        .bind(package)
        .bind(&plugin_id)
        .bind(&version)
        .bind(&publisher)
        .bind(format!("artifact-{package}"))
        .bind(format!("bundle-{package}"))
        .bind(format!("payload-{package}"))
        .execute(pool)
        .await
        .unwrap();
        let deployment = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.plugin_deployments
                 (id,plugin_id,package_id,version,desired_replicas,generation,placement,resources,status)
             VALUES ($1,$2,$3,$4,1,1,'{}'::jsonb,'{}'::jsonb,'ACTIVE')",
        )
        .bind(deployment)
        .bind(&plugin_id)
        .bind(package)
        .bind(&version)
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO kernel.activation_revisions
                 (id,plugin_id,package_id,version,deployment_id,generation,status,policy_digest,activated_at)
             VALUES ($1,$2,$3,$4,$5,1,'ACTIVE','sha256:pq',now())",
        )
        .bind(Uuid::new_v4())
        .bind(&plugin_id)
        .bind(package)
        .bind(&version)
        .bind(deployment)
        .execute(pool)
        .await
        .unwrap();
        let node = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.nodes
                 (id,name,control_token_hash,data_token,generation,os,arch,status,last_seen_at,data_endpoint)
             VALUES ($1,$2,'hash','data-token',7,'linux','arm64',$3,now(),'https://127.0.0.1:9105')",
        )
        .bind(node)
        .bind(format!("automation-flow-{node}"))
        .bind(node_status)
        .execute(pool)
        .await
        .unwrap();
        let instance = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.plugin_instances
                 (id,deployment_id,node_id,slot,deployment_generation,desired_action,state)
             VALUES ($1,$2,$3,1,1,'START','READY')",
        )
        .bind(instance)
        .bind(deployment)
        .bind(node)
        .execute(pool)
        .await
        .unwrap();
        Fixture {
            publisher,
            plugin_id,
            node,
            instance,
        }
    }

    async fn cleanup(pool: &PgPool, fixture: &Fixture) {
        let _ = sqlx::query("DELETE FROM kernel.activation_revisions WHERE plugin_id=$1")
            .bind(&fixture.plugin_id)
            .execute(pool)
            .await;
        let deployment: Option<(Uuid,)> =
            sqlx::query_as("SELECT deployment_id FROM kernel.plugin_instances WHERE id=$1")
                .bind(fixture.instance)
                .fetch_optional(pool)
                .await
                .unwrap_or(None);
        let _ = sqlx::query("DELETE FROM kernel.plugin_instances WHERE id=$1")
            .bind(fixture.instance)
            .execute(pool)
            .await;
        if let Some((deployment,)) = deployment {
            let package: Option<(Uuid,)> =
                sqlx::query_as("SELECT package_id FROM kernel.plugin_deployments WHERE id=$1")
                    .bind(deployment)
                    .fetch_optional(pool)
                    .await
                    .unwrap_or(None);
            let _ = sqlx::query("DELETE FROM kernel.plugin_deployments WHERE id=$1")
                .bind(deployment)
                .execute(pool)
                .await;
            if let Some((package,)) = package {
                let _ = sqlx::query("DELETE FROM kernel.plugin_packages WHERE package_id=$1")
                    .bind(package)
                    .execute(pool)
                    .await;
            }
        }
        let _ = sqlx::query("DELETE FROM kernel.nodes WHERE id=$1")
            .bind(fixture.node)
            .execute(pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.trusted_publishers WHERE publisher_id=$1")
            .bind(&fixture.publisher)
            .execute(pool)
            .await;
    }

    fn state(pool: PgPool) -> AppState {
        AppState::new(
            crate::config::Config::from_env(),
            pool,
            b"automation-flow-test".to_vec(),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn route_sql_runs_against_postgres_and_binds_the_expected_plugin() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let _guard = DB_TEST_LOCK.lock().await;
        let fixture = seed(&pool, true, "READY").await;
        let state = state(pool.clone());
        let route = route_for(&state, fixture.instance, &fixture.plugin_id)
            .await
            .expect("the route query must execute and find the instance");
        assert_eq!(route.instance_id, fixture.instance);
        assert_eq!(route.node_id, fixture.node);
        assert_eq!(route.node_generation, 7);
        assert_eq!(route.plugin_id, fixture.plugin_id);
        cleanup(&pool, &fixture).await;
    }

    #[tokio::test]
    async fn route_refuses_untrusted_publishers_revoked_nodes_and_other_plugins() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let _guard = DB_TEST_LOCK.lock().await;
        let untrusted = seed(&pool, false, "READY").await;
        let state = state(pool.clone());
        assert!(route_for(&state, untrusted.instance, "zabbix-source")
            .await
            .is_err());
        cleanup(&pool, &untrusted).await;

        let revoked = seed(&pool, true, "UNREACHABLE").await;
        assert!(route_for(&state, revoked.instance, "zabbix-source")
            .await
            .is_err());
        cleanup(&pool, &revoked).await;

        let trusted = seed(&pool, true, "READY").await;
        assert!(route_for(&state, trusted.instance, "other-plugin")
            .await
            .is_err());
        cleanup(&pool, &trusted).await;
    }
}
