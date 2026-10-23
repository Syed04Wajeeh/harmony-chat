use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const FILE: &str = "config.json";

const MAX_KNOWN: usize = 20;
const MAX_LABEL: usize = 80;

/// A server this app has connected to before, listed on the setup page for one-click reconnect.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownServer {
    pub url: String,
    pub name: String,
    /// Seconds since the Unix epoch.
    pub last_used: u64,
    pub owner_label: Option<String>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The server the window opens on start; none while disconnected.
    pub server_url: Option<String>,
    #[serde(default)]
    pub known_servers: Vec<KnownServer>,
}

impl Config {
    /// Marks `url` as the connected server and moves it to the top of the recent list.
    pub fn connect(&mut self, url: &str, name: &str, owner_label: Option<&str>, now: u64) {
        let owner_label = owner_label
            .map(|label| label.chars().take(MAX_LABEL).collect::<String>())
            .filter(|label| !label.trim().is_empty())
            .or_else(|| {
                self.known_servers
                    .iter()
                    .find(|known| known.url == url)
                    .and_then(|known| known.owner_label.clone())
            });
        self.known_servers.retain(|known| known.url != url);
        self.known_servers.insert(
            0,
            KnownServer {
                url: url.to_owned(),
                name: name.to_owned(),
                last_used: now,
                owner_label,
            },
        );
        self.known_servers.truncate(MAX_KNOWN);
        self.server_url = Some(url.to_owned());
    }

    /// Drops the connection but keeps the recent list.
    pub fn disconnect(&mut self) {
        self.server_url = None;
    }

    /// Removes `url` from the recent list; browsing data is not touched.
    pub fn forget(&mut self, url: &str) {
        self.known_servers.retain(|known| known.url != url);
        if self.server_url.as_deref() == Some(url) {
            self.server_url = None;
        }
    }
}

/// The settings file in the app config directory.
pub struct ConfigStore {
    path: PathBuf,
}

impl ConfigStore {
    pub fn new(dir: PathBuf) -> Self {
        Self {
            path: dir.join(FILE),
        }
    }

    /// A missing or unreadable file is the same as a fresh install.
    pub fn load(&self) -> Config {
        fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, config: &Config) -> io::Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let temp = self.path.with_extension("json.tmp");
        fs::write(&temp, serde_json::to_vec_pretty(config)?)?;
        fs::rename(temp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(name: &str) -> ConfigStore {
        let dir = std::env::temp_dir().join(format!(
            "harmony-desktop-test-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        ConfigStore::new(dir)
    }

    #[test]
    fn missing_file_loads_as_default() {
        assert_eq!(store("missing").load(), Config::default());
    }

    #[test]
    fn saves_and_loads_the_server_url() {
        let store = store("roundtrip");
        let config = Config {
            server_url: Some("https://chat.example.ts.net".into()),
            ..Config::default()
        };
        store.save(&config).unwrap();
        assert_eq!(store.load(), config);
    }

    #[test]
    fn corrupt_file_loads_as_default() {
        let store = store("corrupt");
        store.save(&Config::default()).unwrap();
        fs::write(&store.path, b"{ not json").unwrap();
        assert_eq!(store.load(), Config::default());
    }

    #[test]
    fn a_config_from_before_the_recent_list_still_loads() {
        let store = store("legacy");
        store.save(&Config::default()).unwrap();
        fs::write(
            &store.path,
            br#"{"serverUrl":"https://chat.example.ts.net/"}"#,
        )
        .unwrap();
        let config = store.load();
        assert_eq!(
            config.server_url.as_deref(),
            Some("https://chat.example.ts.net/")
        );
        assert!(config.known_servers.is_empty());
    }

    #[test]
    fn connecting_moves_the_server_to_the_top_without_duplicates() {
        let mut config = Config::default();
        config.connect("https://a.example.ts.net/", "a", Some("Your device"), 1);
        config.connect("https://b.example.ts.net/", "b", None, 2);
        config.connect("https://a.example.ts.net/", "a", None, 3);
        let urls: Vec<_> = config
            .known_servers
            .iter()
            .map(|k| k.url.as_str())
            .collect();
        assert_eq!(
            urls,
            ["https://a.example.ts.net/", "https://b.example.ts.net/"]
        );
        assert_eq!(config.known_servers[0].last_used, 3);
        assert_eq!(
            config.known_servers[0].owner_label.as_deref(),
            Some("Your device"),
            "a reconnect without a label keeps the earlier one"
        );
        assert_eq!(
            config.server_url.as_deref(),
            Some("https://a.example.ts.net/")
        );
    }

    #[test]
    fn the_recent_list_is_capped() {
        let mut config = Config::default();
        for n in 0..(MAX_KNOWN + 5) {
            config.connect(
                &format!("https://s{n}.example.ts.net/"),
                "s",
                None,
                n as u64,
            );
        }
        assert_eq!(config.known_servers.len(), MAX_KNOWN);
        assert_eq!(config.known_servers[0].url, "https://s24.example.ts.net/");
    }

    #[test]
    fn disconnect_keeps_the_list_and_forget_removes_only_one_entry() {
        let mut config = Config::default();
        config.connect("https://a.example.ts.net/", "a", None, 1);
        config.connect("https://b.example.ts.net/", "b", None, 2);
        config.disconnect();
        assert_eq!(config.server_url, None);
        assert_eq!(config.known_servers.len(), 2);
        config.forget("https://a.example.ts.net/");
        assert_eq!(config.known_servers.len(), 1);
        assert_eq!(config.known_servers[0].url, "https://b.example.ts.net/");
    }
}
