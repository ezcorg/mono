//! Grant-scoped streaming — one mechanism every streaming capability shares.
//!
//! A capability (terminal / process / watch) validates its grant once, then returns a
//! long-lived byte stream. [`grant_scoped`] binds that stream to the grant's lifetime:
//!
//!  - it **ends** the stream the instant the grant is revoked or expires (via the
//!    grant's [`Revocation`] signal), so the client's stream closes; and
//!  - it drops `guard` whenever the stream is dropped — on revocation, client
//!    disconnect, or the session ending on its own. `guard`'s `Drop` is where the
//!    underlying resource is released (kill the child process, kill the PTY shell,
//!    stop the fs watcher).
//!
//! The filesystem capability isn't a single stream (the client re-uses descriptor
//! handles), so it enforces the same grant lifetime differently — re-validating per
//! operation in the passthrough component — but both read the *same* grant state.

use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll};

use bytes::Bytes;
use futures::stream::TakeUntil;
use futures::{Stream, StreamExt as _};

use crate::broker::Revocation;

type ByteStream = Pin<Box<dyn Stream<Item = Bytes> + Send>>;
type Until = Pin<Box<dyn Future<Output = ()> + Send>>;

/// Wrap `inner` so it ends on revoke/expiry and releases `guard` when dropped.
pub fn grant_scoped<G: Send + Unpin + 'static>(
    inner: ByteStream,
    revocation: Option<Revocation>,
    guard: G,
) -> ByteStream {
    let until: Until = match revocation {
        Some(rev) => Box::pin(rev.cancelled()),
        // The grant vanished between validation and here (a race with revoke): the
        // guard's Drop still releases the resource; nothing extra to wait on.
        None => Box::pin(core::future::pending()),
    };
    Box::pin(Guarded { stream: inner.take_until(until), _guard: guard })
}

/// The output stream plus a teardown `guard` dropped with it.
struct Guarded<G> {
    stream: TakeUntil<ByteStream, Until>,
    _guard: G,
}

impl<G: Send + Unpin> Stream for Guarded<G> {
    type Item = Bytes;
    fn poll_next(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Bytes>> {
        // All fields are `Unpin` (the stream + future are boxed, the guard is only
        // ever dropped), so we can project through a plain `&mut`.
        Pin::new(&mut self.get_mut().stream).poll_next(cx)
    }
}
