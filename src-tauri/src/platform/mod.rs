#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "macos")]
pub use macos::{activate_terminal, detect_terminal_app};

#[cfg(not(target_os = "macos"))]
pub fn activate_terminal(_app_name: &str) -> anyhow::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn detect_terminal_app() -> String {
    "Terminal".to_string()
}
