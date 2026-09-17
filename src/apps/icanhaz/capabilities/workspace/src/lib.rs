//! The shipped `workspace` capability: a `workspace` object is the capability
//! for one filesystem grant; `root-path` discloses the host path of its jail
//! through the raw layer.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "workspace-capability",
        path: "../../wit",
        generate_all,
    });
}

use bindings::exports::icanhaz::nocap::workspace::{Guest, GuestWorkspace, Workspace};
use bindings::icanhaz::nocap::{gate_filesystem, jail};

struct Component;

struct Granted {
    grant: String,
}

impl Guest for Component {
    type Workspace = Granted;

    fn open(grant: String) -> Result<Workspace, String> {
        gate_filesystem::validate(&grant)?;
        Ok(Workspace::new(Granted { grant }))
    }
}

impl GuestWorkspace for Granted {
    fn root_path(&self) -> Result<String, String> {
        jail::root(&self.grant)
    }
}

bindings::export!(Component with_types_in bindings);
