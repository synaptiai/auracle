# A blank host binds nothing

## Problem

The console binds `CONSOLE_HOST`, and loopback when the variable is absent. A
blank value is not absent. Node's `listen()` reads an empty host as every
interface. So `CONSOLE_HOST=` in a `.env` file opens the console to the whole
network.

With `CONSOLE_IDENTITY_HEADER` set, anyone who reaches the port can then send
that header. They can name any reviewer on the roster and approve customer
replies. The webhook has the same flaw, and it has no host setting at all.

## Proposed outcome

Both listeners read their interface through one helper. An absent variable
binds `127.0.0.1`. A blank value, or one with spaces around it, refuses the
start and names the variable. The webhook gains `WEBHOOK_HOST` with the same
default. The dev compose file sets `0.0.0.0` inside each container and
publishes the port on loopback only.

## Affected users and systems

An operator who sets a host variable. A blank value stops the process
instead of listening on every interface. A value that names an interface
behaves as before.

## Constraints

- DEC-45 rejects "pages open to anyone who reaches the port" and "an
  unverified header". It replaces DEC-42 for the approval from the console,
  and DEC-42 rejected "a header trusted on any bind".
- The webhook carries no identity, so no decision governs its bind. Its
  loopback default is an implementation detail.

## Decisions affected

Affects: DEC-45

DEC-45 says the console serves nothing to a request without a roster
identity, and a trusted proxy authenticates that identity. That holds only
when the proxy is the route to the port. A blank host gives the console every
interface, and a client there can send the identity header itself. This
change refuses a blank host, so the console listens only where the operator
names. Inside the dev compose network, the console's own network keeps the
other containers away from it.

## Open questions

None.
