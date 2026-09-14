//! The decisions, with no I/O: given the settings, the local time, the path
//! and today's usage, should this request go through, and if not, why.

use crate::config::Settings;
use crate::time::{LocalTime, format_hhmm, humanize_secs};

/// A `[start, end)` window in minutes of the local day. `end <= start` wraps
/// past midnight (`22:00-06:00`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window {
    start: u32,
    end: u32,
}

impl Window {
    /// Parses `HH:MM-HH:MM` (also `H-HH`, `9-17`).
    pub fn parse(s: &str) -> Result<Self, String> {
        let (a, b) = s
            .trim()
            .split_once('-')
            .ok_or_else(|| format!("expected `HH:MM-HH:MM`, got `{s}`"))?;
        Ok(Self {
            start: parse_hhmm(a)?,
            end: parse_hhmm(b)?,
        })
    }

    pub fn contains(&self, minute_of_day: u32) -> bool {
        if self.start == self.end {
            return false;
        }
        if self.start < self.end {
            (self.start..self.end).contains(&minute_of_day)
        } else {
            minute_of_day >= self.start || minute_of_day < self.end
        }
    }

    pub fn start_hhmm(&self) -> String {
        format_hhmm(self.start)
    }

    pub fn end_hhmm(&self) -> String {
        format_hhmm(self.end)
    }
}

fn parse_hhmm(s: &str) -> Result<u32, String> {
    let s = s.trim();
    let (h, m) = match s.split_once(':') {
        Some((h, m)) => (h, m),
        None => (s, "0"),
    };
    let h: u32 = h.parse().map_err(|_| format!("bad hour in `{s}`"))?;
    let m: u32 = m.parse().map_err(|_| format!("bad minute in `{s}`"))?;
    if h > 24 || m > 59 || (h == 24 && m > 0) {
        return Err(format!("`{s}` is not a time of day"));
    }
    Ok((h * 60 + m) % (24 * 60))
}

/// A set of weekdays, bit `n` = weekday `n` (`0 = Sunday`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Days(u8);

impl Days {
    pub const WEEKDAYS: Days = Days(0b0011_1110);
    pub const ALL: Days = Days(0b0111_1111);

    /// Parses `mon-fri`, `weekdays`, `all`, `none`, `mon,wed,fri`,
    /// `sat-sun`, case-insensitive, three-letter names.
    pub fn parse(s: &str) -> Result<Self, String> {
        let mut bits = 0u8;
        for part in s.split(',').map(str::trim).filter(|p| !p.is_empty()) {
            match part.to_ascii_lowercase().as_str() {
                "all" | "every" | "everyday" => bits |= Self::ALL.0,
                "none" | "never" => {}
                "weekdays" => bits |= Self::WEEKDAYS.0,
                "weekend" | "weekends" => bits |= 0b0100_0001,
                p => match p.split_once('-') {
                    Some((a, b)) => {
                        let a = day_index(a)?;
                        let b = day_index(b)?;
                        let mut d = a;
                        loop {
                            bits |= 1 << d;
                            if d == b {
                                break;
                            }
                            d = (d + 1) % 7;
                        }
                    }
                    None => bits |= 1 << day_index(p)?,
                },
            }
        }
        Ok(Days(bits))
    }

    pub fn contains(&self, weekday: u8) -> bool {
        weekday < 7 && self.0 & (1 << weekday) != 0
    }

    pub fn is_empty(&self) -> bool {
        self.0 == 0
    }
}

fn day_index(s: &str) -> Result<u8, String> {
    let s = s.trim().to_ascii_lowercase();
    let idx = match s.get(..3) {
        Some("sun") => 0,
        Some("mon") => 1,
        Some("tue") => 2,
        Some("wed") => 3,
        Some("thu") => 4,
        Some("fri") => 5,
        Some("sat") => 6,
        _ => return Err(format!("`{s}` is not a day of the week")),
    };
    Ok(idx)
}

/// What kind of URL a request on a managed host is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathKind {
    /// A Shorts page (`/shorts/<id>`), or the Shorts feed.
    Shorts,
    /// The innertube endpoints that only Shorts playback uses.
    ShortsApi,
    /// One of this plugin's own endpoints under `/__witm/noshorts/`.
    Agent(AgentRoute),
    /// Anything else on the site.
    Other,
}

/// The endpoints the in-page agent talks to. They live on the managed
/// host's origin (the proxy answers them before anything reaches YouTube),
/// which is what lets the page's script call them without CORS or CSP
/// `connect-src` trouble.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentRoute {
    /// The agent document, loaded in a hidden same-origin iframe.
    Agent,
    /// Heartbeat: `?active=0|1&dt=<seconds since last tick>`.
    Tick,
    /// Clickbait scoring for a batch of feed titles (JSON body).
    Score,
    /// The block page, `?reason=<code>`.
    Blocked,
    /// Current state as JSON, for humans and tests.
    Status,
}

pub const AGENT_PREFIX: &str = "/__witm/noshorts/";

pub fn classify_path(path: &str) -> PathKind {
    if let Some(rest) = path.strip_prefix(AGENT_PREFIX) {
        let rest = rest.trim_end_matches('/');
        return match rest {
            "agent" => PathKind::Agent(AgentRoute::Agent),
            "tick" => PathKind::Agent(AgentRoute::Tick),
            "score" => PathKind::Agent(AgentRoute::Score),
            "blocked" => PathKind::Agent(AgentRoute::Blocked),
            "status" => PathKind::Agent(AgentRoute::Status),
            _ => PathKind::Other,
        };
    }
    if path == "/shorts" || path.starts_with("/shorts/") {
        return PathKind::Shorts;
    }
    if path.starts_with("/youtubei/v1/reel/") {
        return PathKind::ShortsApi;
    }
    PathKind::Other
}

/// Why a request was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Reason {
    Shorts,
    WorkHours {
        /// `HH:MM` when the window closes.
        until: String,
        /// `HH:MM` local now, for the page.
        now: String,
    },
    Budget {
        used_secs: u64,
        budget_secs: u64,
        resets_in_secs: u64,
    },
}

impl Reason {
    /// Stable short code, carried in the `x-witm-noshorts` header and the
    /// block page's `?reason=` parameter.
    pub fn code(&self) -> &'static str {
        match self {
            Reason::Shorts => "shorts",
            Reason::WorkHours { .. } => "work-hours",
            Reason::Budget { .. } => "budget",
        }
    }

    pub fn title(&self) -> &'static str {
        match self {
            Reason::Shorts => "Shorts are off",
            Reason::WorkHours { .. } => "Not during working hours",
            Reason::Budget { .. } => "That is enough YouTube for today",
        }
    }

    /// One or two plain sentences for the block page.
    pub fn explanation(&self) -> String {
        match self {
            Reason::Shorts => "This proxy does not load YouTube Shorts, in any form: the feed, \
                               the tab, or an individual short. There is nothing to wait for."
                .to_string(),
            Reason::WorkHours { until, now } => format!(
                "YouTube is blocked during working hours. It is {now} now; the block lifts at {until}."
            ),
            Reason::Budget {
                used_secs,
                budget_secs,
                resets_in_secs,
            } => format!(
                "You have spent {} actively watching today, against a daily budget of {}. \
                 The counter resets at midnight, in {}.",
                humanize_secs(*used_secs),
                humanize_secs(*budget_secs),
                humanize_secs(*resets_in_secs)
            ),
        }
    }
}

/// Active-time accounting for one local day.
///
/// Heartbeats come from every open YouTube tab, so a naive sum double-counts
/// two tabs. Each credit is bounded by the wall-clock time elapsed since the
/// previous credit: usage can never grow faster than real time, however
/// many tabs are ticking.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Ledger {
    pub used_secs: u64,
    pub last_credit_ms: u64,
}

impl Ledger {
    /// Credits an active heartbeat. `dt_secs` is what the tab claims elapsed
    /// since its previous tick; it is clamped to twice the heartbeat period
    /// (a tab that was suspended and wakes up claiming an hour gets two
    /// periods, not an hour). Returns the seconds actually credited.
    pub fn credit(&mut self, now_ms: u64, dt_secs: u64, heartbeat_secs: u64) -> u64 {
        let claimed = dt_secs.min(heartbeat_secs.saturating_mul(2).max(1));
        let credit = if self.last_credit_ms == 0 {
            claimed
        } else {
            let elapsed_ms = now_ms.saturating_sub(self.last_credit_ms);
            // Nearest second: a tick that lands a few ms after the previous
            // one credits nothing, while normal jitter around the heartbeat
            // period does not shave a second off every tick.
            claimed.min((elapsed_ms + 500) / 1000)
        };
        self.used_secs = self.used_secs.saturating_add(credit);
        if credit > 0 || self.last_credit_ms == 0 {
            self.last_credit_ms = now_ms;
        }
        credit
    }

    pub fn remaining(&self, budget_secs: u64) -> u64 {
        budget_secs.saturating_sub(self.used_secs)
    }
}

/// The verdict for a request on a managed host. `None` means let it through.
pub fn decide(settings: &Settings, now: &LocalTime, kind: PathKind, used_secs: u64) -> Option<Reason> {
    if let PathKind::Agent(_) = kind {
        return None;
    }
    if settings.block_shorts && matches!(kind, PathKind::Shorts | PathKind::ShortsApi) {
        return Some(Reason::Shorts);
    }
    if let Some(reason) = time_verdict(settings, now, used_secs) {
        return Some(reason);
    }
    None
}

/// The time-based part of the verdict, shared by request handling and the
/// heartbeat (which has no path to classify).
pub fn time_verdict(settings: &Settings, now: &LocalTime, used_secs: u64) -> Option<Reason> {
    if settings.work_days.contains(now.weekday()) && settings.work_window.contains(now.minute_of_day())
    {
        return Some(Reason::WorkHours {
            until: settings.work_window.end_hhmm(),
            now: now.hhmm(),
        });
    }
    if used_secs >= settings.daily_budget_secs {
        return Some(Reason::Budget {
            used_secs,
            budget_secs: settings.daily_budget_secs,
            resets_in_secs: now.secs_until_midnight(),
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Settings;

    fn at(weekday_days_since_epoch: i64, hhmm: &str) -> LocalTime {
        let m = parse_hhmm(hhmm).unwrap();
        LocalTime::new((weekday_days_since_epoch * 86_400 + m as i64 * 60) as u64, 0)
    }
    // 1970-01-05 was a Monday.
    const MONDAY: i64 = 4;
    const SATURDAY: i64 = 9;

    #[test]
    fn window_parsing_and_containment() {
        let w = Window::parse("08:00-17:00").unwrap();
        assert!(!w.contains(7 * 60 + 59));
        assert!(w.contains(8 * 60));
        assert!(w.contains(16 * 60 + 59));
        assert!(!w.contains(17 * 60));
        assert_eq!(w.end_hhmm(), "17:00");

        let w = Window::parse("9-17").unwrap();
        assert!(w.contains(9 * 60));

        let night = Window::parse("22:00-06:00").unwrap();
        assert!(night.contains(23 * 60));
        assert!(night.contains(5 * 60));
        assert!(!night.contains(12 * 60));

        assert!(Window::parse("25:00-26:00").is_err());
        assert!(Window::parse("nonsense").is_err());
        assert!(!Window::parse("09:00-09:00").unwrap().contains(9 * 60));
    }

    #[test]
    fn days_parsing() {
        assert_eq!(Days::parse("mon-fri").unwrap(), Days::WEEKDAYS);
        assert_eq!(Days::parse("weekdays").unwrap(), Days::WEEKDAYS);
        assert_eq!(Days::parse("all").unwrap(), Days::ALL);
        assert!(Days::parse("none").unwrap().is_empty());
        let d = Days::parse("Sat,Sun").unwrap();
        assert!(d.contains(0) && d.contains(6) && !d.contains(1));
        let wrap = Days::parse("fri-mon").unwrap();
        assert!(wrap.contains(5) && wrap.contains(6) && wrap.contains(0) && wrap.contains(1));
        assert!(!wrap.contains(3));
        assert!(Days::parse("funday").is_err());
    }

    #[test]
    fn path_classification() {
        assert_eq!(classify_path("/shorts/abc"), PathKind::Shorts);
        assert_eq!(classify_path("/shorts"), PathKind::Shorts);
        assert_eq!(classify_path("/shortsy"), PathKind::Other);
        assert_eq!(
            classify_path("/youtubei/v1/reel/reel_item_watch"),
            PathKind::ShortsApi
        );
        assert_eq!(classify_path("/youtubei/v1/browse"), PathKind::Other);
        assert_eq!(classify_path("/watch"), PathKind::Other);
        assert_eq!(
            classify_path("/__witm/noshorts/tick"),
            PathKind::Agent(AgentRoute::Tick)
        );
        assert_eq!(
            classify_path("/__witm/noshorts/agent/"),
            PathKind::Agent(AgentRoute::Agent)
        );
        assert_eq!(classify_path("/__witm/noshorts/nope"), PathKind::Other);
    }

    #[test]
    fn shorts_are_refused_regardless_of_time() {
        let s = Settings::default();
        let sat_night = at(SATURDAY, "23:00");
        assert_eq!(decide(&s, &sat_night, PathKind::Shorts, 0), Some(Reason::Shorts));
        assert_eq!(
            decide(&s, &sat_night, PathKind::ShortsApi, 0),
            Some(Reason::Shorts)
        );
        assert_eq!(decide(&s, &sat_night, PathKind::Other, 0), None);

        let s = Settings {
            block_shorts: false,
            ..Settings::default()
        };
        assert_eq!(decide(&s, &sat_night, PathKind::Shorts, 0), None);
    }

    #[test]
    fn working_hours_apply_on_work_days_only() {
        let s = Settings::default();
        let verdict = decide(&s, &at(MONDAY, "10:30"), PathKind::Other, 0);
        assert_eq!(
            verdict,
            Some(Reason::WorkHours {
                until: "17:00".into(),
                now: "10:30".into()
            })
        );
        assert_eq!(decide(&s, &at(MONDAY, "17:00"), PathKind::Other, 0), None);
        assert_eq!(decide(&s, &at(MONDAY, "07:59"), PathKind::Other, 0), None);
        assert_eq!(decide(&s, &at(SATURDAY, "10:30"), PathKind::Other, 0), None);
    }

    #[test]
    fn budget_exhaustion_blocks_and_reports_reset() {
        let s = Settings::default(); // 30 minutes
        let t = at(SATURDAY, "23:50");
        assert_eq!(decide(&s, &t, PathKind::Other, 29 * 60), None);
        assert_eq!(
            decide(&s, &t, PathKind::Other, 30 * 60),
            Some(Reason::Budget {
                used_secs: 1800,
                budget_secs: 1800,
                resets_in_secs: 600
            })
        );
    }

    #[test]
    fn agent_routes_always_pass() {
        let s = Settings::default();
        let t = at(MONDAY, "10:30");
        assert_eq!(
            decide(&s, &t, PathKind::Agent(AgentRoute::Tick), u64::MAX),
            None
        );
    }

    #[test]
    fn ledger_is_bounded_by_wall_clock() {
        let mut l = Ledger::default();
        // First tick: trusted up to 2x heartbeat.
        assert_eq!(l.credit(1_000, 3_600, 15), 30);
        assert_eq!(l.used_secs, 30);
        // Two tabs ticking 15s apart in lockstep: each claims 15, but only
        // 7.5s of wall clock passed between them.
        assert_eq!(l.credit(8_500, 15, 15), 8);
        assert_eq!(l.credit(16_000, 15, 15), 8);
        assert_eq!(l.used_secs, 46);
        // A single tab at the nominal rate is credited in full.
        assert_eq!(l.credit(31_000, 15, 15), 15);
        // Nothing elapsed: nothing credited, and the anchor is not moved.
        assert_eq!(l.credit(31_000, 15, 15), 0);
        assert_eq!(l.last_credit_ms, 31_000);
        assert_eq!(l.remaining(100), 39);
        assert_eq!(l.remaining(10), 0);
    }
}
