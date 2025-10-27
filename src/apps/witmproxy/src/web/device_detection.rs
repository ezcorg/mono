use crate::cert::generator::{Browser, DeviceInfo, Platform};

pub fn detect_device_from_user_agent(user_agent: &str) -> DeviceInfo {
    DeviceInfo::from_user_agent(user_agent)
}

pub fn get_platform_name(platform: &Platform) -> &'static str {
    match platform {
        Platform::IOs => "iOS",
        Platform::Android => "Android",
        Platform::Windows => "Windows",
        Platform::MacOS => "macOS",
        Platform::Linux => "Linux",
        Platform::Unknown => "Unknown",
    }
}

pub fn get_browser_name(browser: &Browser) -> &'static str {
    match browser {
        Browser::Safari => "Safari",
        Browser::Chrome => "Chrome",
        Browser::Firefox => "Firefox",
        Browser::Edge => "Edge",
        Browser::Unknown => "Unknown",
    }
}

pub fn is_mobile_device(platform: &Platform) -> bool {
    matches!(platform, Platform::IOs | Platform::Android)
}

pub fn supports_mobileconfig(platform: &Platform) -> bool {
    matches!(platform, Platform::IOs | Platform::MacOS)
}
