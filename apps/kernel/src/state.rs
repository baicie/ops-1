use crate::config::Config;
use sqlx::PgPool;
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub db: PgPool,
    pub http: reqwest::Client,
    pub cursor_secret: Arc<Vec<u8>>,
    pub rate_limiter: Arc<RateLimiter>,
}

#[derive(Default)]
pub struct RateLimiter {
    buckets: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn is_limited(&self, key: &str, max: usize, window: Duration) -> bool {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let bucket = buckets.entry(key.to_string()).or_default();
        while bucket
            .front()
            .is_some_and(|instant| now.duration_since(*instant) > window)
        {
            bucket.pop_front();
        }
        bucket.len() >= max
    }

    pub fn record_failure(&self, key: &str, window: Duration) {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        let bucket = buckets.entry(key.to_string()).or_default();
        while bucket
            .front()
            .is_some_and(|instant| now.duration_since(*instant) > window)
        {
            bucket.pop_front();
        }
        bucket.push_back(now);
    }

    pub fn reset(&self, key: &str) {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        buckets.remove(key);
    }
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
            rate_limiter: Arc::new(RateLimiter::default()),
        })
    }
}
