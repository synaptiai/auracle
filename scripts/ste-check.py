#!/usr/bin/env python3
"""Simplified Technical English checker for shipped markdown.

The convention in AGENTS.md has five rules. This script enforces the two that
a machine can decide:

  1. Maximum 20 words in a sentence.
  2. Maximum 6 sentences in a paragraph.

Rules 3 to 5 (active voice, present tense, one name for one meaning) need a
reader. No checker here claims to cover them. Do not read a pass as coverage
of those three.

Rule 2 applies to prose only. A numbered procedure and a table are not
paragraphs, and counting their entries as sentences would forbid a list of
seven steps. That exclusion is a decision, not an oversight.

Rule 1 measures a sentence, so it reads a unit and not a line. A unit is a
paragraph, a heading, a list item's first paragraph, a table cell or an HTML
block. Lines join inside a unit and never across one. An HTML block's text
is measured with its tag names, since a writer reads the source, and a blank
line inside it ends a unit as it ends a paragraph. Every document here
wraps its prose near 80 columns, so a sentence measured line by line is two
short fragments and the rule enforces nothing. Rule 2 reads a paragraph, a
heading and an HTML block, and not an item or a cell.

One parser decides the units, and it reads a document the way CommonMark
does. Each line first continues or closes the containers already open, a
block quote or a list item, and may open new ones. What is left is a leaf: a
paragraph line, a heading, a rule, a table row, an HTML block, a fence or
indented code. A unit ends where its leaf ends, and a container that opens
or closes ends it too. A second reader that matched the lines again once
split a paragraph where the first had read on, so there is one.

A line starts a block only where CommonMark lets it. An ordered item
interrupts a paragraph only when it counts from 1, so a year that opens a
wrapped line stays in its paragraph. A lazy line continues a paragraph, but
a heading, a rule, a fence or an HTML block is never one. A line that opens
with `|` on a line of its own is a table row, and it never joins the prose
beside it. A lazy line that happens to open with `|` is paragraph text. Rows
become a table once a delimiter row appears; before that, the line under a
row continues a paragraph, as it does for a reader.

Code drops out exactly where a markdown reader sees code, and nowhere else.
Markers are never paired across the whole file, because a marker inside a
sentence then pairs with a real one further down and hides everything
between them.

A fence opens on three or more backticks or tildes, indented at most three
columns inside its container. It closes on a run of the same character at
least as long, with nothing after it, or where its container ends. A
backtick fence whose info string holds a backtick is no fence. Four columns
of indent make indented code, unless the line continues a paragraph. Nothing
inside an HTML block is parsed, so a fence line there opens no fence.
A fence that never closes is not one: its lines stay prose, and its run
opens no code span. A reader sees code to the end of the page there, but a
fence left open is a slip, and the prose after it is what the writer meant a
reader to see.

A code span is inline, and it lives inside one unit. It opens on a run of
backticks and closes on the next run of exactly the same length. A backslash
outside a span escapes the character after it, and inside a span it is a
literal character. A span collapses to one word, because a path or an
identifier is one term to a reader. A span that wraps onto the next line of
its paragraph is still one. Raw HTML, an autolink and a link's destination
bind as tightly as a span, so a backtick inside one opens nothing. A comment's
text is measured, since a writer reads it, but a span in it closes inside it.

A design record's declaration drops out too. `Affects: DEC-06, DEC-07` names
the decisions a change cites, `check-docs.py` reads it, and a reader reads a
list rather than a sentence. The list grows with the change, and 20 decisions
is 21 words no rewriting can shorten. The exemption is the declaration shape
alone: `DEC-` identifiers, commas and nothing else. A line that opens with
`Affects:` and then runs into prose is prose, and it is measured.

A YAML front-matter block that opens a file drops out too, when every line in
it is a known metadata key. No file in the shipped set opens with one; the
rule serves a run that names a file, such as a design document.

Usage: python3 scripts/ste-check.py [FILE ...]
With no FILE, it checks the shipped set named by SHIPPED_GLOBS below.
That set is the one definition. `pnpm run check:ste` and the Guardrails
workflow both call this script with no arguments, so neither restates the
list and the two cannot drift apart.
Exits 1 when a file breaks a rule, and 0 when every file passes.
"""
import glob
import os
import re
import sys

MAX_WORDS = 20
MAX_SENTENCES = 6

# The markdown this repository ships to a reader. Internal notes under
# docs/internal/ are deliberately absent: a working document should not gate
# a pull request. CODE_OF_CONDUCT.md is absent too. It is the Contributor
# Covenant text unchanged, and a rewrite would make it another document.
SHIPPED_GLOBS = (
    "README.md",
    "AGENTS.md",
    "CONTRIBUTING.md",
    "REVIEW.md",
    "SECURITY.md",
    "CHANGELOG.md",
    "docs/*.md",
    # Each of these is one level deep, and `docs/*.md` does not recurse. A
    # glob that silently covers nothing reads exactly like a clean run, so
    # `check-docs.py` keeps both directories flat and the retired-glob report
    # below fails if either name stops matching.
    #
    # The archive is frozen, which means no file joins it — not that the
    # files already there stop being read. They passed this checker as
    # `intent/*.md` before they moved, and dropping them would have retired
    # the rule for 35 shipped documents without saying so.
    "docs/decisions/*.md",
    "intent/*.md",
    "intent/archive/*.md",
    "fixtures/README.md",
    "db/README.md",
)

# realpath, not abspath: through a symlink, abspath lands outside the
# repository and every glob returns nothing.
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))


def shipped_files() -> list[str]:
    """Expands SHIPPED_GLOBS against the repository, not the caller's cwd."""
    found: list[str] = []
    for pattern in SHIPPED_GLOBS:
        found.extend(sorted(glob.glob(os.path.join(REPO_ROOT, pattern))))
    return found


def empty_globs() -> list[str]:
    """The patterns that match nothing.

    Checking the total is not enough. A renamed directory retires its own
    pattern while the others still match, so the run reports a smaller clean
    number and nobody reads it as a loss. The shell form this replaced passed
    the unexpanded literal to the checker, which failed loudly on it.
    """
    return [
        pattern
        for pattern in SHIPPED_GLOBS
        if not glob.glob(os.path.join(REPO_ROOT, pattern))
    ]

WORD = re.compile(r"[A-Za-z0-9_-]+")
# The declaration a design record opens its "Decisions affected" section with,
# and the only line rule 1 does not measure. Strict on purpose: identifiers and
# commas alone, so a sentence cannot hide behind the prefix. `check-docs.py`
# refuses a second declaration line and reads the first physical one, so a
# wrapped list declares less than it looks like it declares.
DECLARATION = re.compile(r"^Affects:\s*(?:DEC-\d{2,})(?:\s*,\s*DEC-\d{2,})*\.?$")
CELL_SPLIT = re.compile(r"(?<!\\)\|")
SENTENCE_SPLIT = re.compile(r"(?<=[.!?])[*_'\")\]]*\s+")
# A full stop that ends a word rather than a sentence. `No.` is absent on
# purpose: this repository writes "No. It never retries", where `No` is the
# whole sentence. An abbreviation this list does not hold still ends a
# sentence here, and the count is then two short ones rather than one long.
ABBREVIATION = re.compile(
    r"(?:^|\s)(?:e\.g|i\.e|etc|vs|cf|approx|Fig|Dr|Mr|Ms|St|Inc|Ltd|Jr|Sr)\.$"
)


def sentences(text: str) -> list[str]:
    """Splits on a sentence boundary, and never inside an abbreviation."""
    parts = SENTENCE_SPLIT.split(text)
    joined: list[str] = []
    for part in parts:
        if joined and ABBREVIATION.search(joined[-1]):
            joined[-1] = f"{joined[-1]} {part}"
        else:
            joined.append(part)
    return joined


# The keys front matter holds in this repository. A line with any other shape
# makes the block prose, so a sentence cannot pass as metadata by sitting
# between two rules. Documents under docs/design/ use only these five.
FRONT_MATTER_KEYS = ("title", "author", "tags", "created_at", "updated_at")
FRONT_MATTER_LINE = re.compile(
    r"(?:" + "|".join(FRONT_MATTER_KEYS) + r")[ \t]*:(?:[ \t].*)?"
)
RULE_LINE = re.compile(r"---[ \t]*")


def strip_front_matter(text: str) -> str:
    """Drops a YAML block that opens the file and holds metadata keys alone.

    The block must close, and every line in it must be a known key. Otherwise
    nothing is dropped and the lines are read as prose, so a malformed block
    is a visible finding rather than a silent pass.
    """
    lines = text.split("\n")
    if not lines or not RULE_LINE.fullmatch(lines[0]):
        return text
    for index in range(1, len(lines)):
        if RULE_LINE.fullmatch(lines[index]):
            return "\n".join(lines[index + 1:])
        if not FRONT_MATTER_LINE.fullmatch(lines[index]):
            return text
    return text


# The block pass. CommonMark reads a document one line at a time: each line
# first continues or closes the containers already open (block quotes and
# list items), may open new ones, and what is left is a leaf. Code is two
# leaves, a fence and an indented block, and each ends where its container
# ends. So the pass tracks containers too, or a fence opened inside a quote
# would run past the quote and hide the prose after it.
#
# A container is ">" for a block quote, or the content indent of a list item.
# Tabs expand to four columns before any of this is read.
QUOTE_MARK = re.compile(r" {0,3}> ?")
ITEM_MARK = re.compile(r" {0,3}(?:[-*+]|\d{1,9}[.)])(?= |$)")
FENCE_RUN = re.compile(r" {0,3}(`{3,}|~{3,})(.*)$")
# An ATX heading: up to three spaces, one to six `#`, then a space or the end.
ATX = re.compile(r" {0,3}#{1,6}(?:[ \t]|$)")
# A thematic break: three or more of one of `-`, `*` or `_`, spaced or not.
THEMATIC = re.compile(r" {0,3}([-*_])(?: *\1){2,} *")
# The underline of a setext heading: `===` or `---` under paragraph text.
SETEXT = re.compile(r" {0,3}(?:=+|-+) *")
# The characters a backslash escapes, from the CommonMark list of ASCII
# punctuation. A backslash before anything else is a backslash.
ESCAPABLE = set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~")

Container = str | int


def indent_of(text: str) -> int:
    return len(text) - len(text.lstrip(" "))


def continues(line: str, containers: list[Container]) -> tuple[int, str] | None:
    """How many containers a line continues, and the text left after them.

    A quote needs its marker. An item needs the line blank, or indented to
    its content. A line that continues fewer than all of them closes the
    rest, unless it is a paragraph's lazy continuation, which the caller
    decides.
    """
    rest = line
    for depth, container in enumerate(containers):
        if isinstance(container, str):
            match = QUOTE_MARK.match(rest)
            if match is None:
                return depth, rest
            rest = rest[match.end():]
        elif rest.strip() == "":
            rest = ""
        elif indent_of(rest) >= container:
            rest = rest[container:]
        else:
            return depth, rest
    return len(containers), rest


def opens(rest: str, interrupting: bool = False) -> tuple[list[Container], str, list[str]]:
    """The containers a line's text opens, the leaf after them, and the markers.

    `interrupting` says the line would interrupt a paragraph. An item may do
    that only when it holds text, and an ordered one only when it counts from
    1, so `2. ` under a sentence is the sentence's next line.
    """
    opened: list[Container] = []
    markers: list[str] = []
    while True:
        match = QUOTE_MARK.match(rest)
        if match is not None:
            opened.append(">")
            rest = rest[match.end():]
            continue
        # A rule of dashes or stars is a leaf, never three nested items.
        if THEMATIC.fullmatch(rest):
            return opened, rest, markers
        match = ITEM_MARK.match(rest)
        if match is None:
            return opened, rest, markers
        after = rest[match.end():]
        marker = match.group(0).strip()
        if interrupting and not opened and (
                not after.strip()
                or (marker[0].isdigit() and int(marker[:-1]) != 1)):
            return opened, rest, markers
        gap = indent_of(after)
        # One to four spaces after the marker set the content indent. None,
        # or five and more, set it one column past the marker: the extra
        # spaces then belong to indented code inside the item.
        width = match.end() + (gap if 1 <= gap <= 4 and after.strip() else 1)
        opened.append(width)
        markers.append(marker)
        rest = rest[width:] if len(rest) >= width else ""


def fence_opened(leaf: str) -> tuple[str, int, int] | None:
    """The character, length and indent of the fence a leaf opens, or None."""
    match = FENCE_RUN.match(leaf)
    if match is None:
        return None
    run, info = match.group(1), match.group(2)
    # A backtick in the info string would make the line an inline code span,
    # so CommonMark reads no fence there.
    if run[0] == "`" and "`" in info:
        return None
    return run[0], len(run), indent_of(leaf)


def fence_closes(leaf: str, char: str, length: int) -> bool:
    """Whether a leaf closes a fence opened by `length` of `char`.

    Three spaces of indent at most, a run of the same character at least as
    long, and nothing after it.
    """
    if indent_of(leaf) > 3:
        return False
    body = leaf.lstrip(" ")
    run = len(body) - len(body.lstrip(char))
    return run >= length and body[run:].strip() == ""


def fence_end(lines: list[str], start: int, containers: list[Container],
              char: str, length: int) -> int | None:
    """The last line of a fence opened at `start`, or None when it never closes.

    A fence ends on its closer, or on the line before the first one that
    leaves its container: a reader sees code up to there. Only a fence that
    runs to the end of the file with neither is unclosed.
    """
    for index in range(start + 1, len(lines)):
        depth, leaf = continues(lines[index], containers)
        if depth < len(containers):
            return index - 1
        if fence_closes(leaf, char, length):
            return index
    return None


# HTML blocks, from CommonMark. The first five kinds end on their own closing
# marker. The last two end at a blank line, and the seventh, a lone tag,
# cannot interrupt a paragraph. Nothing inside one is parsed: a fence line in
# a `<div>` opens no fence.
HTML_ENDS_ON = (
    (re.compile(r" {0,3}<(?:script|pre|style|textarea)(?:[ \t>]|$)", re.I),
     re.compile(r"</(?:script|pre|style|textarea)>", re.I)),
    (re.compile(r" {0,3}<!--"), re.compile(r"-->")),
    (re.compile(r" {0,3}<\?"), re.compile(r"\?>")),
    (re.compile(r" {0,3}<![A-Za-z]"), re.compile(r">")),
    (re.compile(r" {0,3}<!\[CDATA\["), re.compile(r"\]\]>")),
)
HTML_BLOCK_TAG = re.compile(
    r" {0,3}</?(?:address|article|aside|base|basefont|blockquote|body|caption"
    r"|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption"
    r"|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe"
    r"|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p"
    r"|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr"
    r"|track|ul)(?:[ \t]|/?>|$)",
    re.I,
)
HTML_LONE_TAG = re.compile(
    r" {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*"
    r"(?:[ \t]*=[ \t]*(?:[^ \t\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*[ \t]*/?>"
    r"|</[A-Za-z][A-Za-z0-9-]*[ \t]*>)[ \t]*$"
)
# What an HTML block ends at when it has no closing marker.
AT_BLANK = re.compile(r"(?!)")


def html_opened(leaf: str, in_paragraph: bool) -> tuple[re.Pattern, int] | None:
    """What ends the HTML block a leaf opens, and where to look for it.

    The pattern that ends the block, or AT_BLANK for one that ends at a blank
    line or with its container, and the column the opening marker ends at,
    so `<!-- a -->` ends on its own line. None when the leaf opens no block.
    """
    for start, end in HTML_ENDS_ON:
        opened = start.match(leaf)
        if opened is not None:
            return end, opened.end()
    if HTML_BLOCK_TAG.match(leaf):
        return AT_BLANK, len(leaf)
    if not in_paragraph and HTML_LONE_TAG.match(leaf):
        return AT_BLANK, len(leaf)
    return None


# A delimiter row: cells of dashes, each with an optional colon at either
# end, parted by pipes. A line of dashes alone never reaches it: the setext
# and rule branches take one first. So `:-:` with no pipe is a delimiter row,
# as it is on GitHub.
DELIMITER_CELL = re.compile(r" *:?-+:? *")


def row_cells(row: str) -> list[str]:
    """A row's cells, split on unescaped pipes, with the outer pipes dropped."""
    row = row.strip()
    if row.startswith("|"):
        row = row[1:]
    if row.endswith("|") and not row.endswith("\\|"):
        row = row[:-1]
    return CELL_SPLIT.split(row)


def delimiter_shaped(leaf: str) -> bool:
    """Whether a leaf has a delimiter row's shape: a pipe, and cells of dashes
    with an optional colon at either end."""
    if indent_of(leaf) > 3:
        return False
    return all(DELIMITER_CELL.fullmatch(cell) for cell in row_cells(leaf))


def is_delimiter(leaf: str, header: str) -> bool:
    """Whether a leaf is a delimiter row for `header`, the line above it.

    As GitHub reads a table: the leaf has a delimiter row's shape, and the
    header has as many cells. A header of one pipe alone has none.

    One gap is known. A lazy header line keeps its leading spaces on GitHub,
    and spaces before a pipe count as an empty first cell there. The header
    here is the stripped line, so that cell is not counted.
    """
    if header.strip() == "|":
        return False
    return delimiter_shaped(leaf) and len(row_cells(header)) == len(row_cells(leaf))


# A footnote definition, which GitHub reads as a block of its own.
FOOTNOTE = re.compile(r" {0,3}\[\^[^\]]+\]:")


def starts_block(rest: str) -> bool:
    """Whether a line's text starts a block of its own, which ends a table.

    A table is not a paragraph, so a lone tag starts an HTML block here.
    """
    return (indent_of(rest) >= 4 or fence_opened(rest) is not None
            or ATX.match(rest) is not None or THEMATIC.fullmatch(rest) is not None
            or html_opened(rest, False) is not None or FOOTNOTE.match(rest) is not None)


def cells_of(row: str) -> list[str]:
    """The cells of a table row that carry a sentence.

    An escaped pipe is content, not a cell wall. Splitting on it broke one
    24-word cell into two short fragments and the cell shipped clean. The
    separator row under a table header carries no prose.
    """
    cells = [c.strip() for c in row_cells(row)]
    if all(set(c) <= set("-: ") for c in cells):
        return []
    return cells


# The kinds of unit, and the rules each one answers to. Rule 2 applies to
# prose only: a numbered procedure and a table are not paragraphs, and
# counting their entries as sentences would forbid a list of seven steps. So
# an item's first paragraph and a table cell answer to rule 1 alone.
RULE_2_KINDS = ("paragraph", "heading", "html")


def units_of(text: str) -> list[tuple[str, str]]:
    """The units a sentence may span, in order, each with its kind.

    One pass over the lines, as CommonMark reads them. Each line continues or
    closes the open containers, may open new ones, and what is left is a
    leaf: a paragraph line, a heading, a rule, a table row, an HTML block, a
    fence or indented code. Code drops out. A unit ends where its leaf ends,
    and a container that opens or closes ends it too, so a code span cannot
    reach from one unit into the next.
    """
    raw = text.split("\n")
    lines = [line.expandtabs(4) for line in raw]
    found: list[tuple[str, str]] = []
    buffer: list[str] = []
    kind = "paragraph"

    def flush() -> None:
        nonlocal buffer, kind, delimiter_failed
        if buffer:
            found.append((kind, " ".join(buffer)))
        buffer = []
        kind = "paragraph"
        delimiter_failed = False

    containers: list[Container] = []
    # Whether the line above, in these containers, was paragraph text. A
    # paragraph takes a lazy continuation line, and indented code cannot
    # interrupt one.
    in_paragraph = False
    # The markers of an item just opened. The item's first paragraph is its
    # unit, and it carries the markers the way the line does.
    pending: str | None = None
    empty_item: int | None = None
    # The containers a table was opened in, while it runs.
    table: list[Container] | None = None
    # Its header's cell count. A reader sees no cell past it in a body row.
    columns = 0
    # Whether a delimiter row failed to match its header in this paragraph.
    # GitHub opens no table later in a paragraph where one failed.
    delimiter_failed = False
    html_end: re.Pattern | None = None
    # An opener found unclosed rules out every later one of its character in
    # the same containers that is at least as long, since no closer follows
    # either.
    unclosed: dict[tuple[str, tuple[Container, ...]], int] = {}

    def end_leaf() -> None:
        """Ends the leaf open now, and everything that belonged to it.

        Every path that ends a leaf or a container comes through here. The
        paragraph ends, so no lazy line joins it, and an item's markers that
        no paragraph took are dropped, so they cannot label the next unit.
        """
        nonlocal pending, in_paragraph, table
        flush()
        pending = None
        in_paragraph = False
        table = None

    def add(leaf: str) -> None:
        nonlocal kind, pending, in_paragraph
        stripped = leaf.strip()
        # A declaration is a list, not a sentence, and no rewriting makes 21
        # decisions fit 20 words. It is dropped before the unit is measured,
        # so the prose beside it is still prose.
        if DECLARATION.match(stripped):
            return
        if not buffer and pending is not None:
            kind = "item"
            buffer.append(pending)
        pending = None
        buffer.append(stripped)
        in_paragraph = True

    index = 0
    while index < len(lines):
        depth, rest = continues(lines[index], containers)

        if html_end is not None:
            ended = depth < len(containers) or (html_end is AT_BLANK and not rest.strip())
            if not ended:
                if rest.strip():
                    buffer.append(rest.strip())
                else:
                    # A blank line inside the block ends its unit, as it
                    # ends a paragraph: two paragraphs of a comment are two.
                    flush()
                    kind = "html"
                if html_end.search(rest):
                    end_leaf()
                    html_end = None
                index += 1
                continue
            end_leaf()
            html_end = None

        if table is not None:
            # A table runs while its lines stay in its containers and start
            # no other block. Each line is a row, with or without a pipe.
            opened, leaf, _ = opens(rest)
            # A line of one pipe alone is no row, and GitHub ends the table.
            if (depth == len(containers) and rest.strip() not in ("", "|")
                    and not opened and not starts_block(rest)):
                found.extend(("cell", cell) for cell in cells_of(rest.strip())[:columns])
                index += 1
                continue
            end_leaf()

        if depth < len(containers):
            opened, leaf, _ = opens(rest)
            # A lazy line continues the paragraph above it without its
            # containers' markers. A line that starts a block of its own is
            # never lazy: a fence, a heading, a rule, an HTML block.
            lazy = (in_paragraph and not opened and rest.strip() != ""
                    and fence_opened(rest) is None
                    and not ATX.match(rest)
                    and not THEMATIC.fullmatch(rest)
                    and html_opened(rest, True) is None
                    and not FOOTNOTE.match(rest))
            if lazy:
                add(rest)
                index += 1
                continue
            containers = containers[:depth]
            end_leaf()
        # An item that opened empty holds no blank line first: a blank line
        # straight under it ends it.
        item_closed = False
        if empty_item is not None and rest.strip() == "" and depth == len(containers):
            containers = containers[:empty_item]
            item_closed = True
        empty_item = None
        # An item interrupts a paragraph only in the containers the line
        # continues. Past a container it closed, the paragraph is gone.
        opened, leaf, markers = opens(rest, in_paragraph and depth >= len(containers))
        if opened:
            # A quote opened inside a waiting item is still the item's first
            # block, so the markers wait on through it.
            waiting = pending if not markers else None
            end_leaf()
            pending = waiting
            containers = containers + opened
            if markers:
                pending = " ".join(markers)
                # Empty only when the item is the last thing the line opens:
                # `- >` holds a quote.
                if not leaf.strip() and isinstance(opened[-1], int):
                    empty_item = len(containers) - 1
        if leaf.strip() == "":
            # Blank inside its containers, such as a lone `>`: a paragraph
            # break, though the line is not empty.
            # A blank leaf, such as a lone `>` in an item that waits for its
            # first block, keeps the item's markers waiting. Only the empty
            # item this line closed takes them with it.
            waiting = None if item_closed else pending
            end_leaf()
            pending = waiting
            index += 1
            continue

        fence = fence_opened(leaf)
        if fence is not None:
            char, length, _ = fence
            key = (char, tuple(containers))
            end = None
            if length < unclosed.get(key, length + 1):
                end = fence_end(lines, index, containers, char, length)
            if end is not None:
                end_leaf()
                index = end + 1
                continue
            unclosed[key] = min(length, unclosed.get(key, length))
            # Unclosed. The line is prose, but its run opened a fence, so it
            # is no code span: kept, it would pair with a later run and hide
            # the prose between them.
            add(leaf.replace(char * length, "", 1))
            index += 1
            continue

        if indent_of(leaf) >= 4 and not in_paragraph:
            # Indented code runs while lines stay in its containers and are
            # blank or indented four columns.
            end_leaf()
            end = index
            while end + 1 < len(lines):
                depth, nxt = continues(lines[end + 1], containers)
                if depth < len(containers) or (nxt.strip() and indent_of(nxt) < 4):
                    break
                end += 1
            index = end + 1
            continue

        if ATX.match(leaf):
            # A heading is a unit of its own, wherever it sits.
            end_leaf()
            title = ATX.sub("", leaf, count=1).strip()
            if title:
                found.append(("heading", title))
            index += 1
            continue
        if in_paragraph and buffer and SETEXT.fullmatch(leaf):
            # A setext underline makes the paragraph above it a heading.
            kind = "heading"
            end_leaf()
            index += 1
            continue
        if THEMATIC.fullmatch(leaf):
            end_leaf()
            index += 1
            continue

        html = html_opened(leaf, in_paragraph)
        if html is not None:
            end_leaf()
            kind = "html"
            buffer.append(leaf.strip())
            end_at, start = html
            if end_at.search(leaf, start):
                end_leaf()
            else:
                html_end = end_at
            index += 1
            continue

        # An item's first paragraph opens with its markers, which no header
        # holds, so its header is the last line after them.
        text_lines = len(buffer) - (kind == "item")
        if (in_paragraph and text_lines > 0 and not delimiter_failed
                and is_delimiter(leaf, buffer[-1])):
            # A delimiter row under a line of the same number of cells makes
            # that line a table's header, and the lines above it stay what
            # they were. Until then a pipe line is paragraph text.
            header = buffer.pop()
            if text_lines == 1 and kind == "item":
                buffer.clear()
            end_leaf()
            found.extend(("cell", cell) for cell in cells_of(header))
            table = containers
            columns = len(row_cells(header))
            index += 1
            continue

        # A footnote definition interrupts a paragraph, and its text is a
        # unit of its own.
        if FOOTNOTE.match(leaf):
            end_leaf()
        # A delimiter row that opened nothing under a paragraph line rules
        # out a table later in that paragraph.
        if in_paragraph and delimiter_shaped(leaf):
            delimiter_failed = True
        add(leaf)
        index += 1
    flush()
    return found


# Raw HTML and autolinks, which CommonMark binds as tightly as a code span.
# Whichever starts first wins, so a backtick inside one opens no span.
INLINE_RAW = re.compile(
    r"<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>"  # an autolink
    r"|<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*>"
    r"|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*"
    r"(?:\s*=\s*(?:[^\s\"'=<>`]+|'[^']*'|\"[^\"]*\"))?)*\s*/?>"  # an open tag
    r"|</[A-Za-z][A-Za-z0-9-]*\s*>"  # a closing tag
    r"|<\?.*?\?>|<![A-Za-z][^>]*>|<!\[CDATA\[.*?\]\]>",  # the rest of raw HTML
    re.S,
)
# A link's destination and title, after the `]` that closes its text. A
# backtick there belongs to the link and opens no span.
LINK_TAIL = re.compile(
    r"\]\((?:<[^<>\n]*>|[^\s()<]*(?:\([^\s()]*\)[^\s()<]*)*)"
    r"(?:\s+(?:\"[^\"]*\"|'[^']*'|\([^()]*\)))?\s*\)"
)
# A comment is left out of INLINE_RAW on purpose. A page never shows one, but a writer
# reads it in the source: the design-record template opens with its
# instructions in one. So its text is measured as prose, spans and all.


def collapse_code(unit: str) -> str:
    """Collapses each code span in one unit to one word, as CommonMark reads it.

    A run of backticks opens a span and the next run of exactly its length
    closes it. A run with no such partner is literal text, and the scan goes
    on after it. A backslash escapes the punctuation after it, outside a span
    only: inside one, it is a literal character, so it cannot hide a closer.
    """
    out: list[str] = []
    index = 0
    size = len(unit)
    # Open `[` not yet closed. Only a `]` that closes one can end link text,
    # so only it can be followed by a destination.
    brackets = 0
    while index < size:
        char = unit[index]
        if char == "\\" and index + 1 < size and unit[index + 1] in ESCAPABLE:
            out.append(unit[index:index + 2])
            index += 2
            continue
        if unit.startswith("<!--", index):
            # Its text is measured, but a span in it closes inside it.
            close = unit.find("-->", index + 4)
            if close >= 0:
                out.append("<!--" + collapse_code(unit[index + 4:close]) + "-->")
                index = close + 3
                continue
        if char == "[":
            brackets += 1
        if char == "]" and brackets:
            brackets -= 1
            tail = LINK_TAIL.match(unit, index)
            if tail is not None:
                out.append(tail.group(0))
                index = tail.end()
                continue
        if char == "<":
            raw = INLINE_RAW.match(unit, index)
            if raw is not None:
                out.append(raw.group(0))
                index = raw.end()
                continue
        if char != "`":
            out.append(char)
            index += 1
            continue
        end = index
        while end < size and unit[end] == "`":
            end += 1
        length = end - index
        close = None
        scan = end
        while scan < size:
            if unit[scan] != "`":
                scan += 1
                continue
            run_end = scan
            while run_end < size and unit[run_end] == "`":
                run_end += 1
            if run_end - scan == length:
                close = scan
                break
            scan = run_end
        if close is None:
            out.append(unit[index:end])
            index = end
        else:
            out.append("x")
            index = close + length
    return "".join(out)


def read_text(path: str) -> tuple[str, list[str]]:
    """Returns (text, findings). A file this script cannot read is a finding.

    `scripts/check-docs.py` runs beside this one over the same file list. A
    document that is not UTF-8 was a finding there and a traceback here.
    """
    try:
        # `utf-8-sig`, so a byte-order mark is not read as text before the
        # front matter. Bytes that are not UTF-8 still raise.
        with open(path, encoding="utf-8-sig") as handle:
            return handle.read(), []
    except UnicodeDecodeError:
        return "", [f"{path}: not UTF-8"]
    except OSError as error:
        return "", [f"{path}: {error.strerror or error}"]


def check_file(path: str) -> list[str]:
    text, findings = read_text(path)
    if findings:
        return findings
    for kind, unit in units_of(strip_front_matter(text)):
        prose = collapse_code(unit)
        for sentence in sentences(prose):
            count = len(WORD.findall(sentence))
            if count > MAX_WORDS:
                findings.append(f"{path}: rule 1, {count} words: {sentence[:80]}")
        if kind not in RULE_2_KINDS:
            continue
        counted = [s for s in sentences(prose) if s.strip()]
        if len(counted) > MAX_SENTENCES:
            findings.append(
                f"{path}: rule 2, {len(counted)} sentences: {prose[:70]}"
            )
    return findings


def main() -> int:
    explicit = sys.argv[1:]
    if explicit:
        paths = explicit
    else:
        # A pattern that matches nothing would otherwise shrink the clean
        # count in silence, so a renamed directory would retire its part of
        # the check and the run would still pass. Every pattern must match.
        missing = empty_globs()
        if missing:
            print(
                "ste-check: these SHIPPED_GLOBS patterns match no file: "
                + ", ".join(missing)
                + ". A renamed or deleted path retires the check for it.",
                file=sys.stderr,
            )
            return 2
        paths = shipped_files()
    findings = []
    for path in paths:
        findings.extend(check_file(path))
    for finding in findings:
        print(finding)
    if findings:
        print(f"\n{len(findings)} finding(s)")
        return 1
    print(f"STE clean: {len(paths)} file(s), rules 1 and 2")
    return 0


if __name__ == "__main__":
    sys.exit(main())
