use crate::error::{AppError, AppResult};
use crate::state::AppState;
use argon2::password_hash::rand_core::OsRng;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use opsweave_contracts::Role;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use std::net::SocketAddr;
use std::time::Duration as StdDuration;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: Role,
    pub session_id: Uuid,
    pub csrf_token: String,
    pub via_cookie: bool,
}

impl AuthUser {
    pub fn require_operator(&self) -> AppResult<()> {
        if self.role.can_operate() {
            Ok(())
        } else {
            Err(AppError::forbidden(
                "This action requires the operator or admin role",
            ))
        }
    }

    pub fn require_admin(&self) -> AppResult<()> {
        if self.role.is_admin() {
            Ok(())
        } else {
            Err(AppError::forbidden("This action requires the admin role"))
        }
    }
}

/// Surfaces a session may enter, as declared by `GET /api/v1/auth/me`.
pub const SURFACE_WORKSPACE: &str = "workspace";
pub const SURFACE_ADMIN: &str = "admin";
/// Capabilities derived from the same declaration.
pub const CAPABILITY_PLATFORM_ACCESS: &str = "platform:access";
pub const CAPABILITY_WORKSPACE_ACCESS: &str = "workspace:access";

/// Server-authoritative surface declaration returned by `GET /api/v1/auth/me`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AccessView {
    pub allowed_surfaces: Vec<&'static str>,
    pub capabilities: Vec<&'static str>,
}

/// Derives the declared surfaces and capabilities for one role.
///
/// Every authenticated session may enter the workspace surface; the Admin
/// Console surface is granted only to the roles listed by
/// `OPSWEAVE_ADMIN_SURFACE_ROLES` (default `admin`, widened per deployment after
/// an audit). This is a navigation and routing declaration only: it neither
/// widens nor narrows any existing `require_admin`/`require_operator` API gate,
/// and the browser must never derive it from `user.role` itself.
pub fn access_for(role: Role, admin_surface_roles: &[Role]) -> AccessView {
    if admin_surface_roles.contains(&role) {
        AccessView {
            allowed_surfaces: vec![SURFACE_WORKSPACE, SURFACE_ADMIN],
            capabilities: vec![CAPABILITY_PLATFORM_ACCESS, CAPABILITY_WORKSPACE_ACCESS],
        }
    } else {
        AccessView {
            allowed_surfaces: vec![SURFACE_WORKSPACE],
            capabilities: vec![CAPABILITY_WORKSPACE_ACCESS],
        }
    }
}

#[derive(Debug, FromRow)]
struct SessionRow {
    session_id: Uuid,
    csrf_token: String,
    expires_at: DateTime<Utc>,
    user_id: Uuid,
    email: String,
    display_name: String,
    role: String,
    disabled: bool,
}

impl<S> FromRequestParts<S> for AuthUser
where
    S: Send + Sync,
{
    type Rejection = AppError;

    async fn from_request_parts(parts: &mut Parts, _state: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<AuthUser>()
            .cloned()
            .ok_or_else(|| AppError::unauthorized("Authentication required"))
    }
}

pub async fn auth_middleware(
    State(state): State<AppState>,
    mut request: Request,
    next: Next,
) -> Response {
    let headers = request.headers().clone();
    let (token, via_cookie) = match bearer_token(&headers) {
        Some(token) => (token, false),
        None => match cookie_value(&headers, "opsweave_session") {
            Some(token) => (token, true),
            None => {
                return AppError::unauthorized("Authentication required").into_response();
            }
        },
    };
    let token_hash = hash_token(&token);
    let row = sqlx::query_as::<_, SessionRow>(
        r#"
        SELECT s.id AS session_id, s.csrf_token, s.expires_at,
               u.id AS user_id, u.email, u.display_name, u.role, u.disabled
        FROM kernel.sessions s
        JOIN kernel.users u ON u.id = s.user_id
        WHERE s.token_hash = $1
        "#,
    )
    .bind(&token_hash)
    .fetch_optional(&state.db)
    .await;
    let row = match row {
        Ok(Some(row)) => row,
        Ok(None) => return AppError::unauthorized("Session is invalid or expired").into_response(),
        Err(error) => return AppError::internal(error).into_response(),
    };
    if row.expires_at <= Utc::now() || row.disabled {
        return AppError::unauthorized("Session is invalid or expired").into_response();
    }
    let role: Role = row.role.parse().unwrap_or(Role::Viewer);
    let auth = AuthUser {
        user_id: row.user_id,
        email: row.email,
        display_name: row.display_name,
        role,
        session_id: row.session_id,
        csrf_token: row.csrf_token,
        via_cookie,
    };
    let _ = sqlx::query("UPDATE kernel.sessions SET last_seen_at = now() WHERE id = $1")
        .bind(row.session_id)
        .execute(&state.db)
        .await;
    request.extensions_mut().insert(auth);
    next.run(request).await
}

pub async fn csrf_middleware(
    State(_state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    if matches!(method, Method::GET | Method::HEAD | Method::OPTIONS) {
        return next.run(request).await;
    }
    let Some(auth) = request.extensions().get::<AuthUser>().cloned() else {
        return AppError::unauthorized("Authentication required").into_response();
    };
    if auth.via_cookie {
        let sent = request
            .headers()
            .get("x-csrf-token")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default();
        if sent != auth.csrf_token {
            return AppError::new(
                StatusCode::FORBIDDEN,
                "CSRF_FAILED",
                "Missing or invalid X-CSRF-Token header",
            )
            .into_response();
        }
    }
    next.run(request).await
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserView {
    pub id: Uuid,
    pub email: String,
    pub display_name: String,
    pub role: Role,
}

fn client_ip(
    peer: SocketAddr,
    headers: &HeaderMap,
    trusted_proxies: &[String],
) -> std::net::IpAddr {
    let proxy_ip = peer.ip();
    if !trusted_proxies
        .iter()
        .any(|trusted| trusted == &proxy_ip.to_string())
    {
        return proxy_ip;
    }
    let Some(chain) = headers
        .get("x-forwarded-for")
        .and_then(|value| value.to_str().ok())
    else {
        return proxy_ip;
    };
    let hops: Vec<std::net::IpAddr> = chain
        .split(',')
        .filter_map(|hop| hop.trim().parse().ok())
        .collect();
    // Walk from the trusted proxy side toward the client. A client-supplied
    // leftmost value must never win over the rightmost trusted hop.
    for hop in hops.iter().rev() {
        if !trusted_proxies
            .iter()
            .any(|trusted| trusted == &hop.to_string())
        {
            return *hop;
        }
    }
    hops.first().copied().unwrap_or(proxy_ip)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginResponse {
    pub user: UserView,
    pub csrf_token: String,
    pub expires_at: DateTime<Utc>,
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<LoginRequest>,
) -> AppResult<Response> {
    if payload.email.trim().is_empty() || payload.password.is_empty() {
        return Err(AppError::bad_request("email and password are required"));
    }
    let email_key = format!("login:email:{}", payload.email.trim().to_ascii_lowercase());
    // ConnectInfo contains an ephemeral source port. Rate-limit by IP only, and
    // only honor X-Forwarded-For when the immediate peer is an explicitly
    // configured trusted proxy.
    let client_ip = client_ip(peer, &headers, &state.config.trusted_proxy_ips);
    let ip_key = format!("login:ip:{client_ip}");
    let window = StdDuration::from_secs(300);
    if state.rate_limiter.is_limited(&email_key, 10, window)
        || state.rate_limiter.is_limited(&ip_key, 60, window)
    {
        return Err(AppError::too_many_requests(
            "LOGIN_RATE_LIMITED",
            "too many failed authentication attempts; retry later",
        ));
    }
    let row = sqlx::query_as::<_, (Uuid, String, String, String, String, bool)>(
        "SELECT id, email, display_name, password_hash, role, disabled FROM kernel.users WHERE lower(email) = lower($1)",
    )
    .bind(payload.email.trim())
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| {
        state.rate_limiter.record_failure(&email_key, window);
        state.rate_limiter.record_failure(&ip_key, window);
        AppError::unauthorized("Invalid email or password")
    })?;
    if row.5 {
        state.rate_limiter.record_failure(&email_key, window);
        state.rate_limiter.record_failure(&ip_key, window);
        return Err(AppError::unauthorized("Invalid email or password"));
    }
    let parsed = PasswordHash::new(&row.3)
        .map_err(|_| AppError::internal("stored password hash is invalid"))?;
    if Argon2::default()
        .verify_password(payload.password.as_bytes(), &parsed)
        .is_err()
    {
        state.rate_limiter.record_failure(&email_key, window);
        state.rate_limiter.record_failure(&ip_key, window);
        return Err(AppError::unauthorized("Invalid email or password"));
    }
    state.rate_limiter.reset(&email_key);
    state.rate_limiter.reset(&ip_key);

    let token = random_token(32);
    let csrf = random_token(24);
    let session_id = Uuid::new_v4();
    let expires_at = Utc::now() + Duration::hours(state.config.session_hours.max(1));
    sqlx::query(
        "INSERT INTO kernel.sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES ($1,$2,$3,$4,$5)",
    )
    .bind(session_id)
    .bind(row.0)
    .bind(hash_token(&token))
    .bind(&csrf)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    let role: Role = row.4.parse().unwrap_or(Role::Viewer);
    let secure = if state.config.secure_cookies() {
        "; Secure"
    } else {
        ""
    };
    let cookie = format!(
        "opsweave_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}{secure}",
        (expires_at - Utc::now()).num_seconds().max(1)
    );
    let body = LoginResponse {
        user: UserView {
            id: row.0,
            email: row.1,
            display_name: row.2,
            role,
        },
        csrf_token: csrf,
        expires_at,
    };
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        header::HeaderValue::from_str(&cookie)
            .map_err(|_| AppError::internal("failed to encode session cookie"))?,
    );
    Ok(response)
}

pub async fn logout(State(state): State<AppState>, request: Request) -> AppResult<Response> {
    let auth = request
        .extensions()
        .get::<AuthUser>()
        .cloned()
        .ok_or_else(|| AppError::unauthorized("Authentication required"))?;
    sqlx::query("DELETE FROM kernel.sessions WHERE id = $1")
        .bind(auth.session_id)
        .execute(&state.db)
        .await?;
    let mut response = Json(serde_json::json!({"ok": true})).into_response();
    response.headers_mut().insert(
        header::SET_COOKIE,
        header::HeaderValue::from_static(
            "opsweave_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
        ),
    );
    Ok(response)
}

/// Payload of `GET /api/v1/auth/me`.
///
/// Additive only: `user` and the top-level `csrfToken` keep their pre-G05 names
/// and values so old clients keep working; `session` groups the session-scoped
/// facts under the agreed name; `access` is the server-authoritative surface
/// declaration the browser must render navigation from, never `user.role`.
pub fn me_payload(auth: &AuthUser, admin_surface_roles: &[Role]) -> serde_json::Value {
    serde_json::json!({
        "user": {
            "id": auth.user_id,
            "email": auth.email,
            "displayName": auth.display_name,
            "role": auth.role,
        },
        "session": {
            "csrfToken": auth.csrf_token,
            "viaCookie": auth.via_cookie,
        },
        "csrfToken": auth.csrf_token,
        "access": access_for(auth.role, admin_surface_roles),
    })
}

pub async fn me(
    State(state): State<AppState>,
    request: Request,
) -> AppResult<Json<serde_json::Value>> {
    let auth = request
        .extensions()
        .get::<AuthUser>()
        .cloned()
        .ok_or_else(|| AppError::unauthorized("Authentication required"))?;
    Ok(Json(me_payload(&auth, &state.config.admin_surface_roles)))
}

pub async fn seed_admin(state: &AppState) -> anyhow::Result<()> {
    let Some(email) = state.config.bootstrap_admin_email.clone() else {
        return Ok(());
    };
    let Some(password) = state.config.bootstrap_admin_password.clone() else {
        anyhow::bail!(
            "OPSWEAVE_BOOTSTRAP_ADMIN_EMAIL is set but OPSWEAVE_BOOTSTRAP_ADMIN_PASSWORD is not"
        );
    };
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM kernel.users")
        .fetch_one(&state.db)
        .await?;
    if count > 0 {
        return Ok(());
    }
    let salt = SaltString::generate(&mut OsRng);
    let hash = Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|error| anyhow::anyhow!("password hash failed: {error}"))?
        .to_string();
    sqlx::query(
        "INSERT INTO kernel.users (id, email, display_name, password_hash, role) VALUES ($1,$2,$3,$4,'admin')",
    )
    .bind(Uuid::new_v4())
    .bind(email.to_lowercase())
    .bind(&state.config.bootstrap_admin_name)
    .bind(hash)
    .execute(&state.db)
    .await?;
    tracing::info!(email = %email, "bootstrap admin created");
    Ok(())
}

pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

pub fn random_token(bytes: usize) -> String {
    let mut data = vec![0_u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut data);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

pub fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let mut pieces = part.trim().splitn(2, '=');
        if pieces.next() == Some(name) {
            return pieces.next().map(str::to_string);
        }
    }
    None
}

pub fn bearer_token(headers: &HeaderMap) -> Option<String> {
    let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    value
        .strip_prefix("Bearer ")
        .map(str::trim)
        .filter(|token| !token.is_empty())
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::{
        access_for, client_ip, AccessView, AuthUser, CAPABILITY_PLATFORM_ACCESS,
        CAPABILITY_WORKSPACE_ACCESS, SURFACE_ADMIN, SURFACE_WORKSPACE,
    };
    use crate::config::parse_admin_surface_roles;
    use crate::error::AppResult;
    use axum::http::{HeaderMap, StatusCode};
    use opsweave_contracts::Role;
    use std::net::SocketAddr;
    use uuid::Uuid;

    fn auth_user(role: Role) -> AuthUser {
        AuthUser {
            user_id: Uuid::nil(),
            email: "user@example.invalid".to_string(),
            display_name: "Test User".to_string(),
            role,
            session_id: Uuid::nil(),
            csrf_token: "csrf-token".to_string(),
            via_cookie: false,
        }
    }

    fn access(role: Role, raw_env: &str) -> AccessView {
        access_for(role, &parse_admin_surface_roles(raw_env))
    }

    #[test]
    fn rate_limit_key_ignores_ephemeral_port() {
        let headers = HeaderMap::new();
        let first: SocketAddr = "203.0.113.7:41001".parse().unwrap();
        let second: SocketAddr = "203.0.113.7:55002".parse().unwrap();
        assert_eq!(
            client_ip(first, &headers, &[]),
            client_ip(second, &headers, &[])
        );
    }

    #[test]
    fn forwarded_for_requires_an_explicit_trusted_proxy() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "198.51.100.9".parse().unwrap());
        let peer: SocketAddr = "203.0.113.7:41001".parse().unwrap();
        assert_eq!(client_ip(peer, &headers, &[]), peer.ip());
        assert_eq!(
            client_ip(peer, &headers, &["203.0.113.7".to_string()]),
            "198.51.100.9".parse::<std::net::IpAddr>().unwrap()
        );
        let mut chain = HeaderMap::new();
        chain.insert(
            "x-forwarded-for",
            "198.51.100.9, 203.0.113.8".parse().unwrap(),
        );
        assert_eq!(
            client_ip(
                peer,
                &chain,
                &["203.0.113.7".to_string(), "203.0.113.8".to_string()]
            ),
            "198.51.100.9".parse::<std::net::IpAddr>().unwrap()
        );
    }

    #[test]
    fn access_matrix_under_the_default_admin_only_configuration() {
        let admin = access(Role::Admin, "admin");
        assert_eq!(
            admin.allowed_surfaces,
            vec![SURFACE_WORKSPACE, SURFACE_ADMIN]
        );
        assert_eq!(
            admin.capabilities,
            vec![CAPABILITY_PLATFORM_ACCESS, CAPABILITY_WORKSPACE_ACCESS]
        );
        for role in [Role::Operator, Role::Viewer] {
            let declaration = access(role, "admin");
            assert_eq!(declaration.allowed_surfaces, vec![SURFACE_WORKSPACE]);
            assert_eq!(declaration.capabilities, vec![CAPABILITY_WORKSPACE_ACCESS]);
        }
    }

    #[test]
    fn access_declaration_serializes_to_the_contract_field_names() {
        let value = serde_json::to_value(access(Role::Admin, "admin")).unwrap();
        assert_eq!(
            value["allowedSurfaces"],
            serde_json::json!(["workspace", "admin"])
        );
        assert_eq!(
            value["capabilities"],
            serde_json::json!(["platform:access", "workspace:access"])
        );
        assert!(value.get("allowed_surfaces").is_none());
    }

    #[test]
    fn operator_enters_the_admin_surface_only_through_the_env_override() {
        let widened = access(Role::Operator, "operator");
        assert_eq!(
            widened.allowed_surfaces,
            vec![SURFACE_WORKSPACE, SURFACE_ADMIN]
        );
        assert_eq!(
            widened.capabilities,
            vec![CAPABILITY_PLATFORM_ACCESS, CAPABILITY_WORKSPACE_ACCESS]
        );
        // Widening for operator must not disturb the other roles.
        assert_eq!(
            access(Role::Viewer, "operator").allowed_surfaces,
            vec![SURFACE_WORKSPACE]
        );
        assert_eq!(
            access(Role::Admin, "operator").capabilities,
            vec![CAPABILITY_PLATFORM_ACCESS, CAPABILITY_WORKSPACE_ACCESS]
        );
    }

    #[test]
    fn invalid_admin_surface_env_never_widens_the_surface() {
        for raw in ["", "operator,nope", "superuser"] {
            assert_eq!(
                access(Role::Operator, raw).allowed_surfaces,
                vec![SURFACE_WORKSPACE],
                "raw={raw:?}"
            );
            assert_eq!(
                access(Role::Admin, raw).allowed_surfaces,
                vec![SURFACE_WORKSPACE, SURFACE_ADMIN],
                "raw={raw:?}"
            );
        }
    }

    #[test]
    fn me_payload_is_additive_and_carries_the_declared_access() {
        let payload =
            super::me_payload(&auth_user(Role::Admin), &parse_admin_surface_roles("admin"));
        assert_eq!(
            payload,
            serde_json::json!({
                "user": {
                    "id": Uuid::nil(),
                    "email": "user@example.invalid",
                    "displayName": "Test User",
                    "role": "admin",
                },
                "session": { "csrfToken": "csrf-token", "viaCookie": false },
                "csrfToken": "csrf-token",
                "access": {
                    "allowedSurfaces": ["workspace", "admin"],
                    "capabilities": ["platform:access", "workspace:access"],
                },
            })
        );
        // A role outside the admin surface hint declares the workspace only; the
        // pre-G05 fields are byte-identical regardless of role.
        let operator = super::me_payload(
            &auth_user(Role::Operator),
            &parse_admin_surface_roles("admin"),
        );
        assert_eq!(operator["csrfToken"], serde_json::json!("csrf-token"));
        assert_eq!(
            operator["session"]["csrfToken"],
            serde_json::json!("csrf-token")
        );
        assert_eq!(
            operator["access"],
            serde_json::json!({
                "allowedSurfaces": ["workspace"],
                "capabilities": ["workspace:access"],
            })
        );
    }

    #[test]
    fn viewer_is_forbidden_by_every_existing_role_gate() {
        let viewer = auth_user(Role::Viewer);
        let admin_gate = viewer.require_admin().unwrap_err();
        assert_eq!(admin_gate.status, StatusCode::FORBIDDEN);
        assert_eq!(admin_gate.code, "FORBIDDEN");
        let operator_gate = viewer.require_operator().unwrap_err();
        assert_eq!(operator_gate.status, StatusCode::FORBIDDEN);
        assert_eq!(operator_gate.code, "FORBIDDEN");

        // The gates themselves are unchanged: operator keeps its operator-level
        // access and still cannot reach an admin-only handler.
        let operator = auth_user(Role::Operator);
        assert!(operator.require_operator().is_ok());
        assert_eq!(
            operator.require_admin().unwrap_err().status,
            StatusCode::FORBIDDEN
        );

        let admin = auth_user(Role::Admin);
        assert!(admin.require_admin().is_ok());
        assert!(admin.require_operator().is_ok());
    }

    fn gated_router(role: Role) -> axum::Router {
        async fn admin_handler(auth: AuthUser) -> AppResult<&'static str> {
            auth.require_admin()?;
            Ok("admin")
        }
        async fn operator_handler(auth: AuthUser) -> AppResult<&'static str> {
            auth.require_operator()?;
            Ok("operator")
        }
        axum::Router::new()
            .route("/admin/gated", axum::routing::get(admin_handler))
            .route("/operator/gated", axum::routing::get(operator_handler))
            .layer(axum::middleware::from_fn(
                move |mut request: axum::extract::Request, next: axum::middleware::Next| {
                    let user = auth_user(role);
                    async move {
                        request.extensions_mut().insert(user);
                        next.run(request).await
                    }
                },
            ))
    }

    #[tokio::test]
    async fn viewer_receives_403_from_admin_and_operator_gated_routes() {
        use tower::ServiceExt;

        async fn status(role: Role, path: &str) -> StatusCode {
            gated_router(role)
                .oneshot(
                    axum::http::Request::builder()
                        .uri(path)
                        .body(axum::body::Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap()
                .status()
        }

        assert_eq!(
            status(Role::Viewer, "/admin/gated").await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status(Role::Viewer, "/operator/gated").await,
            StatusCode::FORBIDDEN
        );
        // Unchanged existing behaviour: operator passes operator gates only.
        assert_eq!(
            status(Role::Operator, "/operator/gated").await,
            StatusCode::OK
        );
        assert_eq!(
            status(Role::Operator, "/admin/gated").await,
            StatusCode::FORBIDDEN
        );
        assert_eq!(status(Role::Admin, "/admin/gated").await, StatusCode::OK);
    }
}
