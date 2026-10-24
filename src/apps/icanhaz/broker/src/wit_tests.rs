//! The daemon's WIT deps are committed (`../wit/deps`), so nothing fetches at
//! build time; these keep the copies true to their sources. `ezco:ezcap` is
//! `wkg wit fetch`'s print of `src/rust/ezcap/wit` (wkg.toml's override), and
//! each fixture crate vendors the daemon's WIT and deps as `build-wasm.sh`
//! copies them. Either behind, the message says what to run.

use std::path::{Path, PathBuf};

use wit_component::WitPrinter;
use wit_parser::Resolve;

/// src/apps/icanhaz.
fn icanhaz() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// `package` as resolved under `dir`, printed the one way (wkg's, wasm-tools').
fn printed(dir: &Path, package: &str) -> String {
    let mut resolve = Resolve::default();
    resolve
        .push_dir(dir)
        .unwrap_or_else(|e| panic!("{}: {e:#}", dir.display()));
    let (id, _) = resolve
        .packages
        .iter()
        .find(|(_, p)| p.name.to_string() == package)
        .unwrap_or_else(|| panic!("no {package} under {}", dir.display()));
    let mut printer = WitPrinter::default();
    printer.print(&resolve, id, &[]).unwrap();
    printer.output.to_string()
}

#[test]
fn the_ezcap_copy_in_the_deps_is_its_source() {
    let root = icanhaz();
    let source = printed(&root.join("../../rust/ezcap/wit"), "ezco:ezcap@0.1.0");
    let copy = printed(&root.join("wit/deps/ezco-ezcap-0.1.0"), "ezco:ezcap@0.1.0");
    assert!(copy == source, "wit/deps/ezco-ezcap-0.1.0 is behind src/rust/ezcap/wit: run `wkg wit fetch` in src/apps/icanhaz");
}

/// The `.wit` files right under `dir`, in order.
fn wit_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "wit"))
        .collect();
    files.sort();
    files
}

/// The crate directories under `dir`.
fn crates_under(dir: &Path) -> impl Iterator<Item = PathBuf> {
    std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.join("Cargo.toml").is_file())
}

#[test]
fn the_fixtures_vendor_the_daemons_wit_as_it_is() {
    let root = icanhaz();
    let mut behind = Vec::new();
    let mut check = |source: &Path, copy: PathBuf| {
        if std::fs::read(&copy).ok() != std::fs::read(source).ok() {
            behind.push(
                copy.strip_prefix(&root)
                    .unwrap_or(&copy)
                    .display()
                    .to_string(),
            );
        }
    };
    for krate in
        crates_under(&root.join("host/fixtures")).chain(crates_under(&root.join("examples")))
    {
        let vendored = krate.join("wit/deps");
        if !vendored.join("icanhaz-nocap").is_dir() {
            continue;
        }
        // The daemon's own WIT, as `icanhaz-nocap`; its deps beside it, by name.
        for file in wit_files(&root.join("wit")) {
            check(
                &file,
                vendored
                    .join("icanhaz-nocap")
                    .join(file.file_name().unwrap()),
            );
        }
        for dep in std::fs::read_dir(root.join("wit/deps"))
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.is_dir())
        {
            for file in wit_files(&dep) {
                check(
                    &file,
                    vendored
                        .join(dep.file_name().unwrap())
                        .join(file.file_name().unwrap()),
                );
            }
        }
    }
    assert!(
        behind.is_empty(),
        "vendored WIT behind the daemon's (run src/apps/icanhaz/scripts/build-wasm.sh and commit):\n{}",
        behind.join("\n")
    );
}
