//! The HTML the plugin serves and injects: the block page, the agent
//! document, and the fragments spliced into YouTube's own pages.

use crate::config::Settings;
use crate::policy::{AGENT_PREFIX, Reason};
use crate::time::{LocalTime, humanize_secs};

const BLOCKED_TEMPLATE: &str = include_str!("../assets/blocked.html");
const AGENT_TEMPLATE: &str = include_str!("../assets/agent.html");
const HIDE_CSS: &str = include_str!("../assets/hide.css");

/// The marker attribute on the injected iframe; tests and humans can find it.
pub const AGENT_FRAME_ID: &str = "witm-noshorts-agent";

pub fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

/// Facts the block page shows besides the reason.
pub struct PageFacts<'a> {
    pub now: &'a LocalTime,
    pub settings: &'a Settings,
    pub used_secs: u64,
    /// Rendered inside the agent iframe over a live page rather than as a
    /// top-level navigation: adds a script that keeps the parent quiet.
    pub embedded: bool,
}

/// Renders the block page for `reason`.
pub fn blocked_page(reason: &Reason, facts: &PageFacts<'_>) -> String {
    let s = facts.settings;
    let mut rows: Vec<(String, String)> = vec![("Local time".into(), facts.now.hhmm())];
    match reason {
        Reason::Shorts => {
            rows.push(("Shorts".into(), "blocked, always".into()));
        }
        Reason::WorkHours { until, .. } => {
            rows.push((
                "Working hours".into(),
                format!("{} to {until}", s.work_window.start_hhmm()),
            ));
        }
        Reason::Budget {
            used_secs,
            budget_secs,
            resets_in_secs,
        } => {
            rows.push(("Used today".into(), humanize_secs(*used_secs)));
            rows.push(("Daily budget".into(), humanize_secs(*budget_secs)));
            rows.push(("Resets in".into(), humanize_secs(*resets_in_secs)));
        }
    }
    if !matches!(reason, Reason::Budget { .. }) {
        rows.push((
            "Used today".into(),
            format!(
                "{} of {}",
                humanize_secs(facts.used_secs),
                humanize_secs(s.daily_budget_secs)
            ),
        ));
    }
    let rows_html: String = rows
        .iter()
        .map(|(k, v)| format!("<dt>{}</dt><dd>{}</dd>", escape_html(k), escape_html(v)))
        .collect();

    let suggestion = match reason {
        Reason::Shorts => {
            "If there was a specific video in there, it exists as a normal video too. Search for it."
        }
        Reason::WorkHours { .. } => {
            "Whatever you came here for will still be here this evening. Go back to what you were doing."
        }
        Reason::Budget { .. } => {
            "Half an hour of attention is a lot. Close the tab; tomorrow's budget is a fresh one."
        }
    };

    let embedded_script = if facts.embedded {
        r#"<script>
(() => {
  const P = window.parent; if (!P || P === window) return;
  let doc; try { doc = P.document; } catch (_) { return; }
  const quiet = () => { for (const v of doc.querySelectorAll('video')) { try { v.pause(); v.muted = true; } catch (_) {} } };
  quiet(); setInterval(quiet, 1000);
})();
</script>"#
    } else {
        ""
    };

    BLOCKED_TEMPLATE
        .replace("{{TITLE}}", &escape_html(reason.title()))
        .replace("{{EXPLANATION}}", &escape_html(&reason.explanation()))
        .replace("{{ROWS}}", &rows_html)
        .replace("{{SUGGESTION}}", suggestion)
        .replace("{{CODE}}", reason.code())
        .replace(
            "{{WHEN}}",
            &escape_html(&format!("{} {}", facts.now.date_string(), facts.now.hhmm())),
        )
        .replace("{{EMBEDDED_SCRIPT}}", embedded_script)
}

/// What the agent script needs to know, serialised into its document.
#[derive(serde::Serialize)]
struct AgentConfig<'a> {
    prefix: &'a str,
    #[serde(rename = "heartbeatMs")]
    heartbeat_ms: u64,
    #[serde(rename = "idleMs")]
    idle_ms: u64,
    #[serde(rename = "blockShorts")]
    block_shorts: bool,
    #[serde(rename = "filterEnabled")]
    filter_enabled: bool,
    #[serde(rename = "itemSelector")]
    item_selector: &'a str,
    #[serde(rename = "titleSelector")]
    title_selector: &'a str,
}

/// Feed item containers, desktop and mobile.
pub const ITEM_SELECTOR: &str = "ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, \
     ytd-compact-video-renderer, ytd-playlist-video-renderer, ytm-rich-item-renderer, \
     ytm-video-with-context-renderer, ytm-compact-video-renderer, [data-witm-item]";

/// Where the title lives inside an item, first match wins.
pub const TITLE_SELECTOR: &str = "#video-title, a#video-title-link, h3 a[title], .yt-lockup-metadata-view-model__title, \
     .media-item-headline, h3, h4, [data-witm-title]";

/// The agent document: loaded in a hidden same-origin iframe by every
/// managed page, so the script runs outside YouTube's Trusted Types policy
/// and survives its client-side navigation.
pub fn agent_page(settings: &Settings) -> String {
    let cfg = AgentConfig {
        prefix: AGENT_PREFIX,
        heartbeat_ms: settings.heartbeat_secs * 1000,
        idle_ms: settings.idle_secs * 1000,
        block_shorts: settings.block_shorts,
        filter_enabled: settings.filter_enabled,
        item_selector: ITEM_SELECTOR,
        title_selector: TITLE_SELECTOR,
    };
    let json = serde_json::to_string(&cfg).expect("agent config serialises");
    // `</script>` cannot occur in the selectors, but `<` in JSON inside a
    // script element is still escaped to be safe.
    AGENT_TEMPLATE.replace("{{CONFIG}}", &json.replace('<', "\\u003c"))
}

/// The markup appended to `<head>`.
pub fn head_injection(settings: &Settings) -> String {
    let mut out = String::new();
    if settings.hide_shorts_ui {
        out.push_str("<style id=\"witm-noshorts-css\">");
        out.push_str(HIDE_CSS);
        out.push_str("</style>");
    }
    out
}

/// The markup appended to `<body>`: the agent iframe, hidden until it has a
/// reason to be seen.
pub fn body_injection() -> String {
    format!(
        "<iframe id=\"{AGENT_FRAME_ID}\" src=\"{AGENT_PREFIX}agent\" title=\"noshorts\" \
         aria-hidden=\"true\" tabindex=\"-1\" \
         style=\"position:fixed;top:0;left:0;width:0;height:0;border:0;opacity:0;pointer-events:none;z-index:2147483647\"></iframe>"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts<'a>(now: &'a LocalTime, settings: &'a Settings) -> PageFacts<'a> {
        PageFacts {
            now,
            settings,
            used_secs: 600,
            embedded: false,
        }
    }

    #[test]
    fn block_page_names_the_reason_and_escapes() {
        let s = Settings::default();
        let now = LocalTime::new(0, 0);
        let html = blocked_page(
            &Reason::WorkHours {
                until: "17:00".into(),
                now: "10:00".into(),
            },
            &facts(&now, &s),
        );
        assert!(html.contains("Not during working hours"));
        assert!(html.contains("08:00 to 17:00"));
        assert!(html.contains("reason=work-hours"));
        assert!(html.contains("How to turn this off"));
        assert!(
            !html.contains("witm plugin"),
            "the page must not spell out the commands"
        );
        assert!(!html.contains("{{"), "unfilled placeholder");
        assert!(
            !html.contains("<script"),
            "top-level page carries no script"
        );

        let html = blocked_page(
            &Reason::Budget {
                used_secs: 1800,
                budget_secs: 1800,
                resets_in_secs: 90,
            },
            &PageFacts {
                embedded: true,
                ..facts(&now, &s)
            },
        );
        assert!(html.contains("<dd>30m</dd>"));
        assert!(html.contains("<dd>1m</dd>"));
        assert!(
            html.contains("<script"),
            "embedded page keeps the parent quiet"
        );
    }

    #[test]
    fn agent_page_embeds_its_config() {
        let s = Settings {
            heartbeat_secs: 7,
            ..Settings::default()
        };
        let html = agent_page(&s);
        assert!(html.contains("\"heartbeatMs\":7000"));
        assert!(html.contains("\"prefix\":\"/__witm/noshorts/\""));
        assert!(html.contains("\"blockShorts\":true"));
        assert!(!html.contains("{{CONFIG}}"));
    }

    #[test]
    fn injections_respect_settings() {
        let mut s = Settings::default();
        assert!(head_injection(&s).contains("ytd-reel-shelf-renderer"));
        s.hide_shorts_ui = false;
        assert!(head_injection(&s).is_empty());
        assert!(body_injection().contains(AGENT_FRAME_ID));
        assert!(body_injection().contains("/__witm/noshorts/agent"));
    }

    #[test]
    fn escaping() {
        assert_eq!(
            escape_html("<a href=\"x\">&'"),
            "&lt;a href=&quot;x&quot;&gt;&amp;&#39;"
        );
    }
}
