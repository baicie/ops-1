use crate::auth::AuthUser;
use crate::capabilities::user_context_token;
use crate::error::{AppError, AppResult};
use crate::scope::DataScope;
use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, Method, Uri};
use axum::response::{IntoResponse, Response};
use opsweave_contracts::ManifestV11;
use rand::Rng;
use serde_json::Value;
use sqlx::FromRow;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Clone, FromRow)]
#[allow(dead_code)]
struct RouteRow {
    instance_id: Uuid,
    node_id: Uuid,
    data_endpoint: String,
    data_token: String,
    manifest: Value,
    generation: i64,
    plugin_id: String,
    version: String,
}

pub async fn proxy(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((plugin_id, path)): Path<(String, String)>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> AppResult<Response> {
    // A COMPILE-TIME GUARD, not a runtime one.
    //
    // This was `if !matches!(auth.role, Admin | Operator | Viewer) { 403 }`, and
    // `Role` has exactly those three variants (`crates/contracts/src/lib.rs:745`).
    // The condition is unsatisfiable, the branch is unreachable, and the 403 it
    // returns has never been produced by any request - a check that reads like a
    // defence and can never fire. It looked like the role guard was tested; it
    // was not, because there is nothing to test.
    //
    // What the code actually wants is "every Role may read through the gateway,
    // and a new one must not silently acquire that". An exhaustive match gives
    // that at COMPILE time, where it cannot be bypassed and where adding a variant
    // fails the build instead of shipping an untested path.
    match auth.role {
        opsweave_contracts::Role::Admin
        | opsweave_contracts::Role::Operator
        | opsweave_contracts::Role::Viewer => {}
    }
    let routes = route_candidates(&state, &plugin_id).await?;
    let Some(first) = routes.first() else {
        return Err(AppError::unavailable(
            "CAPABILITY_UNAVAILABLE",
            format!("no healthy instance is currently effective for {plugin_id}"),
        ));
    };
    let manifest: ManifestV11 = serde_json::from_value(first.manifest.clone())
        .map_err(|error| AppError::internal(format!("active manifest invalid: {error}")))?;
    let backend = manifest
        .backend
        .as_ref()
        .ok_or_else(|| AppError::bad_request("plugin has no backend service"))?;
    let requested = format!("/{path}");
    if !safe_forward_path(&requested) {
        return Err(AppError::bad_request(
            "INVALID_PLUGIN_PATH: path traversal is not allowed",
        ));
    }
    if !(requested == backend.api_prefix
        || requested.starts_with(&format!("{}/", backend.api_prefix.trim_end_matches('/'))))
    {
        return Err(AppError::not_found(
            "path is outside the plugin's registered API prefix",
        ));
    }
    let request_id = Uuid::new_v4().to_string();
    // The plugin must be able to tell "this is user X with role Y" from "the
    // client claimed role Y". Only the Kernel may answer that, and it answers
    // from the membership table at the moment of the call - not from a header
    // the request brought with it (G10 R1).
    //
    // B2.1: the answer is the SIGNED context and nothing else. The gateway used
    // to also forward `x-opsweave-user-role`; plugins fell back to it whenever
    // they did not verify the signed context, which made an unsigned header the
    // identity of any caller that could reach the plugin port. It is no longer
    // sent, and no plugin reads it.
    // One definition of membership: DataScope owns the workspace/row rule, and
    // a second copy here could drift from the endpoints the plugin's data will
    // be read through.
    let mut workspace_ids = DataScope::resolve(&state.db, &auth).await?.workspaces;
    // Stable order so the signed claim does not depend on query plan order.
    workspace_ids.sort();
    let user_context = user_context_token(
        &state,
        &first.plugin_id,
        auth.user_id,
        &auth.role.to_string(),
        workspace_ids,
        &request_id,
    )?;
    let attempts = if method == Method::GET || method == Method::HEAD {
        routes.len().max(2)
    } else {
        1
    };
    let route_start = if routes.len() > 1 {
        rand::thread_rng().gen_range(0..routes.len())
    } else {
        0
    };
    let mut last_error = None;
    for attempt in 0..attempts {
        let route = &routes[(route_start + attempt) % routes.len()];
        if let Err(error) =
            crate::nodes::validate_node_data_endpoint(&state.config, &route.data_endpoint)
        {
            last_error = Some(error.to_string());
            continue;
        }
        let query = uri
            .query()
            .map(|value| format!("?{value}"))
            .unwrap_or_default();
        let target = format!(
            "{}/internal/v1/proxy/{}{}{}",
            route.data_endpoint.trim_end_matches('/'),
            route.instance_id,
            requested,
            query
        );
        let mut request = state
            .http
            .request(method.clone(), target)
            .bearer_auth(&route.data_token)
            .header("x-opsweave-request-id", &request_id)
            .header("x-opsweave-plugin-id", &route.plugin_id)
            .header("x-opsweave-plugin-version", &route.version)
            .header(
                "x-opsweave-activation-revision",
                route.generation.to_string(),
            )
            .timeout(Duration::from_secs(
                state.config.request_timeout_seconds.max(1),
            ));
        for (name, value) in identity_headers(auth.user_id, &user_context) {
            request = request.header(name, value);
        }
        for (name, value) in headers.iter() {
            if forwards_to_plugin(name.as_str()) {
                request = request.header(name, value);
            }
        }
        if !body.is_empty() {
            request = request.body(body.clone());
        }
        match request.send().await {
            Ok(response) => {
                let status = response.status();
                if status.is_server_error() && attempt + 1 < attempts {
                    last_error = Some(format!("instance returned {status}"));
                    tokio::time::sleep(Duration::from_millis(120)).await;
                    continue;
                }
                let content_type = response
                    .headers()
                    .get(header::CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                // B2.2: bounded streaming read. `bytes()` buffered the whole body
                // before the limit was checked, so a plugin that streamed without
                // a Content-Length was fully materialised first.
                let bytes = opsweave_http_body_guard::read_bounded(
                    response,
                    MAX_RESPONSE_BYTES,
                    Some(Duration::from_secs(
                        state.config.request_timeout_seconds.max(1),
                    )),
                )
                .await
                .map_err(|failure| match failure {
                    opsweave_http_body_guard::ReadFailure::TooLarge => AppError::unavailable(
                        "UPSTREAM_RESPONSE_TOO_LARGE",
                        "plugin response exceeded the 8 MiB gateway limit",
                    ),
                    other => {
                        AppError::internal(format!("read plugin response: {}", other.as_str()))
                    }
                })?;
                let mut out = (status, bytes).into_response();
                if let Some(content_type) = content_type {
                    if let Ok(value) = header::HeaderValue::from_str(&content_type) {
                        out.headers_mut().insert(header::CONTENT_TYPE, value);
                    }
                }
                // The plugin marks its responses no-store; without forwarding
                // that (or setting it here) an intermediary could cache a
                // cookie-authenticated response and serve it to another account.
                out.headers_mut().insert(
                    header::CACHE_CONTROL,
                    header::HeaderValue::from_static("no-store"),
                );
                out.headers_mut()
                    .insert(header::VARY, header::HeaderValue::from_static("Cookie"));
                out.headers_mut().insert(
                    "x-opsweave-request-id",
                    header::HeaderValue::from_str(&request_id)
                        .map_err(|_| AppError::internal("request id header"))?,
                );
                return Ok(out);
            }
            Err(error) => {
                tracing::warn!(plugin = %plugin_id, error = %error, "gateway request failed");
                last_error = Some(error.to_string());
                if attempt + 1 >= attempts {
                    break;
                }
            }
        }
    }
    Err(AppError::unavailable(
        "UPSTREAM_UNAVAILABLE",
        last_error.unwrap_or_else(|| "plugin instance did not respond".into()),
    ))
}

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// The identity a plugin is allowed to act on, as headers.
///
/// B2.1: this list is exhaustive on purpose. `x-opsweave-user-role` is NOT here
/// and must never be added back: it is an unsigned assertion, and a plugin that
/// falls back to it turns "the caller typed admin" into an administrative
/// grant. The signature over `x-opsweave-user-context` is the whole identity;
/// the user id beside it is a convenience for logging, and no plugin decides
/// access from it alone.
fn identity_headers(user_id: Uuid, user_context: &str) -> Vec<(&'static str, String)> {
    vec![
        ("x-opsweave-user-id", user_id.to_string()),
        ("x-opsweave-user-context", user_context.to_string()),
    ]
}

/// Whether a caller-supplied header may be copied to the plugin.
///
/// Extracted from the forwarding loop so the RULE can be tested directly. The
/// earlier test re-typed the `matches!` arm inside the test body - so deleting the
/// guard from the loop left it green, because it was comparing the test's copy of
/// the rule against the test's copy of the rule.
///
/// Two classes are refused:
///   * `x-opsweave-*` - the gateway owns every name in that namespace.
///     `identity_headers` sets the two signed ones BEFORE this loop runs, so a
///     forged `x-opsweave-user-context` would overwrite it if this did not skip.
///   * hop-by-hop and credential headers - forwarding `authorization` would hand a
///     plugin the caller's token, and `host` would let a caller pick the TLS/SNI
///     identity the plugin sees.
pub(crate) fn forwards_to_plugin(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if lower.starts_with("x-opsweave-") {
        return false;
    }
    !matches!(
        lower.as_str(),
        "host"
            | "authorization"
            | "cookie"
            | "content-length"
            | "connection"
            | "transfer-encoding"
            | "upgrade"
    )
}

fn safe_forward_path(path: &str) -> bool {
    if path.contains('\0') || path.contains('\\') || path.contains('\\') {
        return false;
    }
    for segment in path.split('/') {
        let decoded = urlencoding::decode(segment)
            .map(|value| value.into_owned())
            .unwrap_or_else(|_| segment.to_string());
        if decoded == "." || decoded == ".." || decoded.contains('/') || decoded.contains('\\') {
            return false;
        }
    }
    true
}

async fn route_candidates(state: &AppState, plugin_id: &str) -> AppResult<Vec<RouteRow>> {
    let rows = sqlx::query_as::<_, RouteRow>(
        r#"
        SELECT i.id AS instance_id, i.node_id, n.data_endpoint, n.data_token,
               p.manifest, r.generation, r.plugin_id, r.version
        FROM kernel.activation_revisions r
        JOIN kernel.plugin_deployments d ON d.id = r.deployment_id
        JOIN kernel.plugin_packages p ON p.package_id = r.package_id
        JOIN kernel.trusted_publishers tp ON tp.publisher_id = p.publisher
        JOIN kernel.plugin_instances i ON i.deployment_id = d.id
        JOIN kernel.nodes n ON n.id = i.node_id
        WHERE r.plugin_id = $1
          AND r.status = 'ACTIVE'
          AND tp.trust_state = 'TRUSTED'
          AND i.state = 'READY'
          AND i.desired_action = 'START'
          AND n.revoked_at IS NULL
          AND n.status = 'READY'
          AND n.last_seen_at > now() - ($2 || ' seconds')::interval
          AND n.data_endpoint IS NOT NULL
        ORDER BY i.slot
        "#,
    )
    .bind(plugin_id)
    .bind(state.config.node_stale_seconds)
    .fetch_all(&state.db)
    .await?;
    Ok(rows)
}

#[cfg(test)]
mod tests {
    // `route_candidates` is imported inside `route_gates` instead: it only
    // exists with the default features, and a top-level import breaks
    // `cargo clippy --no-default-features -- -D warnings` with "unused import".
    use super::{forwards_to_plugin, identity_headers, safe_forward_path};
    use uuid::Uuid;

    #[test]
    fn the_gateway_never_forwards_an_unsigned_role() {
        let headers = identity_headers(Uuid::nil(), "owu1.payload.signature");
        let names: Vec<&str> = headers.iter().map(|(name, _)| *name).collect();
        assert!(
            !names.contains(&"x-opsweave-user-role"),
            "an unsigned role header must never be forwarded: plugins would read it as identity"
        );
        assert_eq!(
            names,
            vec!["x-opsweave-user-id", "x-opsweave-user-context"],
            "the identity header set is exhaustive; adding one is a security decision"
        );
    }

    #[test]
    fn rejects_path_traversal_variants() {
        assert!(safe_forward_path("/api/hello"));
        assert!(safe_forward_path("/api/hello/items/1"));
        assert!(!safe_forward_path("/api/../admin"));
        assert!(!safe_forward_path("/api/%2e%2e/admin"));
        assert!(!safe_forward_path("/api/%2E%2E/admin"));
        assert!(!safe_forward_path("/api/%2fadmin"));
        assert!(!safe_forward_path("/api\\admin"));
    }

    /// A client-supplied identity header must not survive to the plugin.
    ///
    /// The forwarding loop skips any name starting with `x-opsweave-` and a fixed
    /// list of hop-by-hop and credential headers. That ordering matters and was
    /// never asserted: `identity_headers` is applied BEFORE the copy loop, so if
    /// the copy did not skip the prefix, a forged `x-opsweave-user-context` would
    /// overwrite the Kernel-signed one and the plugin would believe whatever the
    /// caller wrote.
    ///
    /// This is the header-injection case TASK-25 lists and nothing tested. The
    /// assertion is on the FORWARDING RULE rather than on a live socket, because
    /// the rule is where the decision is made.
    #[test]
    fn a_caller_cannot_smuggle_an_identity_header_past_the_gateway() {
        // Every name the copy loop must refuse, in the spelling a client would
        // send it. `to_ascii_lowercase` in the loop means an upper-case variant is
        // the same header, so both spellings are listed.
        let refused = [
            "x-opsweave-user-id",
            "x-opsweave-user-context",
            "X-OpsWeave-User-Context",
            "x-opsweave-user-role",
            "x-opsweave-plugin-id",
            "x-opsweave-anything-new",
            "host",
            "authorization",
            "Authorization",
            "cookie",
            "content-length",
            "connection",
            "transfer-encoding",
            "upgrade",
        ];
        for name in refused {
            assert!(
                !forwards_to_plugin(name),
                "\"{name}\" would be forwarded to the plugin; a caller could set an \
                 identity or credential header the gateway is supposed to own"
            );
        }

        // The inverse: ordinary request headers must still reach the plugin, or
        // "safe" would mean "the gateway drops the request body's metadata".
        for name in ["content-type", "accept", "x-request-id", "if-none-match"] {
            assert!(
                forwards_to_plugin(name),
                "\"{name}\" is a normal header and must be forwarded"
            );
        }

        // And the signed set the gateway DOES send is exactly two names. Adding a
        // third is a security decision, which is why it is pinned.
        let signed: Vec<&str> = identity_headers(Uuid::nil(), "owu1.a.b")
            .iter()
            .map(|(n, _)| *n)
            .collect();
        assert_eq!(
            signed,
            vec!["x-opsweave-user-id", "x-opsweave-user-context"],
            "the signed identity header set changed; every plugin reads this contract"
        );
    }

    /// The five gates `route_candidates` puts between a plugin id and a socket.
    ///
    /// TASK-19 lists these as the attack matrix: a revoked publisher, a revoked
    /// node, a disabled activation, a stale node, and a non-READY instance. The
    /// query enforces all five (`trust_state = 'TRUSTED'`, `revoked_at IS NULL`,
    /// `r.status = 'ACTIVE'`, the staleness predicate, `i.state = 'READY'`) and
    /// **none of them had a test**. A predicate in a WHERE clause with no
    /// counterfactual is a comment: deleting one line changes routing for every
    /// plugin on the platform and every existing test still passes.
    ///
    /// Each case below removes exactly one condition and asserts the route
    /// disappears. They share one fixture so a single bad insert cannot make a
    /// case pass for the wrong reason.
    #[cfg(test)]
    mod route_gates {
        use super::super::{route_candidates, RouteRow};
        use crate::state::{AppState, RateLimiter};
        use sqlx::postgres::PgConnectOptions;
        use sqlx::PgPool;
        use std::sync::Arc;
        use uuid::Uuid;

        const REQUIRE: &str = "OPSWEAVE_REQUIRE_TEST_DATABASE";

        async fn pool() -> Option<PgPool> {
            let url = match std::env::var("OPSWEAVE_TEST_DATABASE_URL") {
                Ok(url) => url,
                Err(_) => {
                    if std::env::var(REQUIRE).ok().as_deref() == Some("1") {
                        panic!("{REQUIRE} is set but OPSWEAVE_TEST_DATABASE_URL is unset");
                    }
                    eprintln!("skip: OPSWEAVE_TEST_DATABASE_URL is unset");
                    return None;
                }
            };
            let options: PgConnectOptions = url.parse().expect("test database URL parses");
            let pool = PgPool::connect_with(options).await.expect("connects");
            crate::db::migrate(&pool).await.expect("migrates");
            Some(pool)
        }

        /// Everything the route needs, all gates open, plus handles to close each
        /// one individually.
        struct Fixture {
            plugin: String,
            publisher: String,
            node: Uuid,
            instance: Uuid,
            revision: Uuid,
            // `package` and `deployment` were read by nothing: the cases reach
            // them through `instance`/`revision`, which cascade. Keeping unused
            // fields cost a `-D warnings` failure on the no-default-features
            // build only, which is exactly the kind of difference between two
            // CI commands that local runs with one feature set do not catch.
        }

        async fn fixture(pool: &PgPool) -> Fixture {
            let tag = Uuid::new_v4().simple().to_string();
            let plugin = format!("test.gate.{tag}");
            let publisher = format!("pub-{tag}");
            let node = Uuid::new_v4();
            let package = Uuid::new_v4();
            let deployment = Uuid::new_v4();
            let instance = Uuid::new_v4();
            let revision = Uuid::new_v4();

            sqlx::query(
                "INSERT INTO kernel.trusted_publishers
                   (publisher_id, public_key_hex, fingerprint, trust_state)
                 VALUES ($1,'00','fp','TRUSTED')",
            )
            .bind(&publisher)
            .execute(pool)
            .await
            .expect("publisher");

            // `data_endpoint` must be present: the route query requires it, and a
            // null one would make every case fail on the control assertion rather
            // than on the gate under test. `last_seen_at` is refreshed at read
            // time in `routes()` for the same reason - see the note there.
            sqlx::query(
                "INSERT INTO kernel.nodes
                   (id, name, control_token_hash, data_token, generation, os, arch,
                    labels, capabilities, status, enrolled_at, last_seen_at, data_endpoint)
                 VALUES ($1,$2,'x','tok',1,'linux','amd64','{}'::jsonb,'[]'::jsonb,
                         'READY',now(),now(),'http://127.0.0.1:1')",
            )
            .bind(node)
            .bind(format!("gate-node-{tag}"))
            .execute(pool)
            .await
            .expect("node");

            sqlx::query(
                "INSERT INTO kernel.plugin_packages
                   (package_id, plugin_id, version, schema_version, publisher, manifest,
                    artifact_digest, bundle_digest, payload_digest, status, signature_state)
                 VALUES ($1,$2,'1.0.0','1.1',$3,'{}'::jsonb,$4,$5,$6,'INSTALLED','VERIFIED')",
            )
            .bind(package)
            .bind(&plugin)
            .bind(&publisher)
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .bind(format!("sha256:{}", Uuid::new_v4().simple()))
            .execute(pool)
            .await
            .expect("package");

            sqlx::query(
                "INSERT INTO kernel.plugin_deployments
                   (id, plugin_id, package_id, version, desired_replicas, generation,
                    placement, resources, status, created_at, updated_at)
                 VALUES ($1,$2,$3,'1.0.0',1,1,'{}'::jsonb,
                         '{\"cpuMillis\":100,\"memoryMiB\":128}'::jsonb,'ACTIVE',now(),now())",
            )
            .bind(deployment)
            .bind(&plugin)
            .bind(package)
            .execute(pool)
            .await
            .expect("deployment");

            sqlx::query(
                "INSERT INTO kernel.plugin_instances
                   (id, deployment_id, node_id, slot, deployment_generation,
                    desired_action, state)
                 VALUES ($1,$2,$3,0,1,'START','READY')",
            )
            .bind(instance)
            .bind(deployment)
            .bind(node)
            .execute(pool)
            .await
            .expect("instance");

            sqlx::query(
                "INSERT INTO kernel.activation_revisions
                   (id, plugin_id, package_id, version, deployment_id, generation,
                    status, policy_digest, activated_at)
                 VALUES ($1,$2,$3,'1.0.0',$4,1,'ACTIVE','d',now())",
            )
            .bind(revision)
            .bind(&plugin)
            .bind(package)
            .bind(deployment)
            .execute(pool)
            .await
            .expect("revision");

            Fixture {
                plugin,
                publisher,
                node,
                instance,
                revision,
            }
        }

        fn state(pool: &PgPool) -> AppState {
            AppState {
                config: Arc::new(crate::config::Config::from_env()),
                db: pool.clone(),
                http: reqwest::Client::new(),
                cursor_secret: Arc::new(vec![0u8; 32]),
                rate_limiter: Arc::new(RateLimiter::default()),
            }
        }

        async fn routes(pool: &PgPool, plugin: &str) -> Vec<RouteRow> {
            // Refresh ONLY this fixture's nodes.
            //
            // `node_stale_seconds` is 25 by default and the suite creates a dozen
            // fixtures across tests that share one database, so a node inserted
            // two assertions ago is stale by the third. The first version of this
            // refreshed every node - `WHERE revoked_at IS NULL` - which also
            // un-staled the fixtures other concurrently running tests had
            // deliberately aged, so `a_stale_node_stops_routing` failed under the
            // default parallel `cargo test` and passed at `--test-threads=1`.
            // Scoping the update to the plugin under test fixes both.
            sqlx::query(
                "UPDATE kernel.nodes SET last_seen_at = now()
                 WHERE revoked_at IS NULL AND id IN (
                   SELECT i.node_id FROM kernel.plugin_instances i
                   JOIN kernel.plugin_deployments d ON d.id = i.deployment_id
                   WHERE d.plugin_id = $1)",
            )
            .bind(plugin)
            .execute(pool)
            .await
            .expect("heartbeat refresh");
            routes_raw(pool, plugin).await
        }

        /// No heartbeat refresh. For the cases that need to control staleness
        /// themselves - `routes()` would undo the very condition under test.
        async fn routes_raw(pool: &PgPool, plugin: &str) -> Vec<RouteRow> {
            route_candidates(&state(pool), plugin)
                .await
                .expect("query runs")
        }

        #[tokio::test]
        async fn an_all_green_route_is_reachable() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            let got = routes(&pool, &f.plugin).await;
            assert_eq!(got.len(), 1, "the control case: every gate open must route");
            assert_eq!(got[0].instance_id, f.instance);
        }

        #[tokio::test]
        async fn a_revoked_publisher_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            sqlx::query(
                "UPDATE kernel.trusted_publishers SET trust_state='REVOKED' WHERE publisher_id=$1",
            )
            .bind(&f.publisher)
            .execute(&pool)
            .await
            .unwrap();
            assert!(
                routes(&pool, &f.plugin).await.is_empty(),
                "a package signed by a revoked publisher must not be served"
            );
        }

        #[tokio::test]
        async fn a_revoked_node_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            sqlx::query("UPDATE kernel.nodes SET revoked_at=now() WHERE id=$1")
                .bind(f.node)
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                routes(&pool, &f.plugin).await.is_empty(),
                "a revoked node must not serve"
            );
        }

        #[tokio::test]
        async fn a_stale_node_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            sqlx::query(
                "UPDATE kernel.nodes SET last_seen_at = now() - interval '1 day' WHERE id=$1",
            )
            .bind(f.node)
            .execute(&pool)
            .await
            .unwrap();
            assert!(
                routes_raw(&pool, &f.plugin).await.is_empty(),
                "a node that stopped reporting must not be routed to, however healthy its last word"
            );
        }

        #[tokio::test]
        async fn a_disabled_activation_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            sqlx::query("UPDATE kernel.activation_revisions SET status='DISABLED' WHERE id=$1")
                .bind(f.revision)
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                routes(&pool, &f.plugin).await.is_empty(),
                "a disabled activation must not route"
            );
        }

        #[tokio::test]
        async fn a_superseded_activation_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            sqlx::query("UPDATE kernel.activation_revisions SET status='SUPERSEDED' WHERE id=$1")
                .bind(f.revision)
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                routes(&pool, &f.plugin).await.is_empty(),
                "only the ACTIVE revision routes"
            );
        }

        #[tokio::test]
        async fn a_stopped_instance_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            sqlx::query("UPDATE kernel.plugin_instances SET desired_action='STOP' WHERE id=$1")
                .bind(f.instance)
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                routes(&pool, &f.plugin).await.is_empty(),
                "a stopped instance is not a destination"
            );
        }

        #[tokio::test]
        async fn an_instance_that_is_not_ready_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            // The constraint `plugin_instances_state_check` allows
            // STARTING/READY/UNHEALTHY/UNREACHABLE/STOPPED/UNKNOWN. `STOPPING` is
            // not one of them - an earlier version of this loop used it and failed
            // with a CHECK violation rather than an assertion, which reads as a
            // schema problem instead of a test problem.
            for state in ["STARTING", "UNHEALTHY", "UNREACHABLE", "UNKNOWN", "STOPPED"] {
                sqlx::query("UPDATE kernel.plugin_instances SET state=$2 WHERE id=$1")
                    .bind(f.instance)
                    .bind(state)
                    .execute(&pool)
                    .await
                    .unwrap();
                assert!(
                    routes(&pool, &f.plugin).await.is_empty(),
                    "an instance in {state} must not receive traffic"
                );
            }
        }

        #[tokio::test]
        async fn a_node_with_no_data_endpoint_stops_routing() {
            let Some(pool) = pool().await else { return };
            let f = fixture(&pool).await;
            sqlx::query("UPDATE kernel.nodes SET data_endpoint=NULL WHERE id=$1")
                .bind(f.node)
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                routes(&pool, &f.plugin).await.is_empty(),
                "there is nowhere to forward to; a null endpoint must not become an empty URL"
            );
        }

        #[tokio::test]
        async fn one_plugin_cannot_route_through_another_plugins_activation() {
            let Some(pool) = pool().await else { return };
            let a = fixture(&pool).await;
            let b = fixture(&pool).await;
            // B's instance is healthy and its node is fine; asking for A must not
            // find it. This is the cross-plugin identity boundary, asserted at the
            // routing layer rather than only in the plugin's own handler.
            assert_eq!(routes(&pool, &a.plugin).await.len(), 1);
            assert_eq!(routes(&pool, &b.plugin).await.len(), 1);
            assert_ne!(a.instance, b.instance);
            assert!(routes(&pool, "test.gate.nobody").await.is_empty());
        }

        #[tokio::test]
        async fn the_gates_are_independent() {
            let Some(pool) = pool().await else { return };
            // Two fixtures, one gate closed on each, so a change that only checks
            // "is anything wrong" instead of each condition fails here.
            let a = fixture(&pool).await;
            let b = fixture(&pool).await;
            sqlx::query(
                "UPDATE kernel.trusted_publishers SET trust_state='REVOKED' WHERE publisher_id=$1",
            )
            .bind(&a.publisher)
            .execute(&pool)
            .await
            .unwrap();
            sqlx::query("UPDATE kernel.nodes SET revoked_at=now() WHERE id=$1")
                .bind(b.node)
                .execute(&pool)
                .await
                .unwrap();
            assert!(
                routes(&pool, &a.plugin).await.is_empty(),
                "A closed by publisher"
            );
            assert!(
                routes(&pool, &b.plugin).await.is_empty(),
                "B closed by node"
            );
        }
    }
}
