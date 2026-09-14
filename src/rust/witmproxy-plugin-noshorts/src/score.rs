//! A first pass at recognising clickbait and ragebait from a title alone.
//!
//! This is deliberately a transparent, testable heuristic rather than a
//! model: each signal adds a fixed amount and names itself, so a hidden item
//! can always be explained. Titles are all the agent can see cheaply; see the
//! README for what a real classifier would need from the host (outbound
//! HTTP, a persistent annotator, engagement metadata from the feed JSON).

/// The scorer's opinion of one title.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Verdict {
    /// `0.0` (fine) to `1.0` (certainly bait).
    pub score: f32,
    /// The signals that fired, in the order they were checked.
    pub reasons: Vec<&'static str>,
}

/// Phrases that almost never appear in an honest title. Matched
/// case-insensitively as substrings.
const BAIT_PHRASES: &[&str] = &[
    "you won't believe",
    "you wont believe",
    "you will not believe",
    "won't believe",
    "gone wrong",
    "gone sexual",
    "not clickbait",
    "blow your mind",
    "mind blowing",
    "mind-blowing",
    "must watch",
    "must see",
    "what happens next",
    "wait for it",
    "the truth about",
    "they don't want you",
    "they dont want you",
    "nobody is talking about",
    "no one is talking about",
    "this changes everything",
    "before it's deleted",
    "before its deleted",
    "watch before",
    "i was wrong",
    "i'm done",
    "we need to talk",
    "exposed",
    "destroys",
    "destroyed",
    "obliterates",
    "annihilates",
    "demolishes",
    "wrecks",
    "humiliates",
    "humiliated",
    "owns ",
    "owned ",
    "slams",
    "melts down",
    "meltdown",
    "loses it",
    "goes off",
    "rages",
    "rage quit",
    "caught ",
    "busted",
    "shocking",
    "insane",
    "unbelievable",
    "you need to see",
    "life changing",
    "life-changing",
    "worst ever",
    "best ever",
    "of all time",
    "ruined",
    "cancelled",
    "canceled",
    "drama",
    "beef",
    "responds to",
    "reacts to",
    "reaction",
    "cringe",
    "fails",
    "epic fail",
    "karen",
    "gets what",
    "instant regret",
    "instantly regrets",
];

/// Single words that, on their own, mark a title as emotional bait.
const BAIT_WORDS: &[&str] = &[
    "shocking",
    "insane",
    "crazy",
    "unbelievable",
    "exposed",
    "destroyed",
    "wrecked",
    "obliterated",
    "humiliated",
    "warning",
    "urgent",
    "emergency",
    "breaking",
    "leaked",
    "banned",
    "scandal",
    "outrage",
    "furious",
    "triggered",
    "woke",
    "disgusting",
    "horrifying",
    "terrifying",
];

/// Scores a feed title. `extra_keywords` are operator-supplied, already
/// lower-cased; each match counts like a built-in phrase.
pub fn score_title(title: &str, extra_keywords: &[String]) -> Verdict {
    let mut score = 0.0f32;
    let mut reasons = Vec::new();
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Verdict { score, reasons };
    }
    let lower = trimmed.to_lowercase();

    // SHOUTING: the share of letters that are upper case, on titles long
    // enough for it to mean something.
    let letters: Vec<char> = trimmed.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() >= 8 {
        let upper = letters.iter().filter(|c| c.is_uppercase()).count();
        let ratio = upper as f32 / letters.len() as f32;
        if ratio >= 0.7 {
            score += 0.4;
            reasons.push("mostly upper case");
        } else if ratio >= 0.45 {
            score += 0.2;
            reasons.push("heavy upper case");
        }
    }

    // Punctuation used as volume.
    let bangs = trimmed.matches('!').count();
    if bangs >= 3 {
        score += 0.3;
        reasons.push("three or more exclamation marks");
    } else if bangs >= 1 {
        score += 0.1;
        reasons.push("exclamation mark");
    }
    if trimmed.contains("?!") || trimmed.contains("!?") {
        score += 0.15;
        reasons.push("interrobang");
    }
    if trimmed.contains("...") || trimmed.contains('…') {
        score += 0.1;
        reasons.push("trailing suspense");
    }
    if trimmed.matches("(").count() >= 1 && (lower.contains("(not") || lower.contains("(real")) {
        score += 0.2;
        reasons.push("parenthetical protest");
    }

    // Emoji as decoration: two or more pictographs.
    let emoji = trimmed
        .chars()
        .filter(|c| {
            let u = *c as u32;
            (0x1F300..=0x1FAFF).contains(&u) || (0x2600..=0x27BF).contains(&u)
        })
        .count();
    if emoji >= 2 {
        score += 0.2;
        reasons.push("emoji pile");
    } else if emoji == 1 {
        score += 0.05;
    }

    // Vocabulary.
    let mut phrase_hits = 0;
    for p in BAIT_PHRASES {
        if lower.contains(p) {
            phrase_hits += 1;
            if phrase_hits <= 2 {
                reasons.push("bait phrase");
            }
        }
    }
    let words: Vec<&str> = lower
        .split(|c: char| !c.is_alphanumeric() && c != '\'')
        .filter(|w| !w.is_empty())
        .collect();
    let mut word_hits = 0;
    for w in BAIT_WORDS {
        if words.contains(w) {
            word_hits += 1;
        }
    }
    if word_hits > 0 {
        reasons.push("bait word");
    }
    let mut keyword_hits = 0;
    for k in extra_keywords {
        if !k.is_empty() && lower.contains(k.as_str()) {
            keyword_hits += 1;
        }
    }
    if keyword_hits > 0 {
        reasons.push("operator keyword");
    }
    score += (phrase_hits as f32 * 0.3).min(0.6);
    score += (word_hits as f32 * 0.25).min(0.5);
    // An operator's own keyword is a decision, not a hint.
    if keyword_hits > 0 {
        score += 1.0;
    }

    // "X vs Y", "Top 10 ...", "#1" style listicles: mild.
    if lower.starts_with("top ") && words.get(1).is_some_and(|w| w.chars().all(|c| c.is_ascii_digit()))
    {
        score += 0.1;
        reasons.push("listicle");
    }

    Verdict {
        score: score.min(1.0),
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(t: &str) -> f32 {
        score_title(t, &[]).score
    }

    #[test]
    fn plain_titles_score_low() {
        assert!(s("Building a bookshelf from scrap oak") < 0.2);
        assert!(s("Rust async in practice: streams and backpressure") < 0.2);
        assert!(s("Bach: Goldberg Variations, BWV 988 (Gould, 1981)") < 0.2);
        assert!(s("How do bicycles stay up?") < 0.2);
        assert_eq!(s(""), 0.0);
    }

    #[test]
    fn shouting_and_bait_phrases_score_high() {
        let v = score_title("YOU WON'T BELIEVE WHAT HAPPENED NEXT!!! 🤯🔥", &[]);
        assert!(v.score >= 0.9, "{v:?}");
        assert!(v.reasons.contains(&"mostly upper case"));
        assert!(v.reasons.contains(&"bait phrase"));
        assert!(v.reasons.contains(&"emoji pile"));
        assert!(s("Streamer DESTROYS critic in heated debate (gone wrong)") >= 0.6);
        assert!(s("Karen has a MELTDOWN at Starbucks and gets what she deserves") >= 0.6);
    }

    #[test]
    fn borderline_titles_stay_under_the_default_threshold() {
        assert!(s("I built a PC for $300!") < 0.6);
        assert!(s("NASA's new telescope images explained") < 0.6);
    }

    #[test]
    fn operator_keywords_are_decisive() {
        let kw = vec!["election".to_string()];
        assert!(score_title("Election night coverage, hour 3", &kw).score >= 1.0);
        assert!(score_title("Election night coverage, hour 3", &[]).score < 0.2);
    }

    #[test]
    fn score_is_clamped() {
        assert!(s("INSANE SHOCKING EXPOSED DESTROYED!!! YOU WON'T BELIEVE 🤯🤯🤯 (NOT CLICKBAIT)") <= 1.0);
    }
}
