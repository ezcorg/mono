//! The shipped `process` capability. A `process` object is the capability
//! for one grant: `open` validates the token with the gate once, and `spawn`
//! runs under that grant through the daemon's raw layer, which pins the
//! program, admits the argv and binds the child to the grant's life.
//! Everything a wrapper might want to see or refuse passes through here.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "process-capability",
        path: "../../wit",
        generate_all,
    });
}

use bindings::exports::icanhaz::nocap::process::{Guest, GuestProcess, Process};
use bindings::icanhaz::nocap::{gate_process, process_raw};
use wit_bindgen::StreamReader;

struct Component;

struct Granted {
    grant: String,
}

impl Guest for Component {
    type Process = Granted;

    fn open(grant: String) -> Result<Process, String> {
        gate_process::validate(&grant)?;
        Ok(Process::new(Granted { grant }))
    }
}

impl GuestProcess for Granted {
    async fn spawn(
        &self,
        args: Vec<String>,
        stdin: StreamReader<u8>,
    ) -> Result<StreamReader<u8>, String> {
        process_raw::spawn(self.grant.clone(), args, stdin).await
    }
}

bindings::export!(Component with_types_in bindings);
