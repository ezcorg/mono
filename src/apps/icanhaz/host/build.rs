//! Generate the `ezco:ezcap` CEL environments for icanhaz's capability kinds
//! from `../wit` at build time and embed them as JSON (see
//! `ezcap::build::write_envs`). One environment per grant *kind* tag (`kind_tag`
//! in broker.rs): a grant is used through every interface its kind serves, so
//! `filesystem` is the union of the descriptor, watch and workspace
//! interfaces.

use std::path::PathBuf;

fn main() {
    let wit = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../wit");
    let out =
        PathBuf::from(std::env::var_os("OUT_DIR").unwrap_or_default()).join("ezcap-envs.json");
    ezcap::build::write_envs(
        &wit,
        &out,
        &[
            (
                "filesystem",
                &[
                    "wasi:filesystem/types@0.2.0.descriptor",
                    "icanhaz:nocap/watch",
                    "icanhaz:nocap/workspace",
                ],
            ),
            ("process", &["icanhaz:nocap/process"]),
            ("terminal", &["icanhaz:nocap/terminal"]),
            ("inference", &["icanhaz:nocap/inference"]),
        ],
    );
}
