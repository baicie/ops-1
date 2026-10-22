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

pub async fn me(request: Request) -> AppResult<Json<serde_json::Value>> {
    let auth = request
        .extensions()
        .get::<AuthUser>()
        .cloned()
        .ok_or_else(|| AppError::unauthorized("Authentication required"))?;
    Ok(Json(serde_json::json!({
        "user": {
            "id": auth.user_id,
            "email": auth.email,
            "displayName": auth.display_name,
            "role": auth.role,
        },
        "csrfToken": auth.csrf_token
    })))
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
    use super::client_ip;
    use axum::http::HeaderMap;
    use std::net::SocketAddr;

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
}
