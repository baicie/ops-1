use chrono::{DateTime, Utc};
use opsweave_contracts::{LogBatch, LogChannel, LogEvent, LogLevel};
use std::collections::VecDeque;
use std::sync::Mutex;
use uuid::Uuid;

pub struct LogBuffer {
    inner: Mutex<LogBufferInner>,
}

struct LogBufferInner {
    stream_id: Uuid,
    epoch: i64,
    sequence: i64,
    events: VecDeque<LogEvent>,
    capacity: usize,
}

impl LogBuffer {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(LogBufferInner {
                stream_id: Uuid::new_v4(),
                epoch: 1,
                sequence: 1,
                events: VecDeque::new(),
                capacity: 2000,
            }),
        }
    }

    pub fn rotate(&self) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.epoch += 1;
            inner.sequence = 1;
            inner.events.clear();
        }
    }

    pub fn push(
        &self,
        node_id: Uuid,
        instance_id: Uuid,
        channel: LogChannel,
        level: LogLevel,
        message: &str,
        occurred_at: Option<DateTime<Utc>>,
    ) {
        let message = sanitize(message);
        let truncated = message.chars().count() > 16_384;
        let message: String = message.chars().take(16_384).collect();
        if let Ok(mut inner) = self.inner.lock() {
            let sequence = inner.sequence;
            inner.sequence += 1;
            let event = LogEvent {
                event_id: Uuid::new_v4(),
                stream_id: inner.stream_id,
                stream_epoch: inner.epoch,
                sequence,
                occurred_at,
                observed_at: Utc::now(),
                node_id,
                instance_id,
                channel,
                level,
                message,
                truncated,
            };
            inner.events.push_back(event);
            while inner.events.len() > inner.capacity {
                inner.events.pop_front();
            }
        }
    }

    pub fn batch(&self, requested_epoch: i64, after: i64) -> LogBatch {
        let inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(_) => {
                return LogBatch {
                    stream_id: Uuid::nil(),
                    stream_epoch: 1,
                    first_sequence: None,
                    last_sequence: None,
                    events: vec![],
                    gap: true,
                }
            }
        };
        let first = inner.events.front().map(|event| event.sequence);
        let last = inner.events.back().map(|event| event.sequence);
        if requested_epoch != inner.epoch {
            return LogBatch {
                stream_id: inner.stream_id,
                stream_epoch: inner.epoch,
                first_sequence: first,
                last_sequence: last,
                events: inner.events.iter().take(200).cloned().collect(),
                gap: true,
            };
        }
        let gap = match first {
            Some(first) => after < first - 1,
            None => after > 0,
        };
        let events: Vec<LogEvent> = inner
            .events
            .iter()
            .filter(|event| event.sequence > after)
            .take(200)
            .cloned()
            .collect();
        LogBatch {
            stream_id: inner.stream_id,
            stream_epoch: inner.epoch,
            first_sequence: first,
            last_sequence: last,
            events,
            gap,
        }
    }

    pub fn metadata(&self) -> (Uuid, i64, Option<i64>) {
        match self.inner.lock() {
            Ok(inner) => (
                inner.stream_id,
                inner.epoch,
                inner.events.back().map(|event| event.sequence),
            ),
            Err(_) => (Uuid::nil(), 1, None),
        }
    }
}

impl Default for LogBuffer {
    fn default() -> Self {
        Self::new()
    }
}

fn sanitize(message: &str) -> String {
    let mut out = String::with_capacity(message.len());
    let mut chars = message.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if ch == '\r' {
            continue;
        }
        out.push(ch);
    }
    out
}

pub fn parse_level(message: &str) -> LogLevel {
    let upper = message.to_ascii_uppercase();
    if upper.contains("ERROR") || upper.contains("FATAL") {
        LogLevel::Error
    } else if upper.contains("WARN") {
        LogLevel::Warn
    } else if upper.contains("DEBUG") {
        LogLevel::Debug
    } else if upper.contains("TRACE") {
        LogLevel::Trace
    } else if upper.contains("INFO") {
        LogLevel::Info
    } else {
        LogLevel::Unknown
    }
}

pub fn parse_docker_log_line(line: &str) -> (Option<DateTime<Utc>>, String) {
    if let Some((timestamp, message)) = line.split_once(' ') {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(timestamp) {
            return (Some(parsed.with_timezone(&Utc)), message.to_string());
        }
    }
    (None, line.to_string())
}
