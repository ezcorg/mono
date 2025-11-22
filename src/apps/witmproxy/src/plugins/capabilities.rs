use anyhow::Result;
use cel_cxx::{Activation, Env, Program};
use salvo::oapi::ToSchema;
use serde::{Deserialize, Serialize};
use tracing::{debug, error};

use crate::plugins::cel::{CelConnect, CelRequest, CelResponse};

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Filterable {
    /// CEL filter expression, used to determine whether the capability applies
    pub filter: String,
    /// Compiled CEL program
    #[serde(skip)]
    pub cel: Option<Program<'static>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Capability<T> {
    pub config: T,
    pub granted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct Capabilities {
    pub connect: Capability<Filterable>,
    pub request: Option<Capability<Filterable>>,
    pub response: Option<Capability<Filterable>>,
}

impl Capabilities {
    pub fn compile_filters(&mut self, env: &Env<'static>) -> Result<()> {
        // Compile the CEL programs for each capability
        self.connect.config.cel = Some(env.compile(&self.connect.config.filter)?);

        if let Some(request) = &mut self.request {
            request.config.cel = Some(env.compile(&request.config.filter)?);
        }
        if let Some(response) = &mut self.response {
            response.config.cel = Some(env.compile(&response.config.filter)?);
        }
        Ok(())
    }

    pub fn can_handle_connect(&self, cel_connect: &CelConnect) -> bool {
        if let Some(program) = &self.connect.config.cel
            && let Ok(activation) = Activation::new().bind_variable("connect", cel_connect)
        {
            debug!("Evaluating CEL connect filter: {}", self.connect.config.filter);
            match program.evaluate(activation) {
                Ok(result) => {
                    if let cel_cxx::Value::Bool(b) = result {
                        debug!("CEL connect filter result: {}", b);
                        return b;
                    }
                }
                Err(e) => {
                    error!("Error evaluating CEL connect filter: {}", e);
                    return false;
                }
            }
        }
        false
    }

    pub fn can_handle_request(&self, cel_request: &CelRequest) -> bool {
        if let Some(request_cap) = &self.request
            && let Some(program) = &request_cap.config.cel
            && let Ok(activation) = Activation::new().bind_variable("request", cel_request)
        {
            match program.evaluate(activation) {
                Ok(result) => {
                    if let cel_cxx::Value::Bool(b) = result {
                        return b;
                    }
                }
                Err(e) => {
                    error!("Error evaluating CEL request filter: {}", e);
                    return false;
                }
            }
        }
        false
    }

    pub fn can_handle_response(
        &self,
        cel_request: &CelRequest,
        cel_response: &CelResponse,
    ) -> bool {
        if let Some(response_cap) = &self.response
            && let Some(program) = &response_cap.config.cel
            && let Ok(activation) = Activation::new()
                .bind_variable("request", cel_request)
                .and_then(|a| a.bind_variable("response", cel_response))
        {
            match program.evaluate(activation) {
                Ok(result) => {
                    if let cel_cxx::Value::Bool(b) = result {
                        return b;
                    }
                }
                Err(e) => {
                    error!("Error evaluating CEL response filter: {}", e);
                    return false;
                }
            }
        }
        false
    }
}

// TODO: DON'T GRANT EVERYTHING AUTOMATICALLY
impl From<crate::wasm::generated::Capabilities> for Capabilities {
    fn from(value: crate::wasm::generated::Capabilities) -> Self {
        Capabilities {
            connect: Capability {
                config: Filterable {
                    filter: value.connect.filter,
                    cel: None,
                },
                granted: true,
            },
            request: value.request.map(|req| Capability {
                config: Filterable {
                    filter: req.filter,
                    cel: None,
                },
                granted: true,
            }),
            response: value.response.map(|res| Capability {
                config: Filterable {
                    filter: res.filter,
                    cel: None,
                },
                granted: true,
            }),
        }
    }
}
