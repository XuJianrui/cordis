--------------------------- MODULE ctxfs ---------------------------
(**
 * Minimal, TLC-checkable model of the cordis ctx.fs watch contract.
 *
 * Scope: the three properties that a comment can get wrong and that a
 * finite enumeration cannot settle, because they are about *reachability
 * over traces*:
 *
 *   P1  no callback after the watch is disposed
 *   P2  a stale registration (file watch on a path that became a
 *       directory) is reachable
 *   P3  "exactly one delivery per write" is NOT a property of the
 *       implementation: it fails as soon as the event buffer is not
 *       cleared between registration and the first counted operation
 *
 * ClearMode is the single knob that distinguishes the two harnesses in
 * the A/B run. "cleared" resets the buffer after registration settles;
 * "uncleared" does not, so the registration-time write is still queued
 * when the first counted write lands.
 *)
EXTENDS Naturals

CONSTANTS
    MaxPending,        \* bound on the queue, keeps the state space finite
    MaxWrites,         \* bound on counted writes, so `writes` stays finite
    ClearMode          \* "cleared" | "uncleared"

VARIABLES
    alive,             \* is the watch registration still open
    watchShape,        \* shape frozen at registration time
    fsShape,           \* shape of the path on disk right now
    pending,           \* events queued at the driver, not yet delivered
    delivered,         \* callbacks fired so far
    deliveredAtDispose,\* snapshot of `delivered` when Dispose happened
    disposed,          \* has the fiber been disposed
    writes             \* writes performed since registration

vars == <<alive, watchShape, fsShape, pending, delivered,
          deliveredAtDispose, disposed, writes>>

TypeOK ==
    /\ alive \in BOOLEAN
    /\ watchShape \in {"file", "dir"}
    /\ fsShape \in {"file", "dir"}
    /\ pending \in 0..MaxPending
    /\ delivered \in 0..(MaxWrites + 1)
    /\ deliveredAtDispose \in 0..(MaxWrites + 1)
    /\ disposed \in BOOLEAN
    /\ writes \in 0..MaxWrites
    /\ ClearMode \in {"cleared", "uncleared"}

Init ==
    /\ alive = TRUE
    /\ watchShape = "file"
    /\ fsShape = "file"
    /\ pending = 0
    /\ delivered = 0
    /\ deliveredAtDispose = 0
    /\ disposed = FALSE
    /\ writes = 0

\* A write to the watched path. The driver enqueues one event.
\* In "uncleared" mode the registration-time event is still in the queue,
\* so this write is not the first event the queue has ever seen.
Write ==
    /\ alive
    /\ writes < MaxWrites
    /\ pending < MaxPending
    /\ pending' = pending + 1
    /\ writes' = writes + 1
    /\ UNCHANGED <<alive, watchShape, fsShape, delivered,
                   deliveredAtDispose, disposed>>

\* The driver hands one queued event to the consumer.
Deliver ==
    /\ alive
    /\ pending > 0
    /\ delivered' = delivered + 1
    /\ pending' = pending - 1
    /\ UNCHANGED <<alive, watchShape, fsShape, deliveredAtDispose,
                   disposed, writes>>

\* The consuming fiber is disposed: the registration closes.
Dispose ==
    /\ alive
    /\ alive' = FALSE
    /\ disposed' = TRUE
    /\ deliveredAtDispose' = delivered
    /\ UNCHANGED <<watchShape, fsShape, pending, delivered, writes>>

\* The path on disk changes shape. The registration shape is NOT updated -
\* this is the documented behaviour of `throwIfNoEntry: false`.
ShapeChange ==
    /\ fsShape' = IF fsShape = "file" THEN "dir" ELSE "file"
    /\ UNCHANGED <<alive, watchShape, pending, delivered,
                   deliveredAtDispose, disposed, writes>>

\* Registration-time event that survives because the buffer was never cleared.
\* Gated on `writes = 0` so it models exactly one thing: the event produced
\* by the write that happened before the watch was registered is still in the
\* queue when the first counted write lands.
RegistrationEvent ==
    /\ ClearMode = "uncleared"
    /\ alive
    /\ writes = 0
    /\ pending < MaxPending
    /\ pending' = pending + 1
    /\ UNCHANGED <<alive, watchShape, fsShape, delivered,
                   deliveredAtDispose, disposed, writes>>

Next == Write \/ Deliver \/ Dispose \/ ShapeChange \/ RegistrationEvent

Spec == Init /\ [][Next]_vars

\* ------------------------------------------------------------------
\* P1: no callback after dispose
\* ------------------------------------------------------------------
NoCallbackAfterDispose ==
    disposed => delivered = deliveredAtDispose

\* ------------------------------------------------------------------
\* P2: a stale registration is reachable
\* ------------------------------------------------------------------
NeverStale ==
    watchShape = fsShape

\* ------------------------------------------------------------------
\* P3: exactly one delivery per write
\* Counted per write: with the buffer cleared before the first counted
\* write, deliveries never exceed writes. Without clearing, the
\* registration event is still queued and the first write can produce
\* two deliveries.
\* ------------------------------------------------------------------
AtMostOnePerWrite ==
    delivered <= writes

\* A tighter statement used to show the cleared case is not vacuous:
\* once one write has happened and the queue is drained, deliveries
\* equal writes.
ExactWhenDrained ==
    (alive /\ writes > 0 /\ pending = 0) => delivered = writes

=============================================================================
