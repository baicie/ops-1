use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use opsweave_contracts::ApiErrorBody;
use uuid::Uuid;

#[derive(Debug, Clone)]
pub struct AppError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
    pub retryable: bool,
    pub request_id: Option<String>,
}

impl AppError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            retryable: false,
            request_id: None,
        }
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "INVALID_REQUEST", message)
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "UNAUTHENTICATED", message)
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "FORBIDDEN", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", message)
    }

    pub fn conflict(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, code, message)
    }

    pub fn unavailable(code: &'static str, message: impl Into<String>) -> Self {
        let mut error = Self::new(StatusCode::SERVICE_UNAVAILABLE, code, message);
        error.retryable = true;
        error
    }

    pub fn too_many_requests(code: &'static str, message: impl Into<String>) -> Self {
        let mut error = Self::new(StatusCode::TOO_MANY_REQUESTS, code, message);
        error.retryable = true;
        error
    }

    pub fn internal(error: impl std::fmt::Display) -> Self {
        tracing::error!(error = %error, "internal kernel error");
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Internal kernel error",
        )
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let request_id = self
            .request_id
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let body = ApiErrorBody {
            code: self.code.to_string(),
            message: self.message,
            request_id: request_id.clone(),
            retryable: self.retryable,
        };
        let mut response = (self.status, Json(body)).into_response();
        if let Ok(value) = request_id.parse() {
            if let Some(headers) = response.headers_mut().get_mut("x-request-id") {
                *headers = value;
            } else if let Ok(value) = axum::http::HeaderValue::from_str(&request_id) {
                response.headers_mut().insert("x-request-id", value);
            }
        }
        response
    }
}

impl From<sqlx::Error> for AppError {
    fn from(error: sqlx::Error) -> Self {
        Self::internal(error)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(error: serde_json::Error) -> Self {
        Self::bad_request(format!("invalid JSON: {error}"))
    }
}

impl From<opsweave_bundle::BundleError> for AppError {
    fn from(error: opsweave_bundle::BundleError) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "INVALID_BUNDLE", error.to_string())
    }
}

impl std::error::Error for AppError {}

pub type AppResult<T> = Result<T, AppError>;
