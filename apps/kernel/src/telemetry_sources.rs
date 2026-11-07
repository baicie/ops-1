//! G13-B0 slice 1: the Kernel-owned telemetry source registry.
//!
//! ADR-018 requires the Kernel, not the plugin, to decide which workspace a
//! source belongs to before an automation principal can be issued. This module
//! is the only writer of `kernel.telemetry_sources`:
//!
//! * sources are enrolled in deployment configuration (`OPSWEAVE_AUTOMATION_SOURCES`);
//! * endpoint and TLS are copied from the matching A.2 credential binding, so the
//!   registry cannot disagree with the policy the plugin enforces;
//! * a missing binding, an https/TLS mismatch or an insecure endpoint becomes
//!   INVALID with a stable reason instead of disappearing;
//! * a source removed from configuration becomes DISABLED, never deleted, because
//!   incidents and events may reference it.
//!
//! No automation endpoint is enabled by this module. B1 slice 2 may issue
//! principals only for a source whose state is READY.

use crate::auth::AuthUser;
use crate::config::AutomationSource;
use crate::error::AppResult;
use crate::state::AppState;
use axum::extract::State;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use std::collections::HashMap;
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct SourceRow {
    pub source_id: Uuid,
    pub workspace_id: Uuid,
    pub plugin_id: String,
    pub secret_ref: String,
    pub endpoint: Option<String>,
    pub tls_policy: Option<String>,
    pub state: String,
    pub invalid_reason: Option<String>,
    pub automation_item_ids: Vec<String>,
    pub automation_window_seconds: i32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceView {
    source_id: Uuid,
    workspace_id: Uuid,
    plugin_id: String,
    secret_ref: String,
    endpoint: Option<String>,
    tls_policy: Option<String>,
    state: String,
    invalid_reason: Option<String>,
    automation_item_ids: Vec<String>,
    automation_window_seconds: i32,
    updated_at: DateTime<Utc>,
}

impl From<SourceRow> for SourceView {
    fn from(row: SourceRow) -> Self {
        Self {
            source_id: row.source_id,
            workspace_id: row.workspace_id,
            plugin_id: row.plugin_id,
            secret_ref: row.secret_ref,
            endpoint: row.endpoint,
            tls_policy: row.tls_policy,
            state: row.state,
            invalid_reason: row.invalid_reason,
            automation_item_ids: row.automation_item_ids,
            automation_window_seconds: row.automation_window_seconds,
            updated_at: row.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct SourceListView {
    sources: Vec<SourceView>,
}

/// `GET /api/v1/telemetry/sources` — admin-only, metadata only.
///
/// The registry contains secret *references*, never secret values; the endpoint
/// is shown because the approved destination is the thing an operator needs to
/// review, and ADR-017 already treats the endpoint as non-secret metadata.
pub async fn list_sources(
    State(state): State<AppState>,
    auth: AuthUser,
) -> AppResult<Json<SourceListView>> {
    auth.require_admin()?;
    let rows = sqlx::query_as::<_, SourceRow>(
        "SELECT source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state,invalid_reason,
                automation_item_ids,automation_window_seconds,updated_at
           FROM kernel.telemetry_sources
          ORDER BY workspace_id, source_id",
    )
    .fetch_all(&state.db)
    .await?;
    Ok(Json(SourceListView {
        sources: rows.into_iter().map(SourceView::from).collect(),
    }))
}

/// Reconcile the registry with configuration. Called once at Kernel start.
///
/// This is deliberately not an HTTP write path: a plugin must never be able to
/// enrol a source, and an operator changes the list by deploying configuration
/// (the same posture as credential bindings, ADR-017 §3).
pub async fn sync(
    pool: &PgPool,
    sources: &[AutomationSource],
    bindings: &HashMap<String, HashMap<String, HashMap<String, crate::config::CredentialBinding>>>,
    allow_insecure_endpoints: bool,
) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    let existing: Vec<(Uuid, Uuid, String)> =
        sqlx::query_as("SELECT source_id, workspace_id, plugin_id FROM kernel.telemetry_sources")
            .fetch_all(&mut *tx)
            .await?;
    let existing: HashMap<Uuid, (Uuid, String)> = existing
        .into_iter()
        .map(|(source_id, workspace_id, plugin_id)| (source_id, (workspace_id, plugin_id)))
        .collect();

    let configured: Vec<Uuid> = sources.iter().map(|source| source.source_id).collect();
    // Anything no longer named in configuration stops being usable. It is not
    // deleted: events/incidents may reference it, and a deletion would lose the
    // attribution that already happened.
    sqlx::query(
        "UPDATE kernel.telemetry_sources
            SET state='DISABLED', invalid_reason=NULL, updated_at=now()
          WHERE NOT (source_id = ANY($1::uuid[]))",
    )
    .bind(&configured)
    .execute(&mut *tx)
    .await?;

    for source in sources {
        if let Some((workspace_id, plugin_id)) = existing.get(&source.source_id) {
            if *workspace_id != source.workspace_id || plugin_id != &source.plugin_id {
                // The same source id cannot move between workspaces or plugins:
                // every incident already attributed to it would silently change
                // owner. Keep the original row and make the conflict visible.
                sqlx::query(
                    "UPDATE kernel.telemetry_sources
                        SET state='INVALID', invalid_reason='SOURCE_ID_REASSIGNED',
                            endpoint=NULL, tls_policy=NULL, updated_at=now()
                      WHERE source_id=$1",
                )
                .bind(source.source_id)
                .execute(&mut *tx)
                .await?;
                tracing::error!(
                    source_id = %source.source_id,
                    "automation source id was reassigned to another workspace/plugin; refusing the new binding"
                );
                continue;
            }
        }

        let binding = bindings
            .get(&source.plugin_id)
            .and_then(|workspaces| workspaces.get(&source.workspace_id.to_string()))
            .and_then(|refs| refs.get(&source.secret_ref));

        let (state, endpoint, tls, reason) = match binding {
            None => ("INVALID", None, None, Some("CREDENTIAL_BINDING_MISSING")),
            Some(binding)
                if binding.tls == "VERIFY" && !binding.endpoint.starts_with("https://") =>
            {
                (
                    "INVALID",
                    Some(binding.endpoint.clone()),
                    Some(binding.tls.clone()),
                    Some("ENDPOINT_NOT_HTTPS"),
                )
            }
            Some(binding) if binding.tls == "TEST_PLAINTEXT" && !allow_insecure_endpoints => (
                "INVALID",
                Some(binding.endpoint.clone()),
                Some(binding.tls.clone()),
                Some("INSECURE_ENDPOINT_FORBIDDEN"),
            ),
            Some(binding) if source.state == "DISABLED" => (
                "DISABLED",
                Some(binding.endpoint.clone()),
                Some(binding.tls.clone()),
                None,
            ),
            Some(binding) => (
                "READY",
                Some(binding.endpoint.clone()),
                Some(binding.tls.clone()),
                None,
            ),
        };

        sqlx::query(
            "INSERT INTO kernel.telemetry_sources
                 (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state,invalid_reason,
                  automation_item_ids,automation_window_seconds,updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now())
             ON CONFLICT (source_id) DO UPDATE
               SET workspace_id=EXCLUDED.workspace_id,
                   plugin_id=EXCLUDED.plugin_id,
                   secret_ref=EXCLUDED.secret_ref,
                   endpoint=EXCLUDED.endpoint,
                   tls_policy=EXCLUDED.tls_policy,
                   state=EXCLUDED.state,
                   invalid_reason=EXCLUDED.invalid_reason,
                   automation_item_ids=EXCLUDED.automation_item_ids,
                   automation_window_seconds=EXCLUDED.automation_window_seconds,
                   updated_at=now()",
        )
        .bind(source.source_id)
        .bind(source.workspace_id)
        .bind(&source.plugin_id)
        .bind(&source.secret_ref)
        .bind(&endpoint)
        .bind(&tls)
        .bind(state)
        .bind(reason)
        .bind(&source.item_ids)
        .bind(source.window_seconds as i32)
        .execute(&mut *tx)
        .await?;

        if let Some(reason) = reason {
            tracing::warn!(
                source_id = %source.source_id,
                workspace_id = %source.workspace_id,
                reason,
                "automation source is not usable"
            );
        }
    }

    tx.commit().await?;
    tracing::info!(
        configured = sources.len(),
        "telemetry source registry reconciled"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AutomationSource, CredentialBinding};
    use sqlx::postgres::PgConnectOptions;
    use sqlx::PgPool;

    const REQUIRE_DATABASE_ENV: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

    /// The registry is global by design, so these tests must not reconcile it
    /// concurrently: an empty-config sync in one test disables every source,
    /// including the row another test is asserting on.
    static DB_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn database_required() -> bool {
        match std::env::var(REQUIRE_DATABASE_ENV) {
            Ok(value) => match value.trim().to_ascii_lowercase().as_str() {
                "0" | "false" | "no" => false,
                "1" | "true" | "yes" => true,
                other => panic!("{REQUIRE_DATABASE_ENV} is set to {other:?}: use 1 to require the DB-backed tests"),
            },
            Err(_) => false,
        }
    }

    async fn test_pool() -> Option<PgPool> {
        let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
            Ok(url) => url,
            Err(std::env::VarError::NotPresent) => {
                if database_required() {
                    panic!(
                        "{REQUIRE_DATABASE_ENV} is set but OPSWEAVE_TEST_DATABASE_URL is unset: \
                         skipping these tests would count as a failure"
                    );
                }
                eprintln!(
                    "skip: OPSWEAVE_TEST_DATABASE_URL is unset and {REQUIRE_DATABASE_ENV} is not 1"
                );
                return None;
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                panic!("OPSWEAVE_TEST_DATABASE_URL is set but is not valid UTF-8")
            }
        };
        let options: PgConnectOptions = url.parse().unwrap_or_else(|error| {
            panic!("OPSWEAVE_TEST_DATABASE_URL is not a PostgreSQL URL: {error}")
        });
        let pool = PgPool::connect_with(options)
            .await
            .unwrap_or_else(|error| panic!("cannot connect to the test database: {error}"));
        crate::db::migrate(&pool)
            .await
            .unwrap_or_else(|error| panic!("the test database rejected the migrations: {error:#}"));
        Some(pool)
    }

    fn bindings(
        plugin: &str,
        workspace: Uuid,
        reference: &str,
        endpoint: &str,
        tls: &str,
    ) -> HashMap<String, HashMap<String, HashMap<String, CredentialBinding>>> {
        let mut refs = HashMap::new();
        refs.insert(
            reference.to_string(),
            CredentialBinding {
                endpoint: endpoint.to_string(),
                tls: tls.to_string(),
            },
        );
        let mut workspaces = HashMap::new();
        workspaces.insert(workspace.to_string(), refs);
        let mut plugins = HashMap::new();
        plugins.insert(plugin.to_string(), workspaces);
        plugins
    }

    fn source(workspace: Uuid, state: &str) -> AutomationSource {
        AutomationSource {
            source_id: Uuid::new_v4(),
            workspace_id: workspace,
            plugin_id: "zabbix-source".into(),
            secret_ref: "secretref:zabbix/main".into(),
            state: state.into(),
            item_ids: vec!["10401".into()],
            window_seconds: 300,
        }
    }

    async fn row(pool: &PgPool, source_id: Uuid) -> SourceRow {
        sqlx::query_as::<_, SourceRow>(
            "SELECT source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state,invalid_reason,
                    automation_item_ids,automation_window_seconds,updated_at
               FROM kernel.telemetry_sources WHERE source_id=$1",
        )
        .bind(source_id)
        .fetch_one(pool)
        .await
        .unwrap()
    }

    async fn cleanup(pool: &PgPool, source_id: Uuid) {
        let _ = sqlx::query("DELETE FROM kernel.telemetry_sources WHERE source_id=$1")
            .bind(source_id)
            .execute(pool)
            .await;
    }

    async fn insert_incident(
        pool: &PgPool,
        owner: Uuid,
        workspace: Uuid,
        source: Uuid,
        native_id: &str,
    ) -> Result<Uuid, sqlx::Error> {
        let incident_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.incidents
                 (incident_id,title,severity,status,source,native_id,started_at,owner,workspace_id,source_id,origin)
             VALUES ($1,'B1 dedup test','MINOR','OPEN','ZABBIX',$2,now(),$3,$4,$5,'AUTOMATION')",
        )
        .bind(incident_id)
        .bind(native_id)
        .bind(owner)
        .bind(workspace)
        .bind(source)
        .execute(pool)
        .await?;
        Ok(incident_id)
    }

    #[tokio::test]
    async fn incidents_are_unique_per_workspace_source_and_native_id() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let _guard = DB_TEST_LOCK.lock().await;
        let legacy = crate::scope::legacy_workspace();
        let second = Uuid::new_v4();
        let owner = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.users (id,email,display_name,password_hash,role)
             VALUES ($1,$2,'B1 owner','not-a-real-hash','admin')",
        )
        .bind(owner)
        .bind(format!("b1-{owner}@example.invalid"))
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO kernel.business_workspaces (workspace_id,key,name)
             VALUES ($1,$2,'B1 dedup workspace')",
        )
        .bind(second)
        .bind(format!("b1-{second}"))
        .execute(&pool)
        .await
        .unwrap();

        let first_source = source(legacy, "READY");
        let second_source = source(second, "READY");
        for (enrolled, workspace) in [(&first_source, legacy), (&second_source, second)] {
            sqlx::query(
                "INSERT INTO kernel.telemetry_sources
                     (source_id,workspace_id,plugin_id,secret_ref,endpoint,tls_policy,state)
                 VALUES ($1,$2,'zabbix-source','secretref:zabbix/main','https://zabbix.example/api_jsonrpc.php','VERIFY','READY')",
            )
            .bind(enrolled.source_id)
            .bind(workspace)
            .execute(&pool)
            .await
            .unwrap();
        }

        insert_incident(&pool, owner, legacy, first_source.source_id, "same-native")
            .await
            .unwrap();
        // The same nativeId in another workspace is a different failure, not a
        // conflict: this is the rule the legacy global index could not express.
        insert_incident(&pool, owner, second, second_source.source_id, "same-native")
            .await
            .unwrap();
        let duplicate =
            insert_incident(&pool, owner, legacy, first_source.source_id, "same-native")
                .await
                .unwrap_err();
        assert_eq!(
            duplicate
                .as_database_error()
                .and_then(|error| error.code())
                .as_deref(),
            Some("23505"),
            "the workspace+source+native index must refuse the duplicate: {duplicate}"
        );

        let _ = sqlx::query("DELETE FROM kernel.incidents WHERE source_id = ANY($1::uuid[])")
            .bind(vec![first_source.source_id, second_source.source_id])
            .execute(&pool)
            .await;
        cleanup(&pool, first_source.source_id).await;
        cleanup(&pool, second_source.source_id).await;
        let _ = sqlx::query("DELETE FROM kernel.business_workspaces WHERE workspace_id=$1")
            .bind(second)
            .execute(&pool)
            .await;
        let _ = sqlx::query("DELETE FROM kernel.users WHERE id=$1")
            .bind(owner)
            .execute(&pool)
            .await;
    }

    #[tokio::test]
    async fn a_ready_source_copies_the_approved_binding() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let _guard = DB_TEST_LOCK.lock().await;
        let workspace = crate::scope::legacy_workspace();
        let enrolled = source(workspace, "READY");
        let map = bindings(
            "zabbix-source",
            workspace,
            "secretref:zabbix/main",
            "https://zabbix.example/api_jsonrpc.php",
            "VERIFY",
        );
        sync(&pool, std::slice::from_ref(&enrolled), &map, false)
            .await
            .unwrap();
        let stored = row(&pool, enrolled.source_id).await;
        assert_eq!(stored.state, "READY");
        assert_eq!(
            stored.endpoint.as_deref(),
            Some("https://zabbix.example/api_jsonrpc.php")
        );
        assert_eq!(stored.tls_policy.as_deref(), Some("VERIFY"));
        assert!(stored.invalid_reason.is_none());
        cleanup(&pool, enrolled.source_id).await;
    }

    #[tokio::test]
    async fn missing_or_unsafe_bindings_become_invalid_not_invisible() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let _guard = DB_TEST_LOCK.lock().await;
        let workspace = crate::scope::legacy_workspace();
        let no_binding = source(workspace, "READY");
        sync(
            &pool,
            std::slice::from_ref(&no_binding),
            &HashMap::new(),
            false,
        )
        .await
        .unwrap();
        let stored = row(&pool, no_binding.source_id).await;
        assert_eq!(stored.state, "INVALID");
        assert_eq!(
            stored.invalid_reason.as_deref(),
            Some("CREDENTIAL_BINDING_MISSING")
        );

        let plaintext = source(workspace, "READY");
        let map = bindings(
            "zabbix-source",
            workspace,
            "secretref:zabbix/main",
            "http://127.0.0.1:18090/api_jsonrpc.php",
            "TEST_PLAINTEXT",
        );
        sync(&pool, std::slice::from_ref(&plaintext), &map, false)
            .await
            .unwrap();
        let stored = row(&pool, plaintext.source_id).await;
        assert_eq!(stored.state, "INVALID");
        assert_eq!(
            stored.invalid_reason.as_deref(),
            Some("INSECURE_ENDPOINT_FORBIDDEN")
        );

        // The same source becomes usable only when the deployment explicitly
        // allows the test endpoint, mirroring the plugin's own flag.
        sync(&pool, std::slice::from_ref(&plaintext), &map, true)
            .await
            .unwrap();
        assert_eq!(row(&pool, plaintext.source_id).await.state, "READY");

        cleanup(&pool, no_binding.source_id).await;
        cleanup(&pool, plaintext.source_id).await;
    }

    #[tokio::test]
    async fn removing_a_source_disables_it_instead_of_deleting_it() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let _guard = DB_TEST_LOCK.lock().await;
        let workspace = crate::scope::legacy_workspace();
        let enrolled = source(workspace, "READY");
        let map = bindings(
            "zabbix-source",
            workspace,
            "secretref:zabbix/main",
            "https://zabbix.example/api_jsonrpc.php",
            "VERIFY",
        );
        sync(&pool, std::slice::from_ref(&enrolled), &map, false)
            .await
            .unwrap();
        sync(&pool, &[], &map, false).await.unwrap();
        assert_eq!(row(&pool, enrolled.source_id).await.state, "DISABLED");
        cleanup(&pool, enrolled.source_id).await;
    }

    #[tokio::test]
    async fn a_source_cannot_move_to_another_workspace() {
        let Some(pool) = test_pool().await else {
            return;
        };
        let _guard = DB_TEST_LOCK.lock().await;
        let workspace = crate::scope::legacy_workspace();
        let enrolled = source(workspace, "READY");
        let map = bindings(
            "zabbix-source",
            workspace,
            "secretref:zabbix/main",
            "https://zabbix.example/api_jsonrpc.php",
            "VERIFY",
        );
        sync(&pool, std::slice::from_ref(&enrolled), &map, false)
            .await
            .unwrap();

        let second = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO kernel.business_workspaces (workspace_id,key,name)
             VALUES ($1,$2,'B1 second workspace')",
        )
        .bind(second)
        .bind(format!("b1-{second}"))
        .execute(&pool)
        .await
        .unwrap();
        let mut moved = enrolled.clone();
        moved.workspace_id = second;
        let map = bindings(
            "zabbix-source",
            second,
            "secretref:zabbix/main",
            "https://other.example/api_jsonrpc.php",
            "VERIFY",
        );
        sync(&pool, std::slice::from_ref(&moved), &map, false)
            .await
            .unwrap();
        let stored = row(&pool, enrolled.source_id).await;
        assert_eq!(stored.state, "INVALID");
        assert_eq!(
            stored.invalid_reason.as_deref(),
            Some("SOURCE_ID_REASSIGNED")
        );
        assert_eq!(stored.workspace_id, workspace);
        let _ = sqlx::query("DELETE FROM kernel.business_workspaces WHERE workspace_id=$1")
            .bind(second)
            .execute(&pool)
            .await;
        cleanup(&pool, enrolled.source_id).await;
    }
}
