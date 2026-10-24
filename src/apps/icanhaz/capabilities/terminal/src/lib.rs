//! The shipped `terminal` capability: a `terminal` object is the capability
//! for one grant; `attach` opens the host's login shell in a PTY under that
//! grant through the raw layer, which admits the window and binds the
//! session to the grant's life.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "terminal-capability",
        path: "../../wit",
        generate_all,
    });
}

use bindings::exports::icanhaz::nocap::terminal::{Guest, GuestTerminal, Terminal};
use bindings::icanhaz::nocap::{gate_terminal, pty};
use wit_bindgen::StreamReader;

struct Component;

struct Granted {
    grant: String,
}

impl Guest for Component {
    type Terminal = Granted;

    fn open(grant: String) -> Result<Terminal, String> {
        gate_terminal::validate(&grant)?;
        Ok(Terminal::new(Granted { grant }))
    }
}

impl GuestTerminal for Granted {
    async fn attach(
        &self,
        stdin: StreamReader<u8>,
        control: StreamReader<u8>,
        cols: u16,
        rows: u16,
    ) -> Result<StreamReader<u8>, String> {
        pty::open(self.grant.clone(), stdin, control, cols, rows).await
    }
}

bindings::export!(Component with_types_in bindings);
