//! A filesystem **wrapper**: the reference for sitting in front of the
//! filesystem capability. It imports `wasi:filesystem/types` and
//! `icanhaz:fspass/mount` from the component behind it (the passthrough, or
//! another wrapper) and re-exports both, wrapping every descriptor in its
//! own so every operation passes through here first. This one refuses any
//! operation naming a path that contains `forbidden`; a wrapper can just as
//! well rewrite paths, log, or drop rights. Authorization is the
//! passthrough's job (it holds the consent gate); a wrapper only narrows.

mod raw {
    wit_bindgen::generate!({
        world: "fs-raw",
        path: "wit",
        generate_all,
        type_section_suffix: "raw",
    });
}

wit_bindgen::generate!({
    world: "fs-wrap",
    path: "wit",
    generate_all,
    with: {
        "wasi:filesystem/types@0.2.12/descriptor-type": crate::raw::wasi::filesystem::types::DescriptorType,
        "wasi:filesystem/types@0.2.12/descriptor-flags": crate::raw::wasi::filesystem::types::DescriptorFlags,
        "wasi:filesystem/types@0.2.12/path-flags": crate::raw::wasi::filesystem::types::PathFlags,
        "wasi:filesystem/types@0.2.12/open-flags": crate::raw::wasi::filesystem::types::OpenFlags,
        "wasi:filesystem/types@0.2.12/advice": crate::raw::wasi::filesystem::types::Advice,
        "wasi:filesystem/types@0.2.12/error-code": crate::raw::wasi::filesystem::types::ErrorCode,
        "wasi:filesystem/types@0.2.12/descriptor-stat": crate::raw::wasi::filesystem::types::DescriptorStat,
        "wasi:filesystem/types@0.2.12/new-timestamp": crate::raw::wasi::filesystem::types::NewTimestamp,
        "wasi:filesystem/types@0.2.12/metadata-hash-value": crate::raw::wasi::filesystem::types::MetadataHashValue,
        "wasi:filesystem/types@0.2.12/directory-entry": crate::raw::wasi::filesystem::types::DirectoryEntry,
        "wasi:io/streams@0.2.12": crate::raw::wasi::io::streams,
        "wasi:io/error@0.2.12": crate::raw::wasi::io::error,
        "wasi:io/poll@0.2.12": crate::raw::wasi::io::poll,
        "wasi:clocks/wall-clock@0.2.12": crate::raw::wasi::clocks::wall_clock,
    },
});

use exports::wasi::filesystem::types as ex_types;
// The raw host capability we delegate to (gen2's import side).
use wasi::filesystem::types as imp;
// The single shared home of the value types (== `imp`'s, via `with`).
use raw::wasi::filesystem::types as ty;
use raw::wasi::io::error::Error as IoError;
use raw::wasi::io::streams::{InputStream, OutputStream};

/// The wrapper's rule, applied before every operation: no path naming
/// `forbidden`. The grant is not re-checked here; the passthrough behind us
/// does that on the same call.
fn admit(_grant: &str, _method: &str, args: &[(&str, &str)]) -> Result<(), ty::ErrorCode> {
    if args.iter().any(|(_, v)| v.contains("forbidden")) {
        return Err(ty::ErrorCode::Access);
    }
    Ok(())
}

struct Component;

/// A descriptor plus the grant it was opened under. The grant is re-checked on every
/// operation and propagated to descriptors/streams derived from this one.
struct Desc {
    inner: imp::Descriptor,
    grant: String,
}

impl Desc {
    fn check(&self, method: &str, args: &[(&str, &str)]) -> Result<(), ty::ErrorCode> {
        admit(&self.grant, method, args)
    }
    /// Wrap a descriptor derived from this one (e.g. via `open-at`), inheriting the grant.
    fn derive(&self, inner: imp::Descriptor) -> ex_types::Descriptor {
        ex_types::Descriptor::new(Desc {
            inner,
            grant: self.grant.clone(),
        })
    }
}

/// A directory-entry stream, likewise scoped to the grant of the descriptor it came from.
struct DirStream {
    inner: imp::DirectoryEntryStream,
    grant: String,
}

impl ex_types::Guest for Component {
    type Descriptor = Desc;
    type DirectoryEntryStream = DirStream;

    fn filesystem_error_code(err: &IoError) -> Option<ty::ErrorCode> {
        imp::filesystem_error_code(err)
    }
}

impl ex_types::GuestDescriptor for Desc {
    fn read_via_stream(&self, offset: u64) -> Result<InputStream, ty::ErrorCode> {
        self.check("read-via-stream", &[])?;
        self.inner.read_via_stream(offset)
    }
    fn write_via_stream(&self, offset: u64) -> Result<OutputStream, ty::ErrorCode> {
        self.check("write-via-stream", &[])?;
        self.inner.write_via_stream(offset)
    }
    fn append_via_stream(&self) -> Result<OutputStream, ty::ErrorCode> {
        self.check("append-via-stream", &[])?;
        self.inner.append_via_stream()
    }
    fn advise(&self, offset: u64, length: u64, advice: ty::Advice) -> Result<(), ty::ErrorCode> {
        self.check("advise", &[])?;
        self.inner.advise(offset, length, advice)
    }
    fn sync_data(&self) -> Result<(), ty::ErrorCode> {
        self.check("sync-data", &[])?;
        self.inner.sync_data()
    }
    fn get_flags(&self) -> Result<ty::DescriptorFlags, ty::ErrorCode> {
        self.check("get-flags", &[])?;
        self.inner.get_flags()
    }
    fn get_type(&self) -> Result<ty::DescriptorType, ty::ErrorCode> {
        self.check("get-type", &[])?;
        self.inner.get_type()
    }
    fn set_size(&self, size: u64) -> Result<(), ty::ErrorCode> {
        self.check("set-size", &[])?;
        self.inner.set_size(size)
    }
    fn set_times(
        &self,
        atime: ty::NewTimestamp,
        mtime: ty::NewTimestamp,
    ) -> Result<(), ty::ErrorCode> {
        self.check("set-times", &[])?;
        self.inner.set_times(atime, mtime)
    }
    fn read(&self, length: u64, offset: u64) -> Result<(Vec<u8>, bool), ty::ErrorCode> {
        self.check("read", &[])?;
        self.inner.read(length, offset)
    }
    fn write(&self, buffer: Vec<u8>, offset: u64) -> Result<u64, ty::ErrorCode> {
        self.check("write", &[])?;
        self.inner.write(&buffer, offset)
    }
    fn read_directory(&self) -> Result<ex_types::DirectoryEntryStream, ty::ErrorCode> {
        self.check("read-directory", &[])?;
        self.inner.read_directory().map(|s| {
            ex_types::DirectoryEntryStream::new(DirStream {
                inner: s,
                grant: self.grant.clone(),
            })
        })
    }
    fn sync(&self) -> Result<(), ty::ErrorCode> {
        self.check("sync", &[])?;
        self.inner.sync()
    }
    fn create_directory_at(&self, path: String) -> Result<(), ty::ErrorCode> {
        self.check("create-directory-at", &[("path", &path)])?;
        self.inner.create_directory_at(&path)
    }
    fn stat(&self) -> Result<ty::DescriptorStat, ty::ErrorCode> {
        self.check("stat", &[])?;
        self.inner.stat()
    }
    fn stat_at(
        &self,
        path_flags: ty::PathFlags,
        path: String,
    ) -> Result<ty::DescriptorStat, ty::ErrorCode> {
        self.check("stat-at", &[("path", &path)])?;
        self.inner.stat_at(path_flags, &path)
    }
    fn set_times_at(
        &self,
        path_flags: ty::PathFlags,
        path: String,
        atime: ty::NewTimestamp,
        mtime: ty::NewTimestamp,
    ) -> Result<(), ty::ErrorCode> {
        self.check("set-times-at", &[("path", &path)])?;
        self.inner.set_times_at(path_flags, &path, atime, mtime)
    }
    fn link_at(
        &self,
        old_path_flags: ty::PathFlags,
        old_path: String,
        new_descriptor: ex_types::DescriptorBorrow<'_>,
        new_path: String,
    ) -> Result<(), ty::ErrorCode> {
        self.check(
            "link-at",
            &[("old-path", &old_path), ("new-path", &new_path)],
        )?;
        self.inner.link_at(
            old_path_flags,
            &old_path,
            &new_descriptor.get::<Desc>().inner,
            &new_path,
        )
    }
    fn open_at(
        &self,
        path_flags: ty::PathFlags,
        path: String,
        open_flags: ty::OpenFlags,
        flags: ty::DescriptorFlags,
    ) -> Result<ex_types::Descriptor, ty::ErrorCode> {
        self.check("open-at", &[("path", &path)])?;
        self.inner
            .open_at(path_flags, &path, open_flags, flags)
            .map(|d| self.derive(d))
    }
    fn readlink_at(&self, path: String) -> Result<String, ty::ErrorCode> {
        self.check("readlink-at", &[("path", &path)])?;
        self.inner.readlink_at(&path)
    }
    fn remove_directory_at(&self, path: String) -> Result<(), ty::ErrorCode> {
        self.check("remove-directory-at", &[("path", &path)])?;
        self.inner.remove_directory_at(&path)
    }
    fn rename_at(
        &self,
        old_path: String,
        new_descriptor: ex_types::DescriptorBorrow<'_>,
        new_path: String,
    ) -> Result<(), ty::ErrorCode> {
        self.check(
            "rename-at",
            &[("old-path", &old_path), ("new-path", &new_path)],
        )?;
        self.inner
            .rename_at(&old_path, &new_descriptor.get::<Desc>().inner, &new_path)
    }
    fn symlink_at(&self, old_path: String, new_path: String) -> Result<(), ty::ErrorCode> {
        self.check(
            "symlink-at",
            &[("old-path", &old_path), ("new-path", &new_path)],
        )?;
        self.inner.symlink_at(&old_path, &new_path)
    }
    fn unlink_file_at(&self, path: String) -> Result<(), ty::ErrorCode> {
        self.check("unlink-file-at", &[("path", &path)])?;
        self.inner.unlink_file_at(&path)
    }
    fn is_same_object(&self, other: ex_types::DescriptorBorrow<'_>) -> bool {
        // Pure identity comparison — no authority is exercised, so no re-check.
        self.inner.is_same_object(&other.get::<Desc>().inner)
    }
    fn metadata_hash(&self) -> Result<ty::MetadataHashValue, ty::ErrorCode> {
        self.check("metadata-hash", &[])?;
        self.inner.metadata_hash()
    }
    fn metadata_hash_at(
        &self,
        path_flags: ty::PathFlags,
        path: String,
    ) -> Result<ty::MetadataHashValue, ty::ErrorCode> {
        self.check("metadata-hash-at", &[("path", &path)])?;
        self.inner.metadata_hash_at(path_flags, &path)
    }
}

impl ex_types::GuestDirectoryEntryStream for DirStream {
    fn read_directory_entry(&self) -> Result<Option<ty::DirectoryEntry>, ty::ErrorCode> {
        admit(&self.grant, "read-directory-entry", &[])?;
        self.inner.read_directory_entry()
    }
}

impl exports::icanhaz::fspass::mount::Guest for Component {
    fn open_root(grant: String) -> Result<ex_types::Descriptor, String> {
        // The component behind us authorizes and scopes the root; we wrap it.
        let inner = icanhaz::fspass::mount::open_root(&grant)?;
        Ok(ex_types::Descriptor::new(Desc { inner, grant }))
    }
}

export!(Component);
