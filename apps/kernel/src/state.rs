use crate::config::Config;
use sqlx::PgPool;
use std::sync::Arc;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub http: reqwest::Client,
    pub cursor_secret: Arc<Vec<u8>>,
}

impl AppState {
    pub fn new(config: Config, db: PgPool, cursor_secret: Vec<u8>) -> anyhow::Result<Self> {
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(3))
            .timeout(std::time::Duration::from_secs(
                config.request_timeout_seconds + 5,
            ))
            .redirect(reqwest::redirect::Policy::none())
            .build()?;
        Ok(Self {
            config: Arc::new(config),
            db,
            http,
            cursor_secret: Arc::new(cursor_secret),
        })
    }
}
