//! An icanhaz capability. See AGENTS.md for the rules and the build.
//!
//! The oracle builds on a native capability: it answers a question by asking
//! the host's language model through `icanhaz:nocap/inference`, which it
//! imports. It calls the import with its own grant token; the daemon runs
//! the call under the inference grant the requester delegated to it. `ask`
//! is an `async func`: a synchronous export cannot block on an asynchronous
//! import.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "capability",
        generate_all,
    });
}

struct Component;

use bindings::exports::example::oracle::oracle::Guest as OracleGuest;
use bindings::icanhaz::nocap::inference;

impl OracleGuest for Component {
    async fn ask(grant: String, question: String) -> Result<String, String> {
        // The inference capability is an object acquired once with the token
        // the oracle itself was called with; the daemon runs it under the
        // inference grant the requester lent the oracle.
        let session = inference::open(&grant)?;
        let models = session.models().await?;
        let model = models
            .first()
            .map(|m| m.model.clone())
            .ok_or_else(|| "oracle: no model to ask".to_string())?;
        let request = inference::CompletionRequest {
            model,
            messages: vec![inference::Message {
                role: "user".to_string(),
                content: question,
                tool_calls: Vec::new(),
                tool_call_id: None,
            }],
            tools: Vec::new(),
            max_tokens: 0,
            temperature: None,
            system: None,
        };
        let reader = session.complete(request).await?;
        let bytes = reader.collect().await;
        // Frames: `[kind: u8][len: u32 BE][payload]`; 0 = text, 2 = error.
        let mut answer = String::new();
        let mut i = 0;
        while i + 5 <= bytes.len() {
            let kind = bytes[i];
            let len = u32::from_be_bytes([bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]])
                as usize;
            let payload = &bytes[i + 5..(i + 5 + len).min(bytes.len())];
            match kind {
                0 => answer.push_str(&String::from_utf8_lossy(payload)),
                2 => return Err(String::from_utf8_lossy(payload).into_owned()),
                _ => {}
            }
            i += 5 + len;
        }
        Ok(answer)
    }
}

bindings::export!(Component with_types_in bindings);
