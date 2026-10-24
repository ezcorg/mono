//! The shipped `inference` capability: a `session` object is the capability
//! for one grant; `complete` and `models` run under it through the raw
//! layer, which applies the grant's model list, clauses and budget. A
//! wrapper in front of this component sees every request and can refuse or
//! rewrite it; a provider authored as a component replaces it.

#[allow(warnings)]
mod bindings {
    wit_bindgen::generate!({
        world: "inference-capability",
        path: "../../wit",
        generate_all,
    });
}

use bindings::exports::icanhaz::nocap::inference::{
    CompletionRequest, Guest, GuestSession, ModelInfo, Session,
};
use bindings::icanhaz::nocap::inference as raw_types;
use bindings::icanhaz::nocap::{gate_inference, providers};
use wit_bindgen::StreamReader;

// wit-bindgen defines the value types once per side (export and import);
// they are the same records, converted field by field on the way through.
fn down(r: CompletionRequest) -> raw_types::CompletionRequest {
    raw_types::CompletionRequest {
        model: r.model,
        messages: r
            .messages
            .into_iter()
            .map(|m| raw_types::Message {
                role: m.role,
                content: m.content,
                tool_calls: m
                    .tool_calls
                    .into_iter()
                    .map(|t| raw_types::ToolCall {
                        id: t.id,
                        name: t.name,
                        arguments: t.arguments,
                    })
                    .collect(),
                tool_call_id: m.tool_call_id,
            })
            .collect(),
        tools: r
            .tools
            .into_iter()
            .map(|t| raw_types::Tool {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })
            .collect(),
        max_tokens: r.max_tokens,
        temperature: r.temperature,
        system: r.system,
    }
}

fn up(m: raw_types::ModelInfo) -> ModelInfo {
    ModelInfo {
        provider: m.provider,
        model: m.model,
    }
}

struct Component;

struct Granted {
    grant: String,
}

impl Guest for Component {
    type Session = Granted;

    fn open(grant: String) -> Result<Session, String> {
        gate_inference::validate(&grant)?;
        Ok(Session::new(Granted { grant }))
    }
}

impl GuestSession for Granted {
    async fn complete(&self, request: CompletionRequest) -> Result<StreamReader<u8>, String> {
        providers::complete(self.grant.clone(), down(request)).await
    }

    async fn models(&self) -> Result<Vec<ModelInfo>, String> {
        providers::models(self.grant.clone())
            .await
            .map(|list| list.into_iter().map(up).collect())
    }
}

bindings::export!(Component with_types_in bindings);
