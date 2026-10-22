use serde::Serialize;
use thiserror::Error;

const MAX_TITLE: usize = 100;
const MAX_BODY: usize = 300;
const MAX_ROUTE: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Error, Serialize)]
#[error("invalid {field}")]
pub struct InvalidArgument {
    pub field: &'static str,
}

/// A notification request from the web client, checked against the limits below.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Toast {
    pub title: String,
    pub body: String,
    pub route: String,
}

impl Toast {
    pub fn parse(title: &str, body: &str, route: &str) -> Result<Self, InvalidArgument> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > MAX_TITLE || has_control(title, false) {
            return Err(InvalidArgument { field: "title" });
        }
        if body.chars().count() > MAX_BODY || has_control(body, true) {
            return Err(InvalidArgument { field: "body" });
        }
        if !is_app_route(route) {
            return Err(InvalidArgument { field: "route" });
        }
        Ok(Self {
            title: title.into(),
            body: body.into(),
            route: route.into(),
        })
    }
}

fn has_control(text: &str, allow_newline: bool) -> bool {
    text.chars()
        .any(|c| c.is_control() && !(allow_newline && c == '\n'))
}

/// An absolute path inside the app, such as `/channels/1/2`. Never a URL, so it cannot name
/// another site, and limited to characters that need no escaping in the script that navigates.
pub fn is_app_route(route: &str) -> bool {
    route.len() <= MAX_ROUTE
        && route.starts_with('/')
        && !route.starts_with("//")
        && route
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/-_.~%?=&#@".contains(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn field(result: Result<Toast, InvalidArgument>) -> &'static str {
        result.unwrap_err().field
    }

    #[test]
    fn accepts_a_normal_notification() {
        let toast = Toast::parse("Ada in #general", "hello\nworld", "/channels/12/34").unwrap();
        assert_eq!(toast.title, "Ada in #general");
        assert_eq!(toast.route, "/channels/12/34");
    }

    #[test]
    fn rejects_bad_titles() {
        assert_eq!(field(Toast::parse("   ", "x", "/")), "title");
        assert_eq!(field(Toast::parse(&"a".repeat(101), "x", "/")), "title");
        assert_eq!(field(Toast::parse("a\u{0007}b", "x", "/")), "title");
        assert_eq!(field(Toast::parse("a\nb", "x", "/")), "title");
    }

    #[test]
    fn rejects_bad_bodies() {
        assert_eq!(field(Toast::parse("t", &"a".repeat(301), "/")), "body");
        assert_eq!(field(Toast::parse("t", "a\u{001b}[0m", "/")), "body");
        assert!(Toast::parse("t", "", "/").is_ok());
        assert!(Toast::parse("t", &"é".repeat(300), "/").is_ok());
    }

    #[test]
    fn routes_must_stay_inside_the_app() {
        for bad in [
            "",
            "channels/1",
            "//evil.test/x",
            "https://evil.test/",
            "javascript:alert(1)",
            "/a'b",
            "/a\"b",
            "/a b",
            "/a\\b",
            "/<script>",
            "/a`b",
        ] {
            assert_eq!(field(Toast::parse("t", "b", bad)), "route", "{bad}");
        }
        let long = format!("/{}", "a".repeat(MAX_ROUTE));
        assert_eq!(field(Toast::parse("t", "b", &long)), "route");
        assert!(is_app_route("/channels/@me/123?m=9#top"));
    }
}
