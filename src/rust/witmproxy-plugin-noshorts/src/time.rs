//! Local wall-clock arithmetic on top of `(unix seconds, utc offset)`.
//!
//! The host clock hands the guest a Unix timestamp and its own time zone
//! offset; everything the policy needs (day boundaries, minute of day,
//! weekday, a printable date) is integer arithmetic on those two numbers,
//! so no calendar crate is compiled into the component.

/// A moment in the user's local time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
    epoch_secs: u64,
    offset_secs: i32,
}

/// Day of week, `0 = Sunday .. 6 = Saturday` (the CEL `time` convention).
pub type Weekday = u8;

pub const SECS_PER_DAY: i64 = 86_400;

impl LocalTime {
    pub fn new(epoch_secs: u64, offset_secs: i32) -> Self {
        Self {
            epoch_secs,
            offset_secs,
        }
    }

    pub fn epoch_secs(&self) -> u64 {
        self.epoch_secs
    }

    pub fn offset_secs(&self) -> i32 {
        self.offset_secs
    }

    fn local_secs(&self) -> i64 {
        self.epoch_secs as i64 + self.offset_secs as i64
    }

    /// Whole local days since 1970-01-01.
    pub fn days(&self) -> i64 {
        self.local_secs().div_euclid(SECS_PER_DAY)
    }

    pub fn seconds_of_day(&self) -> u32 {
        self.local_secs().rem_euclid(SECS_PER_DAY) as u32
    }

    pub fn minute_of_day(&self) -> u32 {
        self.seconds_of_day() / 60
    }

    /// 1970-01-01 was a Thursday.
    pub fn weekday(&self) -> Weekday {
        (self.days() + 4).rem_euclid(7) as Weekday
    }

    /// Seconds left until the next local midnight (at least 1).
    pub fn secs_until_midnight(&self) -> u64 {
        (SECS_PER_DAY as u32 - self.seconds_of_day()).max(1) as u64
    }

    /// Proleptic Gregorian `(year, month, day)`; Howard Hinnant's
    /// `civil_from_days`.
    pub fn date(&self) -> (i32, u32, u32) {
        let z = self.days() + 719_468;
        let era = z.div_euclid(146_097);
        let doe = z.rem_euclid(146_097);
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
        let y = yoe + era * 400;
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
        let mp = (5 * doy + 2) / 153;
        let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
        let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
        let y = if m <= 2 { y + 1 } else { y };
        (y as i32, m, d)
    }

    /// `YYYY-MM-DD` of the local day: the key under which usage is kept.
    pub fn date_string(&self) -> String {
        let (y, m, d) = self.date();
        format!("{y:04}-{m:02}-{d:02}")
    }

    /// `HH:MM` local.
    pub fn hhmm(&self) -> String {
        format_hhmm(self.minute_of_day())
    }
}

pub fn format_hhmm(minute_of_day: u32) -> String {
    let m = minute_of_day % (24 * 60);
    format!("{:02}:{:02}", m / 60, m % 60)
}

/// `1h 05m`, `12m`, `40s`: for the block page.
pub fn humanize_secs(secs: u64) -> String {
    let h = secs / 3600;
    let m = (secs % 3600) / 60;
    let s = secs % 60;
    if h > 0 {
        format!("{h}h {m:02}m")
    } else if m > 0 {
        format!("{m}m")
    } else {
        format!("{s}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epoch_is_a_thursday_at_utc() {
        let t = LocalTime::new(0, 0);
        assert_eq!(t.weekday(), 4);
        assert_eq!(t.date_string(), "1970-01-01");
        assert_eq!(t.hhmm(), "00:00");
    }

    #[test]
    fn offset_moves_the_day_boundary() {
        // 2026-09-13T02:30:00Z
        let utc = 1_789_266_600u64;
        assert_eq!(LocalTime::new(utc, 0).date_string(), "2026-09-13");
        // Vancouver (UTC-7 in September): still the 12th, 19:30.
        let pdt = LocalTime::new(utc, -7 * 3600);
        assert_eq!(pdt.date_string(), "2026-09-12");
        assert_eq!(pdt.hhmm(), "19:30");
        assert_eq!(pdt.weekday(), 6, "the 12th of September 2026 is a Saturday");
        // Tokyo: the 13th, 11:30, a Sunday.
        let jst = LocalTime::new(utc, 9 * 3600);
        assert_eq!(jst.hhmm(), "11:30");
        assert_eq!(jst.weekday(), 0);
    }

    #[test]
    fn civil_from_days_matches_known_dates() {
        // 2000-02-29 00:00 UTC
        assert_eq!(LocalTime::new(951_782_400, 0).date(), (2000, 2, 29));
        // 2024-12-31 23:59:59 UTC
        assert_eq!(LocalTime::new(1_735_689_599, 0).date(), (2024, 12, 31));
    }

    #[test]
    fn until_midnight_is_never_zero() {
        assert_eq!(LocalTime::new(0, 0).secs_until_midnight(), 86_400);
        assert_eq!(LocalTime::new(86_399, 0).secs_until_midnight(), 1);
    }

    #[test]
    fn humanize() {
        assert_eq!(humanize_secs(0), "0s");
        assert_eq!(humanize_secs(59), "59s");
        assert_eq!(humanize_secs(60), "1m");
        assert_eq!(humanize_secs(3_900), "1h 05m");
    }
}
