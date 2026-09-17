//! An icanhaz capability. See AGENTS.md for the rules and the build.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "capability",
        generate_all,
    });
}

struct Component;

use bindings::exports::example::greeter::greeter::Guest as GreeterGuest;
#[allow(unused_imports)]
use bindings::exports::example::greeter::greeter as upstream;

impl GreeterGuest for Component {
    fn greet(grant: String, name: String) -> Result<String, String> {
        // The daemon validated `grant` before this call; the component may
        // still refuse on its own terms.
        if name.is_empty() {
            return Err("greeter: who?".to_string());
        }
        Ok(format!("hello, {name} (grant {}…)", &grant[..grant.len().min(4)]))
    }
}

bindings::export!(Component with_types_in bindings);
