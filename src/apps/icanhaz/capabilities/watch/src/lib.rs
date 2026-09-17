//! The shipped `watch` capability: a `watcher` object is the capability for
//! one filesystem grant; `watch` streams change events for a path under its
//! jail through the raw layer, which confines and admits the path.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "watch-capability",
        path: "../../wit",
        generate_all,
    });
}

use bindings::exports::icanhaz::nocap::watch::{Guest, GuestWatcher, Watcher};
use bindings::icanhaz::nocap::{gate_filesystem, notify};
use wit_bindgen::StreamReader;

struct Component;

struct Granted {
    grant: String,
}

impl Guest for Component {
    type Watcher = Granted;

    fn open(grant: String) -> Result<Watcher, String> {
        gate_filesystem::validate(&grant)?;
        Ok(Watcher::new(Granted { grant }))
    }
}

impl GuestWatcher for Granted {
    async fn watch(&self, path: String, recursive: bool) -> Result<StreamReader<u8>, String> {
        notify::watch(self.grant.clone(), path, recursive).await
    }
}

bindings::export!(Component with_types_in bindings);
