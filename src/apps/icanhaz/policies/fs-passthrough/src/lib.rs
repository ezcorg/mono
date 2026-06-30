//! Filesystem passthrough — re-exports the host `wasi:filesystem` unchanged, so
//! the host can serve real `wasi:filesystem@0.2` over wRPC (descriptors + streams)
//! to a browser. The jail is the host's preopen; richer policy (audit / escalate /
//! copy-on-write) layers on later by replacing these forwarders with mediation.
//!
//! The one subtlety: importing *and* exporting `wasi:filesystem/types` would
//! normally generate two distinct Rust type universes. We avoid a conversion
//! layer by generating the value types **once** (the import-only `fs-raw` world,
//! `raw` module) and pointing the passthrough's `with:` at them — so imported and
//! exported value types are identical and every method is a one-line forward.
//! Only the `descriptor` / `directory-entry-stream` *resources* are wrapped
//! (unavoidable — the export resource is our own type).

mod raw {
    wit_bindgen::generate!({
        world: "fs-raw",
        path: "wit",
        generate_all,
        type_section_suffix: "raw",
    });
}

wit_bindgen::generate!({
    world: "fs-passthrough",
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

struct Component;
struct Desc(imp::Descriptor);
struct DirStream(imp::DirectoryEntryStream);

impl ex_types::Guest for Component {
    type Descriptor = Desc;
    type DirectoryEntryStream = DirStream;

    fn filesystem_error_code(err: &IoError) -> Option<ty::ErrorCode> {
        imp::filesystem_error_code(err)
    }
}

impl ex_types::GuestDescriptor for Desc {
    fn read_via_stream(&self, offset: u64) -> Result<InputStream, ty::ErrorCode> {
        self.0.read_via_stream(offset)
    }
    fn write_via_stream(&self, offset: u64) -> Result<OutputStream, ty::ErrorCode> {
        self.0.write_via_stream(offset)
    }
    fn append_via_stream(&self) -> Result<OutputStream, ty::ErrorCode> {
        self.0.append_via_stream()
    }
    fn advise(&self, offset: u64, length: u64, advice: ty::Advice) -> Result<(), ty::ErrorCode> {
        self.0.advise(offset, length, advice)
    }
    fn sync_data(&self) -> Result<(), ty::ErrorCode> {
        self.0.sync_data()
    }
    fn get_flags(&self) -> Result<ty::DescriptorFlags, ty::ErrorCode> {
        self.0.get_flags()
    }
    fn get_type(&self) -> Result<ty::DescriptorType, ty::ErrorCode> {
        self.0.get_type()
    }
    fn set_size(&self, size: u64) -> Result<(), ty::ErrorCode> {
        self.0.set_size(size)
    }
    fn set_times(&self, atime: ty::NewTimestamp, mtime: ty::NewTimestamp) -> Result<(), ty::ErrorCode> {
        self.0.set_times(atime, mtime)
    }
    fn read(&self, length: u64, offset: u64) -> Result<(Vec<u8>, bool), ty::ErrorCode> {
        self.0.read(length, offset)
    }
    fn write(&self, buffer: Vec<u8>, offset: u64) -> Result<u64, ty::ErrorCode> {
        self.0.write(&buffer, offset)
    }
    fn read_directory(&self) -> Result<ex_types::DirectoryEntryStream, ty::ErrorCode> {
        self.0.read_directory().map(|s| ex_types::DirectoryEntryStream::new(DirStream(s)))
    }
    fn sync(&self) -> Result<(), ty::ErrorCode> {
        self.0.sync()
    }
    fn create_directory_at(&self, path: String) -> Result<(), ty::ErrorCode> {
        self.0.create_directory_at(&path)
    }
    fn stat(&self) -> Result<ty::DescriptorStat, ty::ErrorCode> {
        self.0.stat()
    }
    fn stat_at(&self, path_flags: ty::PathFlags, path: String) -> Result<ty::DescriptorStat, ty::ErrorCode> {
        self.0.stat_at(path_flags, &path)
    }
    fn set_times_at(
        &self,
        path_flags: ty::PathFlags,
        path: String,
        atime: ty::NewTimestamp,
        mtime: ty::NewTimestamp,
    ) -> Result<(), ty::ErrorCode> {
        self.0.set_times_at(path_flags, &path, atime, mtime)
    }
    fn link_at(
        &self,
        old_path_flags: ty::PathFlags,
        old_path: String,
        new_descriptor: ex_types::DescriptorBorrow<'_>,
        new_path: String,
    ) -> Result<(), ty::ErrorCode> {
        self.0.link_at(old_path_flags, &old_path, &new_descriptor.get::<Desc>().0, &new_path)
    }
    fn open_at(
        &self,
        path_flags: ty::PathFlags,
        path: String,
        open_flags: ty::OpenFlags,
        flags: ty::DescriptorFlags,
    ) -> Result<ex_types::Descriptor, ty::ErrorCode> {
        self.0
            .open_at(path_flags, &path, open_flags, flags)
            .map(|d| ex_types::Descriptor::new(Desc(d)))
    }
    fn readlink_at(&self, path: String) -> Result<String, ty::ErrorCode> {
        self.0.readlink_at(&path)
    }
    fn remove_directory_at(&self, path: String) -> Result<(), ty::ErrorCode> {
        self.0.remove_directory_at(&path)
    }
    fn rename_at(
        &self,
        old_path: String,
        new_descriptor: ex_types::DescriptorBorrow<'_>,
        new_path: String,
    ) -> Result<(), ty::ErrorCode> {
        self.0.rename_at(&old_path, &new_descriptor.get::<Desc>().0, &new_path)
    }
    fn symlink_at(&self, old_path: String, new_path: String) -> Result<(), ty::ErrorCode> {
        self.0.symlink_at(&old_path, &new_path)
    }
    fn unlink_file_at(&self, path: String) -> Result<(), ty::ErrorCode> {
        self.0.unlink_file_at(&path)
    }
    fn is_same_object(&self, other: ex_types::DescriptorBorrow<'_>) -> bool {
        self.0.is_same_object(&other.get::<Desc>().0)
    }
    fn metadata_hash(&self) -> Result<ty::MetadataHashValue, ty::ErrorCode> {
        self.0.metadata_hash()
    }
    fn metadata_hash_at(
        &self,
        path_flags: ty::PathFlags,
        path: String,
    ) -> Result<ty::MetadataHashValue, ty::ErrorCode> {
        self.0.metadata_hash_at(path_flags, &path)
    }
}

impl ex_types::GuestDirectoryEntryStream for DirStream {
    fn read_directory_entry(&self) -> Result<Option<ty::DirectoryEntry>, ty::ErrorCode> {
        self.0.read_directory_entry()
    }
}

impl exports::icanhaz::fspass::mount::Guest for Component {
    fn open_root(grant: String) -> Result<ex_types::Descriptor, String> {
        // The consent gate: the host validates the bearer token AND returns the
        // granted root path (relative to the preopen). A bad/absent grant errors
        // here, so an ungated peer never gets a descriptor.
        let scope = icanhaz::fspass::gate::authorize(&grant)?;
        let dirs = wasi::filesystem::preopens::get_directories();
        let (root, _path) = dirs.into_iter().next().ok_or_else(|| "no preopened directory".to_string())?;
        let scope = scope.trim_matches('/');
        if scope.is_empty() {
            return Ok(ex_types::Descriptor::new(Desc(root)));
        }
        // Mediation: scope the capability to the grant's subtree by opening it as a
        // directory. wasi:filesystem sandboxes the returned descriptor — every
        // subsequent open-at is confined to this subtree (no `..` escape), so the
        // grant's path is enforced without per-method path checks.
        let sub = root
            .open_at(
                ty::PathFlags::empty(),
                scope,
                ty::OpenFlags::DIRECTORY,
                ty::DescriptorFlags::READ | ty::DescriptorFlags::MUTATE_DIRECTORY,
            )
            .map_err(|e| format!("granted scope {scope:?} unavailable: {e:?}"))?;
        Ok(ex_types::Descriptor::new(Desc(sub)))
    }
}

export!(Component);
