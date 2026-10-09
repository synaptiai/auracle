# Operator console design canvas

The design canvas for the operator console's first surfaces. It is a
proposal about what an operator sees, not a picture of what the console
draws today.

Seven artboards. `Main.dc.html` is the runs list. The six siblings show run
detail, the approval queue, a conversation, a document, control bands and
partition latency. `canvas.json` places them on one canvas, with
the brief and two notes beside them.

Each `.tpl` file is the authored source of one artboard, and holds one
`/*CSS*/` marker. `css.txt` holds the design tokens every artboard shares. Each
`.dc.html` file is its `.tpl` file, with `css.txt` in place of the marker.

To change the canvas, edit a `.tpl` file or `css.txt`, then run the join:

```sh
python3 docs/design/console-canvas/join.py
```

It writes the `.dc.html` file of each `.tpl` file and prints its size. A `.tpl`
file without exactly one marker gets no output. The join removes the old
`.dc.html` file of that artboard, so nobody reads a stale one. It also names a
`.dc.html` file that no `.tpl` file joins to. In either case it writes the
others, and exits non-zero at the end. The join is deterministic, so a run
that changes no source leaves every file byte-identical.

Each `.dc.html` file runs inside the canvas editor, which supplies the script
the file loads. The editor does not ship with this repository. A browser on
its own shows the static markup and its placeholders. Read the `.tpl` files
for the content of each artboard.

Data on every artboard is synthetic (DEC-18). Ticket identifiers use the
`SYN-` prefix that the fixture generator uses, and no person is named.
