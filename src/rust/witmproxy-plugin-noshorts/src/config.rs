//! User configuration, decoupled from the WIT input types so it can be
//! parsed and tested on the host.
//!
//! Every value is accepted as a string as well as its natural type: the
//! `witm plugin configure --set key=value` CLI stores strings regardless of
//! the declared input type.

use crate::policy::{Days, Window};

/// A configuration value as the host delivered it.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Bool(bool),
    Num(f64),
}

impl Value {
    fn as_str(&self) -> Option<&str> {
        match self {
            Value::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    fn as_bool(&self) -> Result<bool, String> {
        match self {
            Value::Bool(b) => Ok(*b),
            Value::Num(n) => Ok(*n != 0.0),
            Value::Str(s) => match s.trim().to_ascii_lowercase().as_str() {
                "true" | "yes" | "on" | "1" => Ok(true),
                "false" | "no" | "off" | "0" | "" => Ok(false),
                other => Err(format!("`{other}` is not a boolean")),
            },
        }
    }

    fn as_f64(&self) -> Result<f64, String> {
        match self {
            Value::Num(n) => Ok(*n),
            Value::Bool(b) => Ok(if *b { 1.0 } else { 0.0 }),
            Value::Str(s) => s
                .trim()
                .parse::<f64>()
                .map_err(|_| format!("`{s}` is not a number")),
        }
    }

    fn to_text(&self) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Bool(b) => b.to_string(),
            Value::Num(n) => n.to_string(),
        }
    }
}

/// The declared shape of one configuration input, mirrored into the WIT
/// manifest by the guest.
#[derive(Debug, Clone)]
pub struct InputSpec {
    pub name: &'static str,
    pub kind: InputKind,
    pub default: Value,
    pub description: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputKind {
    Str,
    Bool,
    Num,
}

pub const DEFAULT_HOSTS: &str =
    "youtube.com, m.youtube.com, www.youtube.com, youtu.be, youtube-nocookie.com";

/// The inputs the plugin declares, with their defaults. Order is the order
/// the operator sees them in.
pub fn schema() -> Vec<InputSpec> {
    vec![
        InputSpec {
            name: "hosts",
            kind: InputKind::Str,
            default: Value::Str(DEFAULT_HOSTS.into()),
            description: "Comma-separated hosts this plugin manages (a host matches itself and its subdomains)",
        },
        InputSpec {
            name: "block_shorts",
            kind: InputKind::Bool,
            default: Value::Bool(true),
            description: "Refuse Shorts pages and the Shorts playback API outright",
        },
        InputSpec {
            name: "hide_shorts_ui",
            kind: InputKind::Bool,
            default: Value::Bool(true),
            description: "Inject CSS that hides Shorts shelves, tabs and links from YouTube pages",
        },
        InputSpec {
            name: "daily_budget_minutes",
            kind: InputKind::Num,
            default: Value::Num(30.0),
            description: "Minutes of active YouTube use allowed per local day",
        },
        InputSpec {
            name: "work_hours",
            kind: InputKind::Str,
            default: Value::Str("08:00-17:00".into()),
            description: "Local time window during which YouTube is blocked entirely (HH:MM-HH:MM)",
        },
        InputSpec {
            name: "work_days",
            kind: InputKind::Str,
            default: Value::Str("mon-fri".into()),
            description: "Days the working-hours block applies to (e.g. mon-fri, all, none)",
        },
        InputSpec {
            name: "utc_offset_minutes",
            kind: InputKind::Str,
            default: Value::Str(String::new()),
            description: "Override the host's local time zone offset, in minutes east of UTC (blank = use the host's)",
        },
        InputSpec {
            name: "heartbeat_seconds",
            kind: InputKind::Num,
            default: Value::Num(15.0),
            description: "How often open YouTube tabs report activity",
        },
        InputSpec {
            name: "idle_seconds",
            kind: InputKind::Num,
            default: Value::Num(180.0),
            description: "A visible tab with no input for this long and no video playing is not counted as active",
        },
        InputSpec {
            name: "filter_enabled",
            kind: InputKind::Bool,
            default: Value::Bool(true),
            description: "Hide feed items whose titles score as clickbait or ragebait",
        },
        InputSpec {
            name: "filter_threshold",
            kind: InputKind::Num,
            default: Value::Num(0.6),
            description: "Clickbait score (0-1) at or above which a feed item is hidden",
        },
        InputSpec {
            name: "filter_keywords",
            kind: InputKind::Str,
            default: Value::Str(String::new()),
            description: "Extra comma-separated words or phrases that mark a title as clickbait",
        },
    ]
}

/// Parsed, validated settings.
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    pub hosts: Vec<String>,
    pub block_shorts: bool,
    pub hide_shorts_ui: bool,
    pub daily_budget_secs: u64,
    pub work_window: Window,
    pub work_days: Days,
    pub utc_offset_override_secs: Option<i32>,
    pub heartbeat_secs: u64,
    pub idle_secs: u64,
    pub filter_enabled: bool,
    pub filter_threshold: f32,
    pub filter_keywords: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings::from_inputs(&[]).expect("defaults parse")
    }
}

impl Settings {
    /// Builds settings from `(name, value)` pairs; anything not supplied
    /// takes its declared default. Unknown names are ignored so an operator
    /// can leave stale keys behind without breaking the plugin.
    pub fn from_inputs(inputs: &[(String, Value)]) -> Result<Self, String> {
        let get = |name: &str| -> Value {
            inputs
                .iter()
                .find(|(n, _)| n == name)
                .map(|(_, v)| v.clone())
                .unwrap_or_else(|| {
                    schema()
                        .into_iter()
                        .find(|s| s.name == name)
                        .map(|s| s.default)
                        .expect("every setting has a schema entry")
                })
        };
        let field = |name: &str, e: String| format!("{name}: {e}");

        let hosts: Vec<String> = get("hosts")
            .to_text()
            .split(',')
            .map(|h| h.trim().trim_start_matches('.').to_ascii_lowercase())
            .filter(|h| !h.is_empty())
            .collect();
        if hosts.is_empty() {
            return Err("hosts: at least one host is required".into());
        }

        let minutes = get("daily_budget_minutes")
            .as_f64()
            .map_err(|e| field("daily_budget_minutes", e))?;
        if !(0.0..=24.0 * 60.0).contains(&minutes) {
            return Err("daily_budget_minutes: must be between 0 and 1440".into());
        }

        let work_window = Window::parse(&get("work_hours").to_text())
            .map_err(|e| field("work_hours", e))?;
        let work_days = Days::parse(&get("work_days").to_text()).map_err(|e| field("work_days", e))?;

        let offset = get("utc_offset_minutes");
        let utc_offset_override_secs = match offset.as_str().map(str::trim) {
            Some("") | None if matches!(offset, Value::Str(_)) => None,
            _ => {
                let m = offset.as_f64().map_err(|e| field("utc_offset_minutes", e))?;
                if !(-14.0 * 60.0..=14.0 * 60.0).contains(&m) {
                    return Err("utc_offset_minutes: must be between -840 and 840".into());
                }
                Some((m * 60.0) as i32)
            }
        };

        let heartbeat = get("heartbeat_seconds")
            .as_f64()
            .map_err(|e| field("heartbeat_seconds", e))?;
        if !(1.0..=600.0).contains(&heartbeat) {
            return Err("heartbeat_seconds: must be between 1 and 600".into());
        }
        let idle = get("idle_seconds")
            .as_f64()
            .map_err(|e| field("idle_seconds", e))?;
        if idle < 0.0 {
            return Err("idle_seconds: must not be negative".into());
        }
        let threshold = get("filter_threshold")
            .as_f64()
            .map_err(|e| field("filter_threshold", e))?;
        if !(0.0..=1.0).contains(&threshold) {
            return Err("filter_threshold: must be between 0 and 1".into());
        }
        let filter_keywords = get("filter_keywords")
            .to_text()
            .split(',')
            .map(|k| k.trim().to_lowercase())
            .filter(|k| !k.is_empty())
            .collect();

        Ok(Settings {
            hosts,
            block_shorts: get("block_shorts")
                .as_bool()
                .map_err(|e| field("block_shorts", e))?,
            hide_shorts_ui: get("hide_shorts_ui")
                .as_bool()
                .map_err(|e| field("hide_shorts_ui", e))?,
            daily_budget_secs: (minutes * 60.0).round() as u64,
            work_window,
            work_days,
            utc_offset_override_secs,
            heartbeat_secs: heartbeat.round() as u64,
            idle_secs: idle.round() as u64,
            filter_enabled: get("filter_enabled")
                .as_bool()
                .map_err(|e| field("filter_enabled", e))?,
            filter_threshold: threshold as f32,
            filter_keywords,
        })
    }

    /// Whether `host` (with or without a port) is one this plugin manages.
    pub fn is_managed_host(&self, host: &str) -> bool {
        let host = host
            .rsplit_once(':')
            .filter(|(_, port)| port.chars().all(|c| c.is_ascii_digit()))
            .map(|(h, _)| h)
            .unwrap_or(host)
            .trim_end_matches('.')
            .to_ascii_lowercase();
        self.hosts.iter().any(|managed| {
            host == *managed
                || host
                    .strip_suffix(managed.as_str())
                    .is_some_and(|prefix| prefix.ends_with('.'))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(name: &str, v: &str) -> (String, Value) {
        (name.to_string(), Value::Str(v.to_string()))
    }

    #[test]
    fn defaults_are_the_documented_ones() {
        let d = Settings::default();
        assert!(d.block_shorts && d.hide_shorts_ui && d.filter_enabled);
        assert_eq!(d.daily_budget_secs, 30 * 60);
        assert_eq!(d.work_window, Window::parse("08:00-17:00").unwrap());
        assert_eq!(d.work_days, Days::WEEKDAYS);
        assert_eq!(d.utc_offset_override_secs, None);
        assert_eq!(d.heartbeat_secs, 15);
        assert!(d.is_managed_host("www.youtube.com"));
    }

    #[test]
    fn strings_are_accepted_for_every_type() {
        let cfg = Settings::from_inputs(&[
            s("block_shorts", "no"),
            s("daily_budget_minutes", "0.5"),
            s("work_hours", "9-12"),
            s("work_days", "all"),
            s("utc_offset_minutes", "-420"),
            s("heartbeat_seconds", "2"),
            s("filter_threshold", "0.9"),
            s("filter_keywords", "Drama, EXPOSED ,"),
        ])
        .unwrap();
        assert!(!cfg.block_shorts);
        assert_eq!(cfg.daily_budget_secs, 30);
        assert_eq!(cfg.work_days, Days::ALL);
        assert_eq!(cfg.utc_offset_override_secs, Some(-7 * 3600));
        assert_eq!(cfg.heartbeat_secs, 2);
        assert_eq!(cfg.filter_keywords, vec!["drama", "exposed"]);
    }

    #[test]
    fn typed_values_work_too() {
        let cfg = Settings::from_inputs(&[
            ("block_shorts".into(), Value::Bool(false)),
            ("daily_budget_minutes".into(), Value::Num(10.0)),
            ("utc_offset_minutes".into(), Value::Num(60.0)),
        ])
        .unwrap();
        assert!(!cfg.block_shorts);
        assert_eq!(cfg.daily_budget_secs, 600);
        assert_eq!(cfg.utc_offset_override_secs, Some(3600));
    }

    #[test]
    fn bad_values_name_the_field() {
        let err = Settings::from_inputs(&[s("work_hours", "9am to 5pm")]).unwrap_err();
        assert!(err.starts_with("work_hours:"), "{err}");
        let err = Settings::from_inputs(&[s("daily_budget_minutes", "lots")]).unwrap_err();
        assert!(err.starts_with("daily_budget_minutes:"), "{err}");
        assert!(Settings::from_inputs(&[s("hosts", " , ")]).is_err());
        assert!(Settings::from_inputs(&[s("filter_threshold", "2")]).is_err());
    }

    #[test]
    fn host_matching_is_suffix_based_and_port_tolerant() {
        let cfg = Settings::from_inputs(&[s("hosts", "youtube.com, youtu.be")]).unwrap();
        assert!(cfg.is_managed_host("youtube.com"));
        assert!(cfg.is_managed_host("WWW.YouTube.com"));
        assert!(cfg.is_managed_host("m.youtube.com:443"));
        assert!(cfg.is_managed_host("youtu.be"));
        assert!(!cfg.is_managed_host("notyoutube.com"));
        assert!(!cfg.is_managed_host("youtube.com.evil.example"));
        assert!(!cfg.is_managed_host("example.com"));
        let local = Settings::from_inputs(&[s("hosts", "127.0.0.1")]).unwrap();
        assert!(local.is_managed_host("127.0.0.1:8443"));
    }
}
