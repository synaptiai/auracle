# Operator console design canvas

Source for the design canvas that settles the contents of issue #27.

Published: a private canvas page

Seven artboards. `Main.dc.html` is the runs list, and the six siblings are the
run detail, the approval queue, one conversation, one document, the control
bands and the partition latency. `canvas.json` places them on one canvas.

Each `.tpl` file is the authored source, and `css.txt` holds the shared design
tokens. Each `.dc.html` file is the two joined.

To change the canvas, edit a `.tpl` file or `css.txt`, then run the join:

```sh
python3 docs/design/console-canvas/join.py
```

It rewrites every `.dc.html` file and prints the size of each one. Seed the
canvas from those files. The join is deterministic, so a run that changes no
source leaves every file byte-identical.

The published page carries a copy of an editor, so the seeded output file is
large. It is not kept here.

Data on every artboard is synthetic (DEC-18). Ticket identifiers use the
`SYN-` prefix that the fixture generator uses, and no person is named.
