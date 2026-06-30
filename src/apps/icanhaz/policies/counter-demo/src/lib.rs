//! A tiny stateful resource component: `counter` with a constructor + two
//! methods. It exists only to prove the host can serve guest-exported resources
//! over wRPC — the same machinery (a shared `Store` + `SharedResourceTable`) the
//! real `wasi:filesystem` serving needs, exercised on a 3-method surface.

wit_bindgen::generate!({
    world: "counter-host",
    path: "wit",
});

use std::cell::Cell;

use exports::demo::res::counter::{Guest, GuestCounter};

struct Component;
struct Counter(Cell<u32>);

impl Guest for Component {
    type Counter = Counter;
}

impl GuestCounter for Counter {
    fn new(start: u32) -> Self {
        Counter(Cell::new(start))
    }

    fn increment(&self, by: u32) -> u32 {
        let v = self.0.get().wrapping_add(by);
        self.0.set(v);
        v
    }

    fn value(&self) -> u32 {
        self.0.get()
    }
}

export!(Component);
