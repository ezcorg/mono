pub struct Selector {}
pub enum Capability {
    Request(Selector),
    Response(Selector),
    Directory,
    KeyValueStore,
    SQL,
}
