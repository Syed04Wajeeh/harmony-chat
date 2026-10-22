use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const FILE: &str = "config.json";

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub server_url: Option<String>,
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
}
