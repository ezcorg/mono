//! `noshorts`: a witmproxy plugin that makes YouTube less compulsive.
//!
//! * Shorts are refused at the request level (pages and the playback API)
//!   and hidden from every page by injected CSS.
//! * The whole site is refused during working hours.
//! * Active viewing time is metered against a daily budget by a small agent
//!   the plugin injects into each page; once the budget is spent, the agent
//!   covers the page and further navigations get the block page.
//! * Feed items whose titles read as clickbait or ragebait are hidden.
//!
//! Everything that decides something lives in the plain modules below and
//! is unit-tested on the host; [`guest`] is the thin layer that speaks WIT.

pub mod config;
pub mod pages;
pub mod policy;
pub mod rewrite;
pub mod score;
pub mod time;

#[cfg(target_arch = "wasm32")]
mod guest;
