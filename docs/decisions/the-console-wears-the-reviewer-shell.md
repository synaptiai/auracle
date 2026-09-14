# The console wears the reviewer shell

## Problem

A design handoff specifies the console as a tool for a small team of
reviewers. It fixes final values for tokens, type, motion and the rail. The
console still carries the earlier canvas. Its rail is 188px, in two groups
named Work and Instrument. It has no space or motion scale, and no visible
focus ring.

The rail names no person. A queue that later says "you" and "held by Sam"
needs the rail to name who is working. Today the only name the console holds
is the approver a trusted proxy supplies on a write.

## Proposed outcome

Every surface sits in the handoff's shell. The rail is 194px, and its groups
are Work and Admin. The rail draws no group that has no surface. A label
shrinks and ellipsises, and its badge never wraps.

The stylesheet carries the handoff's space, radius, motion and depth tokens.
The content region rises in once, and no animated value stays after it ends.

A button or a boxed link presses on a spring. So does a link alone in a table
cell or a definition. A link inside a sentence underlines on hover, because a
transform does not act on an inline box. A focus ring is always visible, also
inside a control that clips its children.
A reader who asks for reduced motion gets no animation.

Every option of a segmented control stays reachable at 907px, because the
options wrap. A chip stays on one line. The ledger chip in the rail foot
wraps, so a long ledger name cannot widen the rail. Monospace text
draws in an installed monospace face, because the console fetches no font. The
chosen segment meets the contrast small text needs in both themes.

The foot of the rail names the reviewer a trusted proxy supplies. It names the
value the approval would record, or it says that no reviewer is named. A name
the proxy sent as UTF-8 reads as the name it sent.

Every log line the console writes stays one line. A value from a request can
carry a line break that JSON does not escape, so the log escapes it. The
approval log names the claimed approver and the approver the ledger records.

An approval whose run id has another shape is refused, and it never reaches
the ledger.

## Affected users and systems

A person who reads the console. The core's approval module, whose bound on a
claimed name moves to a pure module the console imports. The `domain` barrel,
which publishes that bound. The `format` barrel, which publishes the log line.

## Constraints

The console makes no request to another origin. The content-security policy
grants no font source, so the stylesheet imports nothing and names no remote
resource.

The console names no SQL, and its one write stays the approval.

The handoff gives depth tokens for the dark theme only. The light theme draws
the same ring and shadow in black, because a white hairline vanishes on a
white panel.

## Decisions affected

Affects: DEC-42

DEC-42 records the approver a trusted proxy names. It records `unattributed`
when that name is absent or unfit to keep. The rail now shows a name from the
same header. It reads the name through the approval's own bound. So the rail
never shows a name the ledger would store as `unattributed`.

The approval still applies the bound on every write. The bound names what a
name may hold: letters, marks, numbers, punctuation, symbols and single
spaces. So no control character, line separator, bidi control or invisible
character reaches the audit column. Each of them can make one recorded name
read as another line or another name.

A mark must follow a character other than a space, and no character carries
more than four stacking marks. A mark with no base draws a stray tick, and a
tall stack draws over the rail. A name the bound refuses records
`unattributed`, as an over-long name does, and the approval still goes ahead.

Some refusals are deliberate. No name holds a zero-width joiner, a non-joiner
or a variation selector. Whether one draws depends on the script and the font,
so none reaches the audit column. A Persian name with a non-joiner records
`unattributed`, and so does an Indic conjunct with a joiner. An emoji
sequence, a subdivision flag, a keycap and a Mongolian vowel separator do too.
When a reviewer roster ships, a roster identifier replaces the free-text name.

The rail says the proxy names the person, because DEC-42 records a claim and
not a login.

## Open questions

None.
