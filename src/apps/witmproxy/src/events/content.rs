use anyhow::Result;
use wasmtime::{Store, component::Resource};

use crate::{
    events::Event,
    plugins::cel::CelContent,
    wasm::{
        Host, InboundContent,
        bindgen::{
            EventData,
            witmproxy::plugin::capabilities::{CapabilityKind, EventKind},
        },
    },
};

impl Event for InboundContent {
    fn capability(&self) -> CapabilityKind {
        CapabilityKind::HandleEvent(EventKind::InboundContent)
    }

    fn into_event_data(self: Box<Self>, store: &mut Store<Host>) -> Result<EventData> {
        let handle: Resource<InboundContent> = store.data_mut().table.push(*self)?;
        Ok(EventData::InboundContent(handle))
    }

    fn register_cel_env<'a>(env: cel_cxx::EnvBuilder<'a>) -> Result<cel_cxx::EnvBuilder<'a>>
    where
        Self: Sized,
    {
        let env = env
            .declare_variable::<CelContent>("content")?
            .register_member_function("content_type", CelContent::content_type)?;
        Ok(env)
    }

    fn bind_cel_activation<'a>(
        &'a self,
        activation: cel_cxx::Activation<'a>,
    ) -> Option<cel_cxx::Activation<'a>> {
        activation
            .bind_variable("content", CelContent::from(self))
            .ok()
    }
}
