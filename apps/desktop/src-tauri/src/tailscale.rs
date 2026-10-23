//! Reads the local tailnet through the `tailscale` command line tool.
//!
//! The binary is run directly (no shell) with fixed arguments and a time limit. Nothing a page
//! sends reaches the command line except an account id that is checked against the list the
//! tool itself printed.

use std::collections::HashMap;
use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::time::timeout;

const STATUS_TIMEOUT: Duration = Duration::from_secs(5);
const SWITCH_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ERROR: usize = 200;

#[cfg(windows)]
const BINARY: &str = "tailscale.exe";
#[cfg(not(windows))]
const BINARY: &str = "tailscale";

/// Where the official installers put the CLI, checked before `PATH`.
fn install_locations() -> Vec<PathBuf> {
    if cfg!(windows) {
        ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(env::var_os)
            .map(|dir| PathBuf::from(dir).join("Tailscale").join(BINARY))
            .chain([PathBuf::from(r"C:\Program Files\Tailscale\tailscale.exe")])
            .collect()
    } else if cfg!(target_os = "macos") {
        vec![PathBuf::from(
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        )]
    } else {
        Vec::new()
    }
}

/// The first existing install location, else the first `tailscale` on `path`.
pub fn locate(path: Option<OsString>, known: &[PathBuf]) -> Option<PathBuf> {
    known
        .iter()
        .find(|candidate| candidate.is_file())
        .cloned()
        .or_else(|| {
            env::split_paths(&path?)
                .map(|dir| dir.join(BINARY))
                .find(|candidate| candidate.is_file())
        })
}

fn binary() -> Option<PathBuf> {
    locate(env::var_os("PATH"), &install_locations())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum State {
    NotInstalled,
    /// The CLI is there but the service did not answer, or Tailscale is switched off.
    NotRunning,
    NeedsLogin,
    Running,
}

/// Who runs a device, from the point of view of the signed-in account.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Ownership {
    Own,
    /// Another member of the same tailnet.
    Other {
        owner: String,
    },
    /// Shared into this tailnet from a different one.
    Shared {
        owner: String,
    },
    Tagged,
}

impl Ownership {
    pub fn label(&self) -> String {
        match self {
            Self::Own => "Your device".into(),
            Self::Other { owner } | Self::Shared { owner } => format!("Shared by {owner}"),
            Self::Tagged => "Tagged".into(),
        }
    }

    /// Anything that is not provably your own device deserves a warning before connecting.
    pub fn is_own(&self) -> bool {
        matches!(self, Self::Own)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Peer {
    pub hostname: String,
    /// Fully qualified MagicDNS name without the trailing dot.
    pub dns_name: String,
    pub ownership: Ownership,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Status {
    pub state: State,
    pub account: Option<String>,
    pub tailnet: Option<String>,
    /// Online peers only, sorted by host name.
    pub peers: Vec<Peer>,
}

impl Status {
    fn without_peers(state: State) -> Self {
        Self {
            state,
            account: None,
            tailnet: None,
            peers: Vec::new(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawStatus {
    backend_state: String,
    #[serde(default)]
    current_tailnet: Option<RawTailnet>,
    #[serde(rename = "Self")]
    self_node: Option<RawNode>,
    #[serde(default)]
    peer: HashMap<String, RawNode>,
    #[serde(default)]
    user: HashMap<String, RawUser>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawTailnet {
    name: Option<String>,
    #[serde(rename = "MagicDNSSuffix")]
    magic_dns_suffix: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawNode {
    #[serde(default)]
    host_name: String,
    #[serde(default, rename = "DNSName")]
    dns_name: String,
    #[serde(default, rename = "UserID")]
    user_id: i64,
    #[serde(default)]
    online: bool,
    #[serde(default)]
    tags: Option<Vec<String>>,
    #[serde(default)]
    sharee_node: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct RawUser {
    #[serde(default)]
    login_name: String,
}

fn trim_dot(name: &str) -> &str {
    name.strip_suffix('.').unwrap_or(name)
}

fn is_tagged(node: &RawNode) -> bool {
    node.tags.as_ref().is_some_and(|tags| !tags.is_empty())
}

/// Parses the output of `tailscale status --json`.
pub fn parse_status(json: &[u8]) -> Option<Status> {
    let raw: RawStatus = serde_json::from_slice(json).ok()?;
    let state = match raw.backend_state.as_str() {
        "Running" => State::Running,
        "NeedsLogin" | "NeedsMachineAuth" => State::NeedsLogin,
        _ => State::NotRunning,
    };
    if state != State::Running {
        return Some(Status::without_peers(state));
    }
    let login = |id: i64| {
        raw.user
            .get(&id.to_string())
            .map(|user| user.login_name.clone())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| "an unknown user".into())
    };
    let me = raw.self_node.as_ref();
    let my_suffix = raw
        .current_tailnet
        .as_ref()
        .and_then(|tailnet| tailnet.magic_dns_suffix.clone())
        .filter(|suffix| !suffix.is_empty());
    let my_id = me.filter(|node| !is_tagged(node)).map(|node| node.user_id);

    let mut peers: Vec<Peer> = raw
        .peer
        .values()
        .filter(|node| node.online && !node.dns_name.is_empty())
        .map(|node| {
            let dns_name = trim_dot(&node.dns_name).to_owned();
            let foreign = node.sharee_node
                || my_suffix
                    .as_ref()
                    .is_some_and(|suffix| !dns_name.ends_with(&format!(".{}", trim_dot(suffix))));
            let ownership = if is_tagged(node) {
                Ownership::Tagged
            } else if foreign {
                Ownership::Shared {
                    owner: login(node.user_id),
                }
            } else if Some(node.user_id) == my_id {
                Ownership::Own
            } else {
                Ownership::Other {
                    owner: login(node.user_id),
                }
            };
            let hostname = if node.host_name.is_empty() {
                dns_name.split('.').next().unwrap_or_default().to_owned()
            } else {
                node.host_name.clone()
            };
            Peer {
                hostname,
                dns_name,
                ownership,
            }
        })
        .collect();
    peers.sort_by(|a, b| {
        a.hostname
            .cmp(&b.hostname)
            .then(a.dns_name.cmp(&b.dns_name))
    });

    Some(Status {
        state,
        account: me.map(|node| login(node.user_id)),
        tailnet: raw
            .current_tailnet
            .and_then(|tailnet| tailnet.name)
            .filter(|name| !name.is_empty()),
        peers,
    })
}

/// One signed-in Tailscale account, from `tailscale switch --list`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Account {
    pub id: String,
    pub tailnet: String,
    pub account: String,
    pub current: bool,
}

/// Parses the table printed by `tailscale switch --list`: `ID  Tailnet  Account`, with `*` on the
/// current row.
pub fn parse_accounts(output: &str) -> Vec<Account> {
    output
        .lines()
        .skip(1)
        .filter_map(|line| {
            let mut words: Vec<&str> = line.split_whitespace().collect();
            let current = words.last() == Some(&"*");
            if current {
                words.pop();
            }
            let [id, tailnet, account @ ..] = words.as_slice() else {
                return None;
            };
            let valid_id = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric());
            (valid_id && !account.is_empty()).then(|| Account {
                id: (*id).to_owned(),
                tailnet: (*tailnet).to_owned(),
                account: account.join(" "),
                current,
            })
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
pub enum RunError {
    NotInstalled,
    TimedOut,
    /// The tool ran and failed; the text is its own message, shortened.
    Failed(String),
}

async fn run(binary: &Path, args: &[&str], limit: Duration) -> Result<String, RunError> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = timeout(limit, command.output())
        .await
        .map_err(|_| RunError::TimedOut)?
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                RunError::NotInstalled
            } else {
                RunError::Failed(error.kind().to_string())
            }
        })?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).into_owned())
    } else {
        let message = String::from_utf8_lossy(&output.stderr);
        let message = message.trim();
        Err(RunError::Failed(message.chars().take(MAX_ERROR).collect()))
    }
}

pub async fn status() -> Status {
    let Some(binary) = binary() else {
        return Status::without_peers(State::NotInstalled);
    };
    match run(&binary, &["status", "--json"], STATUS_TIMEOUT).await {
        Ok(output) => parse_status(output.as_bytes())
            .unwrap_or_else(|| Status::without_peers(State::NotRunning)),
        Err(RunError::NotInstalled) => Status::without_peers(State::NotInstalled),
        Err(_) => Status::without_peers(State::NotRunning),
    }
}

/// Empty when fast user switching is not available.
pub async fn accounts() -> Vec<Account> {
    let Some(binary) = binary() else {
        return Vec::new();
    };
    run(&binary, &["switch", "--list"], STATUS_TIMEOUT)
        .await
        .map(|output| parse_accounts(&output))
        .unwrap_or_default()
}

#[derive(Debug, PartialEq, Eq)]
pub enum SwitchError {
    /// The id is not one of the accounts the tool listed.
    UnknownAccount,
    Run(RunError),
}

/// Switches to one of the listed accounts. The id is re-checked against a fresh listing.
pub async fn switch(id: &str) -> Result<(), SwitchError> {
    let Some(binary) = binary() else {
        return Err(SwitchError::Run(RunError::NotInstalled));
    };
    let listed = run(&binary, &["switch", "--list"], STATUS_TIMEOUT)
        .await
        .map_err(SwitchError::Run)?;
    let account = parse_accounts(&listed)
        .into_iter()
        .find(|account| account.id == id)
        .ok_or(SwitchError::UnknownAccount)?;
    run(&binary, &["switch", &account.id], SWITCH_TIMEOUT)
        .await
        .map(|_| ())
        .map_err(SwitchError::Run)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A tailnet seen from `laptop`, signed in as ada. Names are made up.
    const RUNNING: &str = r#"{
      "Version": "1.80.0",
      "BackendState": "Running",
      "MagicDNSSuffix": "tailnet-1.ts.net",
      "CurrentTailnet": { "Name": "ada@example.com", "MagicDNSSuffix": "tailnet-1.ts.net", "MagicDNSEnabled": true },
      "Self": { "HostName": "laptop", "DNSName": "laptop.tailnet-1.ts.net.", "UserID": 1, "Online": true },
      "Peer": {
        "nodekey:a": { "HostName": "homeserver", "DNSName": "homeserver.tailnet-1.ts.net.", "UserID": 1, "Online": true },
        "nodekey:b": { "HostName": "phone", "DNSName": "phone.tailnet-1.ts.net.", "UserID": 1, "Online": false },
        "nodekey:c": { "HostName": "grace-pc", "DNSName": "grace-pc.tailnet-1.ts.net.", "UserID": 2, "Online": true },
        "nodekey:d": { "HostName": "ci-runner", "DNSName": "ci-runner.tailnet-1.ts.net.", "UserID": 3, "Online": true, "Tags": ["tag:ci"] },
        "nodekey:e": { "HostName": "friend-box", "DNSName": "friend-box.other-tailnet.ts.net.", "UserID": 4, "Online": true, "ShareeNode": true },
        "nodekey:f": { "HostName": "", "DNSName": "", "UserID": 1, "Online": true }
      },
      "User": {
        "1": { "ID": 1, "LoginName": "ada@example.com", "DisplayName": "Ada" },
        "2": { "ID": 2, "LoginName": "grace@example.com", "DisplayName": "Grace" },
        "3": { "ID": 3, "LoginName": "tagged-devices", "DisplayName": "Tagged devices" },
        "4": { "ID": 4, "LoginName": "linus@example.org", "DisplayName": "Linus" }
      }
    }"#;

    fn peer<'a>(status: &'a Status, hostname: &str) -> &'a Peer {
        status
            .peers
            .iter()
            .find(|peer| peer.hostname == hostname)
            .unwrap_or_else(|| panic!("no peer {hostname}"))
    }

    #[test]
    fn reads_the_account_and_tailnet() {
        let status = parse_status(RUNNING.as_bytes()).unwrap();
        assert_eq!(status.state, State::Running);
        assert_eq!(status.account.as_deref(), Some("ada@example.com"));
        assert_eq!(status.tailnet.as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn lists_only_online_peers_with_a_name_sorted_by_host() {
        let status = parse_status(RUNNING.as_bytes()).unwrap();
        let names: Vec<_> = status.peers.iter().map(|p| p.hostname.as_str()).collect();
        assert_eq!(names, ["ci-runner", "friend-box", "grace-pc", "homeserver"]);
        assert_eq!(
            peer(&status, "homeserver").dns_name,
            "homeserver.tailnet-1.ts.net"
        );
    }

    #[test]
    fn classifies_who_owns_each_device() {
        let status = parse_status(RUNNING.as_bytes()).unwrap();
        assert_eq!(peer(&status, "homeserver").ownership, Ownership::Own);
        assert_eq!(
            peer(&status, "grace-pc").ownership,
            Ownership::Other {
                owner: "grace@example.com".into()
            }
        );
        assert_eq!(peer(&status, "ci-runner").ownership, Ownership::Tagged);
        assert_eq!(
            peer(&status, "friend-box").ownership,
            Ownership::Shared {
                owner: "linus@example.org".into()
            }
        );
        assert_eq!(peer(&status, "homeserver").ownership.label(), "Your device");
        assert_eq!(
            peer(&status, "grace-pc").ownership.label(),
            "Shared by grace@example.com"
        );
        assert_eq!(peer(&status, "ci-runner").ownership.label(), "Tagged");
        assert!(!peer(&status, "grace-pc").ownership.is_own());
    }

    #[test]
    fn a_device_in_another_tailnet_is_shared_even_without_the_sharee_flag() {
        let json = RUNNING.replace(r#", "ShareeNode": true"#, "");
        let status = parse_status(json.as_bytes()).unwrap();
        assert!(matches!(
            peer(&status, "friend-box").ownership,
            Ownership::Shared { .. }
        ));
    }

    #[test]
    fn a_tagged_node_never_counts_the_tag_user_as_you() {
        let json = RUNNING.replace(
            r#""Self": { "HostName": "laptop", "DNSName": "laptop.tailnet-1.ts.net.", "UserID": 1,"#,
            r#""Self": { "HostName": "laptop", "DNSName": "laptop.tailnet-1.ts.net.", "UserID": 3, "Tags": ["tag:ci"],"#,
        );
        let status = parse_status(json.as_bytes()).unwrap();
        assert!(status.peers.iter().all(|p| !p.ownership.is_own()));
    }

    #[test]
    fn other_backend_states_have_no_peers() {
        for (state, expected) in [
            ("NeedsLogin", State::NeedsLogin),
            ("NeedsMachineAuth", State::NeedsLogin),
            ("Stopped", State::NotRunning),
            ("Starting", State::NotRunning),
            ("NoState", State::NotRunning),
        ] {
            let json = format!(r#"{{"BackendState":"{state}","Peer":{{}}}}"#);
            let status = parse_status(json.as_bytes()).unwrap();
            assert_eq!(status.state, expected, "{state}");
            assert!(status.peers.is_empty());
        }
    }

    #[test]
    fn garbage_is_not_a_status() {
        assert_eq!(parse_status(b"failed to connect to local tailscaled"), None);
        assert_eq!(parse_status(b"{}"), None);
    }

    #[test]
    fn reads_the_account_table() {
        let table = "ID    Tailnet         Account\n\
                     a1b2  example.com     ada@example.com *\n\
                     c3d4  tailnet-2.ts.net  grace@example.org\n";
        assert_eq!(
            parse_accounts(table),
            vec![
                Account {
                    id: "a1b2".into(),
                    tailnet: "example.com".into(),
                    account: "ada@example.com".into(),
                    current: true
                },
                Account {
                    id: "c3d4".into(),
                    tailnet: "tailnet-2.ts.net".into(),
                    account: "grace@example.org".into(),
                    current: false
                },
            ]
        );
    }

    #[test]
    fn ignores_rows_that_are_not_accounts() {
        assert!(parse_accounts("").is_empty());
        assert!(parse_accounts("ID Tailnet Account\n").is_empty());
        assert!(parse_accounts("ID Tailnet Account\nnot-a-row\n").is_empty());
        assert!(parse_accounts("ID Tailnet Account\n-x;rm  a.com  b@c.d\n").is_empty());
    }

    #[test]
    fn finds_the_binary_in_a_known_location_before_path() {
        let dir = std::env::temp_dir().join(format!("harmony-ts-locate-{}", std::process::id()));
        let known = dir.join("known");
        let on_path = dir.join("path");
        std::fs::create_dir_all(&known).unwrap();
        std::fs::create_dir_all(&on_path).unwrap();
        let known_binary = known.join(BINARY);
        let installed = [known_binary.clone()];
        let path_binary = on_path.join(BINARY);
        let path_var = env::join_paths([&on_path]).unwrap();

        assert_eq!(locate(Some(path_var.clone()), &installed), None);
        std::fs::write(&path_binary, b"").unwrap();
        assert_eq!(
            locate(Some(path_var.clone()), &installed),
            Some(path_binary)
        );
        std::fs::write(&known_binary, b"").unwrap();
        assert_eq!(locate(Some(path_var), &installed), Some(known_binary));
        assert_eq!(locate(None, &[]), None);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_without_a_shell_and_reports_failures_and_timeouts() {
        let echo = Path::new("/bin/echo");
        let out = run(echo, &["a;b $HOME"], Duration::from_secs(5)).await;
        assert_eq!(out.as_deref(), Ok("a;b $HOME\n"));

        let failing = run(
            Path::new("/bin/ls"),
            &["/definitely/not/here"],
            Duration::from_secs(5),
        )
        .await;
        assert!(matches!(failing, Err(RunError::Failed(_))));

        let slow = run(Path::new("/bin/sleep"), &["5"], Duration::from_millis(100)).await;
        assert_eq!(slow, Err(RunError::TimedOut));

        let missing = run(Path::new("/no/such/tailscale"), &[], Duration::from_secs(1)).await;
        assert_eq!(missing, Err(RunError::NotInstalled));
    }
}
