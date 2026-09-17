//! A novel capability that builds on the filesystem. The daemon composes the
//! shipped filesystem capability in front of this component; `open` presents
//! the component grant, which the gate resolves to the filesystem grant
//! delegated to it, and the root descriptor that comes back is jailed and
//! scoped like any other. Exists to prove a component reaches files only
//! through a delegated grant, never through the host's preopens.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "capability",
        generate_all,
    });
}

use bindings::exports::example::reader::reader::{Guest, GuestReader, Reader as ReaderHandle};
use bindings::icanhaz::nocap::filesystem;
use bindings::wasi::filesystem::types::{Descriptor, DescriptorFlags, OpenFlags, PathFlags};

struct Component;

/// One open reader: the root descriptor the delegated grant yielded.
struct Reader {
    root: Descriptor,
}

impl Guest for Component {
    type Reader = Reader;

    fn open(grant: String) -> Result<ReaderHandle, String> {
        let root = filesystem::open(&grant)?;
        Ok(ReaderHandle::new(Reader { root }))
    }
}

impl GuestReader for Reader {
    fn read(&self, path: String) -> Result<String, String> {
        let file = self
            .root
            .open_at(
                PathFlags::empty(),
                &path,
                OpenFlags::empty(),
                DescriptorFlags::READ,
            )
            .map_err(|e| format!("open {path}: {e:?}"))?;
        let (bytes, _eof) = file
            .read(1 << 20, 0)
            .map_err(|e| format!("read {path}: {e:?}"))?;
        String::from_utf8(bytes).map_err(|e| format!("{path} is not UTF-8: {e}"))
    }
}

bindings::export!(Component with_types_in bindings);
