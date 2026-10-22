use std::time::Duration;

use reqwest::redirect::Policy;
use serde::Deserialize;
use url::Url;

const TIMEOUT: Duration = Duration::from_secs(8);
const MAX_BODY: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbeError {
    Unreachable,
    Timeout,
    BadStatus(u16),
    NotHarmony,
}

#[derive(Deserialize)]
struct Health {
    service: Option<String>,
    status: Option<String>,
}

/// Checks that `origin` answers `GET /healthz` like a Harmony server.
///
/// Redirects are not followed: the configured origin must serve the app itself.
pub async fn probe(origin: &Url) -> Result<(), ProbeError> {
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .timeout(TIMEOUT)
        .build()
        .map_err(|_| ProbeError::Unreachable)?;
    let url = origin
        .join("/healthz")
        .map_err(|_| ProbeError::Unreachable)?;
    let mut response = client.get(url).send().await.map_err(|error| {
        if error.is_timeout() {
            ProbeError::Timeout
        } else {
            ProbeError::Unreachable
        }
    })?;
    if !response.status().is_success() {
        return Err(ProbeError::BadStatus(response.status().as_u16()));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ProbeError::NotHarmony)? {
        body.extend_from_slice(&chunk);
        if body.len() > MAX_BODY {
            return Err(ProbeError::NotHarmony);
        }
    }
    let health: Health = serde_json::from_slice(&body).map_err(|_| ProbeError::NotHarmony)?;
    if health.service.as_deref() == Some("harmony") && health.status.as_deref() == Some("ok") {
        Ok(())
    } else {
        Err(ProbeError::NotHarmony)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serves one canned HTTP response and returns the origin to probe.
    async fn serve(response: &'static str) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let _ = socket.read(&mut buffer).await;
            socket.write_all(response.as_bytes()).await.unwrap();
        });
        Url::parse(&format!("http://127.0.0.1:{port}")).unwrap()
    }

    const JSON: &str = "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\n";

    fn reply(body: &str) -> &'static str {
        Box::leak(format!("{JSON}content-length: {}\r\n\r\n{body}", body.len()).into_boxed_str())
    }

    #[tokio::test]
    async fn accepts_a_harmony_health_response() {
        let origin = serve(reply(r#"{"service":"harmony","status":"ok"}"#)).await;
        assert_eq!(probe(&origin).await, Ok(()));
    }

    #[tokio::test]
    async fn rejects_a_healthy_service_that_is_not_harmony() {
        let origin = serve(reply(r#"{"status":"ok"}"#)).await;
        assert_eq!(probe(&origin).await, Err(ProbeError::NotHarmony));
    }

    #[tokio::test]
    async fn rejects_a_non_json_answer() {
        let origin = serve(reply("<html>hello</html>")).await;
        assert_eq!(probe(&origin).await, Err(ProbeError::NotHarmony));
    }

    #[tokio::test]
    async fn reports_http_errors() {
        let origin =
            serve("HTTP/1.1 502 Bad Gateway\r\ncontent-length: 0\r\nconnection: close\r\n\r\n")
                .await;
        assert_eq!(probe(&origin).await, Err(ProbeError::BadStatus(502)));
    }

    #[tokio::test]
    async fn does_not_follow_redirects() {
        let origin = serve(
            "HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:1/\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
        )
        .await;
        assert_eq!(probe(&origin).await, Err(ProbeError::BadStatus(302)));
    }

    #[tokio::test]
    async fn reports_a_closed_port_as_unreachable() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let origin = Url::parse(&format!("http://127.0.0.1:{port}")).unwrap();
        assert_eq!(probe(&origin).await, Err(ProbeError::Unreachable));
    }
}
