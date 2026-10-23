//! Finds Harmony servers among the online devices of the local tailnet.
//!
//! Every peer is asked for `/healthz` over verified TLS, the same check the manual entry uses.
//! A device that answers is only a candidate: the setup page lists it with its owner and the
//! user has to click Connect.

use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use url::Url;

use crate::probe::probe_within;
use crate::tailscale::{Ownership, Peer};

/// Ports a Harmony server is usually served on: the documented Tailscale Serve port and 443.
const DEFAULT_PORTS: [Option<u16>; 2] = [Some(18470), None];
const PROBE_TIMEOUT: Duration = Duration::from_millis(1500);
const MAX_CONCURRENT: usize = 16;

/// An address to ask, and the peer it belongs to.
#[derive(Debug, Clone)]
pub struct Candidate {
    pub peer: Peer,
    pub url: Url,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundServer {
    pub url: String,
    pub hostname: String,
    pub ownership: Ownership,
    pub owner_label: String,
    /// True for every device that is not provably yours.
    pub warn: bool,
}

/// The https addresses to try on each peer: the usual ports, plus `extra_port` if given.
pub fn candidates(peers: &[Peer], extra_port: Option<u16>) -> Vec<Candidate> {
    let mut ports: Vec<Option<u16>> = DEFAULT_PORTS.to_vec();
    if let Some(port) = extra_port.filter(|port| *port != 0 && *port != 443) {
        if !ports.contains(&Some(port)) {
            ports.push(Some(port));
        }
    }
    peers
        .iter()
        .flat_map(|peer| {
            ports.iter().filter_map(move |port| {
                let authority = match port {
                    Some(port) => format!("{}:{port}", peer.dns_name),
                    None => peer.dns_name.clone(),
                };
                let url = Url::parse(&format!("https://{authority}/")).ok()?;
                (url.host_str() == Some(peer.dns_name.as_str())).then(|| Candidate {
                    peer: peer.clone(),
                    url,
                })
            })
        })
        .collect()
}

/// Probes all candidates, at most `MAX_CONCURRENT` at a time, and keeps those that are Harmony
/// servers. The result is ordered by owner (your own devices first), then host and address.
pub async fn scan(candidates: Vec<Candidate>, timeout: Duration) -> Vec<FoundServer> {
    let limit = Arc::new(Semaphore::new(MAX_CONCURRENT));
    let mut tasks = JoinSet::new();
    for candidate in candidates {
        let limit = Arc::clone(&limit);
        tasks.spawn(async move {
            let _permit = limit.acquire_owned().await.ok()?;
            probe_within(&candidate.url, timeout).await.ok()?;
            Some(FoundServer {
                url: candidate.url.to_string(),
                hostname: candidate.peer.hostname,
                owner_label: candidate.peer.ownership.label(),
                warn: !candidate.peer.ownership.is_own(),
                ownership: candidate.peer.ownership,
            })
        });
    }
    let mut found = Vec::new();
    while let Some(result) = tasks.join_next().await {
        if let Ok(Some(server)) = result {
            found.push(server);
        }
    }
    found.sort_by(|a, b| (a.warn, &a.hostname, &a.url).cmp(&(b.warn, &b.hostname, &b.url)));
    found
}

pub async fn discover(peers: &[Peer], extra_port: Option<u16>) -> Vec<FoundServer> {
    scan(candidates(peers, extra_port), PROBE_TIMEOUT).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn peer(hostname: &str, ownership: Ownership) -> Peer {
        Peer {
            hostname: hostname.into(),
            dns_name: format!("{hostname}.tailnet-1.ts.net"),
            ownership,
        }
    }

    #[test]
    fn asks_the_usual_ports_and_an_extra_one() {
        let peers = [peer("box", Ownership::Own)];
        let urls = |extra| -> Vec<String> {
            candidates(&peers, extra)
                .iter()
                .map(|c| c.url.to_string())
                .collect()
        };
        assert_eq!(
            urls(None),
            [
                "https://box.tailnet-1.ts.net:18470/",
                "https://box.tailnet-1.ts.net/"
            ]
        );
        assert_eq!(urls(Some(9443)).len(), 3);
        assert_eq!(urls(Some(18470)).len(), 2, "no duplicate");
        assert_eq!(urls(Some(443)).len(), 2, "443 is the default port already");
        assert_eq!(urls(Some(0)).len(), 2);
    }

    #[test]
    fn a_peer_name_that_is_not_a_plain_host_is_skipped() {
        let mut odd = peer("box", Ownership::Own);
        odd.dns_name = "box.example/evil".into();
        assert!(candidates(&[odd], None).is_empty());
    }

    const OK: &str = r#"{"service":"harmony","status":"ok"}"#;

    /// Accepts connections and answers each with `body` as a 200 JSON response.
    async fn serve(body: &'static str) -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut buffer = [0u8; 1024];
                    let _ = socket.read(&mut buffer).await;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()
    }

    async fn closed_port() -> Url {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap()
    }

    #[tokio::test]
    async fn keeps_only_harmony_servers_and_flags_other_peoples_devices() {
        let own = Candidate {
            peer: peer("mine", Ownership::Own),
            url: serve(OK).await,
        };
        let theirs = Candidate {
            peer: peer(
                "alpha",
                Ownership::Other {
                    owner: "grace@example.com".into(),
                },
            ),
            url: serve(OK).await,
        };
        let not_harmony = Candidate {
            peer: peer("web", Ownership::Own),
            url: serve(r#"{"status":"ok"}"#).await,
        };
        let down = Candidate {
            peer: peer("down", Ownership::Own),
            url: closed_port().await,
        };

        let found = scan(vec![theirs, not_harmony, down, own], Duration::from_secs(2)).await;

        let summary: Vec<_> = found
            .iter()
            .map(|s| (s.hostname.as_str(), s.warn, s.owner_label.as_str()))
            .collect();
        assert_eq!(
            summary,
            [
                ("mine", false, "Your device"),
                ("alpha", true, "Shared by grace@example.com")
            ]
        );
    }

    #[tokio::test]
    async fn a_silent_host_costs_only_the_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _held = listener.accept().await;
            std::future::pending::<()>().await;
        });
        let silent = Candidate {
            peer: peer("silent", Ownership::Own),
            url: Url::parse(&format!("http://127.0.0.1:{port}/")).unwrap(),
        };
        let started = std::time::Instant::now();
        let found = scan(vec![silent], Duration::from_millis(200)).await;
        assert!(found.is_empty());
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[tokio::test]
    async fn many_candidates_are_all_answered() {
        let origin = serve(OK).await;
        let many: Vec<_> = (0..40)
            .map(|n| Candidate {
                peer: peer(&format!("host{n:02}"), Ownership::Own),
                url: origin.clone(),
            })
            .collect();
        assert_eq!(scan(many, Duration::from_secs(5)).await.len(), 40);
    }
}
