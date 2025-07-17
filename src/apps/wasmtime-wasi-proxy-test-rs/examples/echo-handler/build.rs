fn main() {
    wit_bindgen::generate!({
        world: "proxy",
        path: "echo-handler.wit",
    });
}
