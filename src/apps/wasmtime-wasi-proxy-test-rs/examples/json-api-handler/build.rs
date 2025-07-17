fn main() {
    wit_bindgen::generate!({
        world: "proxy",
        path: "json-api-handler.wit",
    });
}
