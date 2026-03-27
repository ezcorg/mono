use std::fmt;
use std::str::FromStr;

/// A build target triple. These are the platforms we build release binaries for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BuildTarget {
    X86_64UnknownLinuxGnu,
    X86_64AppleDarwin,
    Aarch64AppleDarwin,
}

impl BuildTarget {
    pub const ALL: &[BuildTarget] = &[
        BuildTarget::X86_64UnknownLinuxGnu,
        BuildTarget::X86_64AppleDarwin,
        BuildTarget::Aarch64AppleDarwin,
    ];

    pub fn triple(&self) -> &'static str {
        match self {
            Self::X86_64UnknownLinuxGnu => "x86_64-unknown-linux-gnu",
            Self::X86_64AppleDarwin => "x86_64-apple-darwin",
            Self::Aarch64AppleDarwin => "aarch64-apple-darwin",
        }
    }

    /// The artifact name for a given binary on this target.
    #[allow(dead_code)]
    pub fn artifact_name(&self, binary: &str) -> String {
        match self {
            Self::X86_64UnknownLinuxGnu => format!("{binary}-linux-x64"),
            Self::X86_64AppleDarwin => format!("{binary}-macos-x64"),
            Self::Aarch64AppleDarwin => format!("{binary}-macos-arm64"),
        }
    }

    /// The GitHub Actions runner OS for this target.
    #[allow(dead_code)]
    pub fn ci_runner(&self) -> &'static str {
        match self {
            Self::X86_64UnknownLinuxGnu => "ubuntu-latest",
            Self::X86_64AppleDarwin | Self::Aarch64AppleDarwin => "macos-latest",
        }
    }

    /// Detect the current host target.
    #[allow(dead_code)]
    pub fn current() -> Option<Self> {
        #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
        return Some(Self::X86_64UnknownLinuxGnu);
        #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
        return Some(Self::X86_64AppleDarwin);
        #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
        return Some(Self::Aarch64AppleDarwin);
        #[cfg(not(any(
            all(target_arch = "x86_64", target_os = "linux"),
            all(target_arch = "x86_64", target_os = "macos"),
            all(target_arch = "aarch64", target_os = "macos"),
        )))]
        return None;
    }
}

impl fmt::Display for BuildTarget {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.triple())
    }
}

impl FromStr for BuildTarget {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "x86_64-unknown-linux-gnu" => Ok(Self::X86_64UnknownLinuxGnu),
            "x86_64-apple-darwin" => Ok(Self::X86_64AppleDarwin),
            "aarch64-apple-darwin" => Ok(Self::Aarch64AppleDarwin),
            _ => Err(format!(
                "unknown target `{s}`. supported: {}",
                BuildTarget::ALL
                    .iter()
                    .map(|t| t.triple())
                    .collect::<Vec<_>>()
                    .join(", ")
            )),
        }
    }
}
