pub trait WasiPlugin: Send + Sync {
    fn name(&self) -> &str;
}
