use crate::plugins::Event;

pub enum Capability {
    Directory,
    KeyValueStore,
    SQL,
    FeatureExtraction,
    Event(Event),
}
