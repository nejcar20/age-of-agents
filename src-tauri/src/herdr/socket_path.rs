use std::path::{Path, PathBuf};

pub trait EnvSource {
    fn get(&self, key: &str) -> Option<String>;
}

pub struct RealEnv;
impl EnvSource for RealEnv {
    fn get(&self, key: &str) -> Option<String> { std::env::var(key).ok() }
}

fn session_socket(home: &Path, name: &str) -> PathBuf {
    home.join(".config/herdr/sessions").join(name).join("herdr.sock")
}

pub fn resolve(session: Option<&str>, env: &dyn EnvSource, home: &Path) -> PathBuf {
    if let Some(name) = session {
        return session_socket(home, name);
    }
    if let Some(p) = env.get("HERDR_SOCKET_PATH") {
        return PathBuf::from(p);
    }
    if let Some(name) = env.get("HERDR_SESSION") {
        return session_socket(home, &name);
    }
    home.join(".config/herdr/herdr.sock")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    struct MapEnv(HashMap<String, String>);
    impl EnvSource for MapEnv {
        fn get(&self, key: &str) -> Option<String> { self.0.get(key).cloned() }
    }
    fn env(pairs: &[(&str, &str)]) -> MapEnv {
        MapEnv(pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }
    fn home() -> PathBuf { PathBuf::from("/home/u") }

    #[test]
    fn explicit_session_wins_over_everything() {
        let e = env(&[("HERDR_SOCKET_PATH", "/tmp/x.sock"), ("HERDR_SESSION", "other")]);
        assert_eq!(
            resolve(Some("work"), &e, &home()),
            PathBuf::from("/home/u/.config/herdr/sessions/work/herdr.sock")
        );
    }

    #[test]
    fn socket_path_env_wins_over_session_env() {
        let e = env(&[("HERDR_SOCKET_PATH", "/tmp/x.sock"), ("HERDR_SESSION", "other")]);
        assert_eq!(resolve(None, &e, &home()), PathBuf::from("/tmp/x.sock"));
    }

    #[test]
    fn session_env_maps_to_sessions_dir() {
        let e = env(&[("HERDR_SESSION", "other")]);
        assert_eq!(
            resolve(None, &e, &home()),
            PathBuf::from("/home/u/.config/herdr/sessions/other/herdr.sock")
        );
    }

    #[test]
    fn default_is_config_herdr_sock() {
        let e = env(&[]);
        assert_eq!(resolve(None, &e, &home()), PathBuf::from("/home/u/.config/herdr/herdr.sock"));
    }
}
