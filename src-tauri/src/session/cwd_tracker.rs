use regex::Regex;
use std::sync::OnceLock;

#[allow(dead_code)]
static OSC7_RE: OnceLock<Regex> = OnceLock::new();
#[allow(dead_code)]
static ITERM_RE: OnceLock<Regex> = OnceLock::new();

#[allow(dead_code)]
pub struct CwdTracker;

impl CwdTracker {
    #[allow(dead_code)]
    pub fn parse_cwd(data: &str) -> Option<String> {
        let osc7 = OSC7_RE.get_or_init(|| {
            Regex::new(r"\x1b\]7;file://[^/]*([^\x07\x1b]+)(\x07|\x1b\\)").unwrap()
        });
        if let Some(caps) = osc7.captures(data) {
            if let Some(m) = caps.get(1) {
                let path = m.as_str().trim();
                if !path.is_empty() {
                    return Some(path.to_string());
                }
            }
        }

        let iterm = ITERM_RE.get_or_init(|| {
            Regex::new(r"\x1b\]1337;CurrentDir=([^\x07\x1b]+)(\x07|\x1b\\)").unwrap()
        });
        if let Some(caps) = iterm.captures(data) {
            if let Some(m) = caps.get(1) {
                let path = m.as_str().trim();
                if !path.is_empty() {
                    return Some(path.to_string());
                }
            }
        }

        None
    }
}
