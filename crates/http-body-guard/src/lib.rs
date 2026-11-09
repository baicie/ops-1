//! Bounded streaming reads of untrusted upstream response bodies (B2.2).
//!
//! Every place the Kernel, a Node or a worker read a plugin/upstream body used
//! to do `response.bytes().await` and *then* compare the result against a limit.
//! That is not a limit. `bytes()` buffers the whole body before returning, so a
//! response that advertises no `Content-Length` (chunked, HTTP/1.0-style, a
//! deliberately endless stream) is fully materialised in memory before the
//! comparison runs. A `Content-Length` pre-check only covers the honest case: an
//! upstream that omits or lies about the length bypasses it entirely.
//!
//! The rule implemented here: stop reading the moment the accumulated size
//! exceeds the limit, and drop the connection instead of draining it. The
//! response never exists in memory above the bound.
//!
//! Chunked framing is handled by the transport; the bound is applied per chunk
//! on the decoded bytes, which is what a caller can actually observe.

use futures::StreamExt;
use std::time::Duration;

/// Why a body read stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFailure {
    /// The accumulated body exceeded the caller's limit. The upstream was cut
    /// off; the caller reports a size error, never a partial success.
    TooLarge,
    /// The body ended before its declared length, or the connection broke.
    Interrupted,
    /// The upstream stopped sending for longer than the idle deadline.
    Idle,
}

impl ReadFailure {
    pub fn as_str(self) -> &'static str {
        match self {
            ReadFailure::TooLarge => "response exceeded the size limit",
            ReadFailure::Interrupted => "response ended before it was complete",
            ReadFailure::Idle => "response stalled",
        }
    }
}

/// Read at most `limit` bytes, failing as soon as the bound is crossed.
///
/// `idle_timeout` bounds the *gap* between chunks rather than the whole body: a
/// large but steadily-streaming body is legitimate, a silent one is not. `None`
/// disables the gap check for callers that already wrap the request in a total
/// timeout.
pub async fn read_bounded(
    response: reqwest::Response,
    limit: usize,
    idle_timeout: Option<Duration>,
) -> Result<Vec<u8>, ReadFailure> {
    // A declared length over the bound is refused before one byte is read - the
    // cheap half. It is not the defence: the streaming check below is.
    if let Some(declared) = response.content_length() {
        if declared > limit as u64 {
            return Err(ReadFailure::TooLarge);
        }
    }
    let mut stream = response.bytes_stream();
    let mut body: Vec<u8> = Vec::new();
    loop {
        let next = match idle_timeout {
            Some(idle) => match tokio::time::timeout(idle, stream.next()).await {
                Ok(item) => item,
                Err(_) => return Err(ReadFailure::Idle),
            },
            None => stream.next().await,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|_| ReadFailure::Interrupted)?;
        // Reserve only what this chunk needs, and check before extending: the
        // vector never grows past `limit`, even transiently by a whole chunk.
        if body.len().saturating_add(chunk.len()) > limit {
            return Err(ReadFailure::TooLarge);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::{read_bounded, ReadFailure};
    use std::time::Duration;

    /// Build a response whose body arrives as the given chunks, optionally
    /// declaring a `Content-Length` the body does not actually honour (which is
    /// exactly the shape an untrusted upstream can produce).
    fn response_from(chunks: Vec<&'static [u8]>, content_length: Option<u64>) -> reqwest::Response {
        let stream = futures::stream::iter(
            chunks
                .into_iter()
                .map(|chunk| Ok::<_, std::io::Error>(bytes::Bytes::from_static(chunk))),
        );
        let body = reqwest::Body::wrap_stream(stream);
        let mut builder = axum::http::Response::builder();
        if let Some(length) = content_length {
            builder = builder.header(axum::http::header::CONTENT_LENGTH, length);
        }
        reqwest::Response::from(builder.body(body).expect("test response builds"))
    }

    #[tokio::test]
    async fn accepts_a_body_at_exactly_the_limit() {
        let response = response_from(vec![b"hello", b"world"], None);
        let body = read_bounded(response, 10, None)
            .await
            .expect("exactly at the limit is allowed");
        assert_eq!(body, b"helloworld");
    }

    #[tokio::test]
    async fn refuses_a_body_one_byte_over_the_limit() {
        let response = response_from(vec![b"hello", b"worlds"], None);
        let failure = read_bounded(response, 10, None)
            .await
            .expect_err("one byte over must fail");
        assert_eq!(failure, ReadFailure::TooLarge);
    }

    #[tokio::test]
    async fn refuses_an_oversized_body_that_declares_no_length() {
        // The pre-fix defect: with no Content-Length the old code buffered the
        // whole body and only then compared. The stream here is many chunks of
        // unknown total length, and the read must stop at the bound.
        let chunk: &'static [u8] = Box::leak(vec![b'x'; 4096].into_boxed_slice());
        let response = response_from(vec![chunk; 8], None);
        let failure = read_bounded(response, 4096, None)
            .await
            .expect_err("the second chunk already exceeds the bound");
        assert_eq!(failure, ReadFailure::TooLarge);
    }

    #[tokio::test]
    async fn refuses_a_declared_length_over_the_limit_before_reading() {
        // A hand-built reqwest::Response does not carry the header through
        // `content_length()`, so this assertion uses a real listener: the point
        // is the wire behaviour, and only a real response can show it.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 1024];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buf).await;
            // Declares 1 MiB, sends five bytes, and never closes: a caller that
            // trusted the header or buffered first would sit here.
            let _ = tokio::io::AsyncWriteExt::write_all(
                &mut socket,
                b"HTTP/1.1 200 OK\r\nContent-Length: 1048576\r\n\r\nshort",
            )
            .await;
            tokio::time::sleep(Duration::from_secs(5)).await;
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .expect("request");
        let failure = read_bounded(response, 10, Some(Duration::from_millis(200)))
            .await
            .expect_err("a declared length over the bound is refused");
        assert_eq!(failure, ReadFailure::TooLarge);
    }

    #[tokio::test]
    async fn a_stalled_stream_times_out_rather_than_hanging() {
        // No chunks ever arrive; the idle deadline must end the read.
        let stream = futures::stream::pending::<Result<bytes::Bytes, std::io::Error>>();
        let body = reqwest::Body::wrap_stream(stream);
        let response = reqwest::Response::from(axum::http::Response::new(body));
        let failure = read_bounded(response, 1024, Some(Duration::from_millis(50)))
            .await
            .expect_err("a silent upstream must not hang the caller");
        assert_eq!(failure, ReadFailure::Idle);
    }

    /// The real shape of the pre-fix bypass, over a real socket: an upstream
    /// that declares no length, streams chunked forever, and would keep a
    /// buffering reader growing without bound.
    #[tokio::test]
    async fn an_endless_chunked_body_is_cut_at_the_bound() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let address = listener.local_addr().expect("addr");
        let serving = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buf = [0u8; 4096];
            let _ = tokio::io::AsyncReadExt::read(&mut socket, &mut buf).await;
            // No Content-Length: chunked and open-ended.
            let _ = tokio::io::AsyncWriteExt::write_all(
                &mut socket,
                b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: application/json\r\n\r\n",
            )
            .await;
            let chunk = "6c".to_string() + "\r\n" + &"x".repeat(108) + "\r\n";
            for _ in 0..10_000 {
                if tokio::io::AsyncWriteExt::write_all(&mut socket, chunk.as_bytes())
                    .await
                    .is_err()
                {
                    break;
                }
            }
            // Never send the terminating 0-length chunk.
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        let response = reqwest::Client::new()
            .get(format!("http://{address}/"))
            .send()
            .await
            .expect("request");
        let started = std::time::Instant::now();
        let failure = read_bounded(response, 4096, Some(Duration::from_secs(5)))
            .await
            .expect_err("an endless body must be refused");
        assert_eq!(failure, ReadFailure::TooLarge);
        // It failed by refusing, not by waiting for the stream to end (it never does).
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the bound must be hit by size, not by timeout"
        );
        serving.abort();
    }

    #[tokio::test]
    async fn an_empty_body_is_a_body() {
        let response = response_from(vec![], None);
        let body = read_bounded(response, 10, None)
            .await
            .expect("an empty body is valid");
        assert!(body.is_empty());
    }
}
