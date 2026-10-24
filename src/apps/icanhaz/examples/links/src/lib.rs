//! Backlinks for a vault of markdown notes: a capability someone authored
//! for the editor, not one the daemon ships. It imports the filesystem
//! capability and opens the vault with the grant it was itself opened with:
//! the daemon resolves that to the filesystem grant the page lent it, so the
//! index sees the vault (or the subtree) the human approved, with the rights
//! they approved. Every query re-reads the notes, so the answer is never
//! stale and the component keeps no state a human could not see on disk.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "capability",
        generate_all,
    });
}

use bindings::exports::example::links::links::{Guest, GuestIndex, Index as IndexHandle, Link};
use bindings::icanhaz::nocap::filesystem;
use bindings::wasi::filesystem::types::{
    Descriptor, DescriptorFlags, DescriptorType, ErrorCode, OpenFlags, PathFlags,
};

struct Component;

/// One open index: the vault's root descriptor, for the delegated grant.
struct Index {
    root: Descriptor,
}

impl Guest for Component {
    type Index = Index;

    fn open(grant: String) -> Result<IndexHandle, String> {
        let root = filesystem::open(&grant)?;
        Ok(IndexHandle::new(Index { root }))
    }
}

impl GuestIndex for Index {
    fn backlinks(&self, note: String) -> Result<Vec<Link>, String> {
        let note = normalize(&note);
        Ok(self.scan()?.into_iter().filter(|l| l.target == note).collect())
    }

    fn unresolved(&self) -> Result<Vec<Link>, String> {
        let links = self.scan()?;
        Ok(links.into_iter().filter(|l| !self.exists(&l.target)).collect())
    }

    fn rename(&self, old_path: String, new_path: String) -> Result<u32, String> {
        let (old, new) = (normalize(&old_path), normalize(&new_path));
        if !self.exists(&old) {
            return Err(format!("{old}: no such note"));
        }
        if self.exists(&new) {
            return Err(format!("{new}: already exists"));
        }
        // Every note linking to `old` gets its links rewritten, relative to
        // itself, before the note moves.
        let mut rewritten = 0;
        let mut notes = Vec::new();
        self.walk("", &mut notes)?;
        for path in notes {
            let text = self.read(&path)?;
            let (updated, n) = rewrite(&path, &text, &old, &new);
            if n > 0 {
                self.write(&path, &updated)?;
                rewritten += n;
            }
        }
        self.root
            .rename_at(&old, &self.root, &new)
            .map_err(|e| format!("rename {old} to {new}: {}", describe(e)))?;
        Ok(rewritten)
    }
}

impl Index {
    /// Every link in every note under the root.
    fn scan(&self) -> Result<Vec<Link>, String> {
        let mut notes = Vec::new();
        self.walk("", &mut notes)?;
        let mut out = Vec::new();
        for path in notes {
            let text = self.read(&path)?;
            out.extend(links_in(&path, &text));
        }
        Ok(out)
    }

    /// The markdown notes under `dir`, as paths relative to the root.
    fn walk(&self, dir: &str, out: &mut Vec<String>) -> Result<(), String> {
        let handle = if dir.is_empty() {
            None
        } else {
            Some(
                self.root
                    .open_at(PathFlags::empty(), dir, OpenFlags::DIRECTORY, DescriptorFlags::READ)
                    .map_err(|e| format!("open {dir}: {}", describe(e)))?,
            )
        };
        let d = handle.as_ref().unwrap_or(&self.root);
        let entries = d
            .read_directory()
            .map_err(|e| format!("read {dir}: {}", describe(e)))?;
        while let Some(entry) = entries
            .read_directory_entry()
            .map_err(|e| format!("read {dir}: {}", describe(e)))?
        {
            if entry.name.starts_with('.') {
                continue;
            }
            let path = if dir.is_empty() { entry.name.clone() } else { format!("{dir}/{}", entry.name) };
            match entry.type_ {
                DescriptorType::Directory => self.walk(&path, out)?,
                DescriptorType::RegularFile if path.ends_with(".md") => out.push(path),
                _ => {}
            }
        }
        out.sort();
        Ok(())
    }

    fn exists(&self, path: &str) -> bool {
        self.root.stat_at(PathFlags::empty(), path).is_ok()
    }

    fn read(&self, path: &str) -> Result<String, String> {
        let file = self
            .root
            .open_at(PathFlags::empty(), path, OpenFlags::empty(), DescriptorFlags::READ)
            .map_err(|e| format!("open {path}: {}", describe(e)))?;
        let mut bytes = Vec::new();
        loop {
            let (chunk, eof) = file
                .read(1 << 16, bytes.len() as u64)
                .map_err(|e| format!("read {path}: {}", describe(e)))?;
            let done = eof || chunk.is_empty();
            bytes.extend_from_slice(&chunk);
            if done {
                break;
            }
        }
        String::from_utf8(bytes).map_err(|e| format!("{path} is not UTF-8: {e}"))
    }

    fn write(&self, path: &str, text: &str) -> Result<(), String> {
        let file = self
            .root
            .open_at(PathFlags::empty(), path, OpenFlags::TRUNCATE, DescriptorFlags::WRITE)
            .map_err(|e| format!("open {path} for writing: {}", describe(e)))?;
        let bytes = text.as_bytes();
        let mut offset = 0usize;
        while offset < bytes.len() {
            let n = file
                .write(&bytes[offset..], offset as u64)
                .map_err(|e| format!("write {path}: {}", describe(e)))? as usize;
            if n == 0 {
                return Err(format!("write {path}: no progress"));
            }
            offset += n;
        }
        Ok(())
    }
}

fn describe(e: ErrorCode) -> String {
    match e {
        ErrorCode::Access | ErrorCode::NotPermitted | ErrorCode::ReadOnly => {
            "not permitted by the grant".to_string()
        }
        ErrorCode::NoEntry => "no such file".to_string(),
        other => format!("{other:?}"),
    }
}

/// A note path relative to the vault root, cleaned: no leading `./` or `/`,
/// no `#fragment`, `.md` implied for a bare name.
fn normalize(path: &str) -> String {
    let path = path.split('#').next().unwrap_or("");
    let mut out = path.trim().trim_start_matches("./").trim_start_matches('/').to_string();
    if !out.is_empty() && !out.rsplit('/').next().unwrap_or("").contains('.') {
        out.push_str(".md");
    }
    out
}

/// Resolve `target` as written in `source`'s text to a vault-relative path.
fn resolve(source: &str, target: &str) -> String {
    let target = normalize(target);
    if target.is_empty() {
        return target;
    }
    let base = match source.rfind('/') {
        Some(i) => &source[..i],
        None => "",
    };
    let mut parts: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn is_external(target: &str) -> bool {
    target.starts_with('#')
        || target.contains("://")
        || target.starts_with("mailto:")
        || target.starts_with("tel:")
}

/// Every link in `text`: `[text](target)` to a relative path, and `[[name]]`.
fn links_in(source: &str, text: &str) -> Vec<Link> {
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let line_no = i as u32 + 1;
        let mut rest = line;
        while let Some(start) = rest.find("[[") {
            let after = &rest[start + 2..];
            let Some(end) = after.find("]]") else { break };
            let name = after[..end].split('|').next().unwrap_or("").trim();
            if !name.is_empty() {
                out.push(Link { source: source.to_string(), target: resolve(source, name), line: line_no });
            }
            rest = &after[end + 2..];
        }
        let mut rest = line;
        while let Some(start) = rest.find("](") {
            let after = &rest[start + 2..];
            let Some(end) = after.find(')') else { break };
            let target = after[..end]
                .split_whitespace()
                .next()
                .unwrap_or("")
                .trim_matches('<')
                .trim_matches('>');
            if !target.is_empty() && !is_external(target) {
                out.push(Link { source: source.to_string(), target: resolve(source, target), line: line_no });
            }
            rest = &after[end + 1..];
        }
    }
    out
}

/// `text` with every link from `note` to `old` retargeted at `new`, and how
/// many were changed. Targets are rewritten as written: a wikilink keeps its
/// bare form, a markdown link its relative form.
fn rewrite(note: &str, text: &str, old: &str, new: &str) -> (String, u32) {
    let mut count = 0;
    let mut out = String::with_capacity(text.len());
    for line in text.split_inclusive('\n') {
        let mut rest = line;
        loop {
            let (pos, is_wiki) = match (rest.find("[["), rest.find("](")) {
                (Some(w), Some(m)) if w <= m => (w, true),
                (Some(w), None) => (w, true),
                (_, Some(m)) => (m, false),
                (None, None) => break,
            };
            out.push_str(&rest[..pos + 2]);
            rest = &rest[pos + 2..];
            let close = if is_wiki { "]]" } else { ")" };
            let Some(end) = rest.find(close) else { break };
            let inner = &rest[..end];
            let (target, tail) = if is_wiki {
                match inner.find('|') {
                    Some(p) => (&inner[..p], &inner[p..]),
                    None => (inner, ""),
                }
            } else {
                match inner.find(char::is_whitespace) {
                    Some(p) => (&inner[..p], &inner[p..]),
                    None => (inner, ""),
                }
            };
            if !is_external(target) && resolve(note, target) == old {
                out.push_str(&relative(note, new, is_wiki));
                count += 1;
            } else {
                out.push_str(target);
            }
            out.push_str(tail);
            out.push_str(close);
            rest = &rest[end + close.len()..];
        }
        out.push_str(rest);
    }
    (out, count)
}

/// `target` as it should be written in `note`: a path relative to the note's
/// directory, and for a wikilink the bare name without `.md`.
fn relative(note: &str, target: &str, wiki: bool) -> String {
    let base: Vec<&str> = match note.rfind('/') {
        Some(i) => note[..i].split('/').filter(|p| !p.is_empty()).collect(),
        None => Vec::new(),
    };
    let tgt: Vec<&str> = target.split('/').filter(|p| !p.is_empty()).collect();
    let common = base.iter().zip(&tgt).take_while(|(a, b)| a == b).count();
    let mut parts: Vec<String> = vec!["..".to_string(); base.len() - common];
    parts.extend(tgt[common..].iter().map(|s| s.to_string()));
    let rel = parts.join("/");
    if wiki { rel.trim_end_matches(".md").to_string() } else { rel }
}

bindings::export!(Component with_types_in bindings);
