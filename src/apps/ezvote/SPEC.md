Rather than just prescribe particular technologies for the implementation at the outset, let's also envision the (initial) system with a set of qualities which seem desirable:

* It should be capable of complete self-modification (even if this leads to the system being broken)
* It should expose all state and valid system actions
* It should be transparent and auditable (any action is associated with a known entity, and any taken actions can be observed, verified, and replayed by anyone)
* It should be dynamic, and not rely on any static structure or assumed trust
* It should be versioned, such that we may "rollback" to previous system state (which can be thought of as forking)
* It should require consensus before performing actions (consensus mechanisms should be dynamic, but the initial priority is liquid democracy)
* It should be robust and efficient, such that it will still function under poor network conditions
* It should try to be an extremely simple abstraction, such that it is transparent, composable, and easy to verify
* It should be developed as an open protocol, and not assume any particular implementation (though we will work on the reference implementation)

In order to determine whether or not we have completed our implementation, we must also write tests which verify the above.