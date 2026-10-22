use thiserror::Error;
use url::{Host, Url};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum UrlError {
    #[error("address is empty")]
    Empty,
    #[error("address is not a valid web address")]
    Malformed,
    #[error("only https is allowed, or http for localhost")]
    Insecure,
    #[error("address must not contain credentials")]
    Credentials,
}

/// Turns what the user typed into the bare origin of a Harmony server.
///
/// A missing scheme means https. Paths, queries and fragments are dropped.
pub fn normalize(input: &str) -> Result<Url, UrlError> {
    let input = input.trim();
    if input.is_empty() {
        return Err(UrlError::Empty);
    }
    let candidate = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let url = Url::parse(&candidate).map_err(|_| UrlError::Malformed)?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UrlError::Credentials);
    }
    let host = url.host().ok_or(UrlError::Malformed)?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(&host) => {}
        "http" => return Err(UrlError::Insecure),
        _ => return Err(UrlError::Malformed),
    }
    Url::parse(&url.origin().ascii_serialization()).map_err(|_| UrlError::Malformed)
}

fn is_loopback(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => *name == "localhost",
        Host::Ipv4(addr) => addr.is_loopback(),
        Host::Ipv6(_) => false,
    }
}

/// Scheme, host and port all equal. `Url::origin` cannot be used because custom schemes such as
/// `tauri://` have opaque origins that never compare equal.
pub fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// The URL pattern a capability uses to match every page of `origin`.
pub fn capability_pattern(origin: &Url) -> Option<String> {
    let host = origin.host_str()?;
    let plain = host
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    plain.then(|| format!("{}/*", origin.origin().ascii_serialization()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(input: &str) -> String {
        normalize(input).unwrap().to_string()
    }

    #[test]
    fn accepts_https_and_defaults_to_it() {
        assert_eq!(
            ok("https://chat.example.ts.net:18470"),
            "https://chat.example.ts.net:18470/"
        );
        assert_eq!(
            ok("  chat.example.ts.net  "),
            "https://chat.example.ts.net/"
        );
    }

    #[test]
    fn keeps_only_the_origin() {
        assert_eq!(
            ok("https://chat.example.ts.net/channels/1?x=2#y"),
            "https://chat.example.ts.net/"
        );
        assert_eq!(
            ok("https://Chat.Example.TS.net:443"),
            "https://chat.example.ts.net/"
        );
    }

    #[test]
    fn allows_http_only_for_loopback() {
        assert_eq!(ok("http://localhost:8080"), "http://localhost:8080/");
        assert_eq!(ok("http://127.0.0.1:8470/x"), "http://127.0.0.1:8470/");
        assert_eq!(
            normalize("http://chat.example.ts.net"),
            Err(UrlError::Insecure)
        );
        assert_eq!(
            normalize("http://192.168.1.5:8470"),
            Err(UrlError::Insecure)
        );
        assert_eq!(
            normalize("http://localhost.evil.test"),
            Err(UrlError::Insecure)
        );
        assert_eq!(normalize("http://[::1]:8080"), Err(UrlError::Insecure));
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(normalize(""), Err(UrlError::Empty));
        assert_eq!(normalize("   "), Err(UrlError::Empty));
        assert_eq!(normalize("https://"), Err(UrlError::Malformed));
        assert_eq!(normalize("not a url"), Err(UrlError::Malformed));
        assert_eq!(
            normalize("ftp://chat.example.ts.net"),
            Err(UrlError::Malformed)
        );
        assert_eq!(normalize("javascript:alert(1)"), Err(UrlError::Malformed));
        assert_eq!(
            normalize("https://user:pw@chat.example.ts.net"),
            Err(UrlError::Credentials)
        );
        assert_eq!(
            normalize("https://user@chat.example.ts.net"),
            Err(UrlError::Credentials)
        );
    }

    #[test]
    fn same_origin_compares_scheme_host_and_port() {
        let base = Url::parse("https://chat.example.ts.net/").unwrap();
        let same = |s: &str| same_origin(&base, &Url::parse(s).unwrap());
        assert!(same("https://chat.example.ts.net/channels/1"));
        assert!(same("https://chat.example.ts.net:443/x"));
        assert!(!same("http://chat.example.ts.net/"));
        assert!(!same("https://chat.example.ts.net:18470/"));
        assert!(!same("https://chat.example.ts.net.evil.test/"));
        assert!(!same("https://evil.test/"));
    }

    #[test]
    fn same_origin_works_for_custom_schemes() {
        let a = Url::parse("tauri://localhost/").unwrap();
        assert!(same_origin(
            &a,
            &Url::parse("tauri://localhost/index.html").unwrap()
        ));
        assert!(!same_origin(&a, &Url::parse("tauri://other/").unwrap()));
    }

    #[test]
    fn capability_pattern_covers_exactly_the_origin() {
        let origin = normalize("https://chat.example.ts.net:18470").unwrap();
        assert_eq!(
            capability_pattern(&origin).as_deref(),
            Some("https://chat.example.ts.net:18470/*")
        );
        let local = normalize("http://localhost:8080").unwrap();
        assert_eq!(
            capability_pattern(&local).as_deref(),
            Some("http://localhost:8080/*")
        );
    }
}
