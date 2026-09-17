//! An icanhaz capability fixture: a session that upper-cases a byte stream.
//! Resource-shaped: the grant token is seen once, at `open`; `run` carries
//! streams each way and is an `async func`, since it awaits both ends.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "capability",
        generate_all,
    });
}

use bindings::exports::example::pipe::pipe::{Guest, GuestSession, Session};
use wit_bindgen::{StreamReader, StreamResult};

struct Component;

struct PipeSession {
    #[allow(dead_code)]
    grant: String,
}

impl Guest for Component {
    type Session = PipeSession;

    fn open(grant: String) -> Result<Session, String> {
        if grant.is_empty() {
            return Err("pipe: a grant is required".to_string());
        }
        Ok(Session::new(PipeSession { grant }))
    }
}

impl GuestSession for PipeSession {
    async fn run(&self, mut input: StreamReader<u8>) -> Result<StreamReader<u8>, String> {
        let (mut writer, reader) = bindings::wit_stream::new::<u8>();
        wit_bindgen::spawn(async move {
            loop {
                let (status, mut buf) = input.read(Vec::with_capacity(4096)).await;
                buf.make_ascii_uppercase();
                if !buf.is_empty() {
                    let rest = writer.write_all(buf).await;
                    if !rest.is_empty() {
                        break;
                    }
                }
                if matches!(status, StreamResult::Dropped) {
                    break;
                }
            }
            drop(writer);
        });
        Ok(reader)
    }
}

bindings::export!(Component with_types_in bindings);
