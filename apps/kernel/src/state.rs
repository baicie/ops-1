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

const MAX_RATE_LIMIT_BUCKETS: usize = 10_000;

impl RateLimiter {
    pub fn is_limited(&self, key: &str, max: usize, window: Duration) -> bool {
        self.is_limited_at(key, max, window, Instant::now())
    }

    fn is_limited_at(&self, key: &str, max: usize, window: Duration, now: Instant) -> bool {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        prune_buckets(&mut buckets, now, window);
        let bucket = buckets.entry(key.to_string()).or_default();
        bucket.len() >= max
    }

    pub fn record_failure(&self, key: &str, window: Duration) {
        self.record_failure_at(key, window, Instant::now());
    }

    fn record_failure_at(&self, key: &str, window: Duration, now: Instant) {
        let mut buckets = self
            .buckets
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        prune_buckets(&mut buckets, now, window);
        if buckets.len() >= MAX_RATE_LIMIT_BUCKETS {
            if let Some(oldest) = buckets
                .iter()
                .min_by_key(|(_, bucket)| bucket.back().copied())
                .map(|(key, _)| key.clone())
            {
                buckets.remove(&oldest);
            }
        }
        buckets.entry(key.to_string()).or_default().push_back(now);
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

fn prune_buckets(buckets: &mut HashMap<String, VecDeque<Instant>>, now: Instant, window: Duration) {
    for bucket in buckets.values_mut() {
        while bucket
            .front()
            .is_some_and(|instant| now.duration_since(*instant) > window)
        {
            bucket.pop_front();
        }
    }
    buckets.retain(|_, bucket| !bucket.is_empty());
}

#[cfg(test)]
mod tests {
    use super::RateLimiter;
    use std::time::{Duration, Instant};

    #[test]
    fn sliding_window_drops_old_failures_without_deleting_live_ones() {
        let limiter = RateLimiter::default();
        let base = Instant::now();
        let window = Duration::from_secs(300);
        limiter.record_failure_at("ip", window, base);
        limiter.record_failure_at("ip", window, base + Duration::from_secs(240));
        limiter.record_failure_at("ip", window, base + Duration::from_secs(360));
        // At t+360 only the t+240 and t+360 entries remain; max=2 is reached
        // but a third old entry is not incorrectly counted.
        assert!(limiter.is_limited_at("ip", 2, window, base + Duration::from_secs(360)));
        assert!(!limiter.is_limited_at("ip", 3, window, base + Duration::from_secs(360)));
        // At t+541 both remaining entries are outside the 5 minute window.
        assert!(!limiter.is_limited_at("ip", 1, window, base + Duration::from_secs(661)));
    }
}
