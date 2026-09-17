#!/usr/bin/env python3
"""Documentation checker for claims a machine can decide.

A document drifts from the repository quietly. Nothing fails, and a reader
finds the gap instead of a build. These checks turn the drift-prone claims
into commands.

  diagrams      Every fence is tagged and closed, every subgraph closes, and
                every node id used in an edge is declared.
  legends       Every declared node has a legend row, so no box is unnamed.
  flow-edges    The parked reply reaches a person through the adapter, and
                never straight from the coordinator.
  configured-path
                The path back to the customer stays a broken line, because it
                needs a configuration choice.
  er-unenforced Each entity diagram says the database enforces no relationship.
  links         Every relative link in a shipped document resolves.
  design-index  The register's design table accounts for every open item it
                lists, and every file it names exists.
  decisions     Every design record cites a decision the register defines, and
                every archived record cites none.
  dec-range     Every document that states the register's range states the
                range the register actually defines.
  script-index  Every script `package.json` defines appears in the runbook as
                a command a reader can run, and the runbook names no script
                the manifest has dropped.
  script-claim  The runbook never claims the console ships no script, in any
                spelling, including one a line break splits.
  map-coverage  The quick map's list of decisions no row names is exactly the
                set no row names.

A Mermaid parser accepts an edge to an undeclared node. It mints a new
unlabelled box instead of joining the two the author meant, so the diagram
renders and says the wrong thing. That is why `diagrams` exists.

Every check fails closed. A condition this script cannot evaluate becomes a
finding, never a silent pass. A directory it cannot read, a file it cannot
decode, a fence that never closes and a run that scanned nothing all report.

These checks decide structure and reference. They do not decide whether a
diagram is true. Only a reader does that.

Usage: python3 scripts/check-docs.py [--root DIR] [--only CHECK[,CHECK...]]
An empty or blank `--only` runs every check. Repeats run once.
Exits 1 when a check finds something, 2 on a usage error, and 0 when every
check passes.
"""
from collections.abc import Iterator

import argparse
import json
import os
import re
import stat
import sys

MAP = "docs/architecture-map.md"
REGISTER = "docs/v1-architecture.md"
DESIGN_DIR = "docs/design"
DECISIONS_DIR = "docs/decisions"
ARCHIVE_DIR = "intent/archive"
MANIFEST = "package.json"
RUNBOOK = "docs/operations.md"
QUICK_MAP = "docs/quick-map.md"
# The documents that state the register's range. Each says it in prose a
# reader believes, and each went stale when DEC-43 arrived: two said DEC-42
# while the register defined 43 (issue #79).
RANGE_DOCS = ("README.md", "CONTRIBUTING.md", "AGENTS.md", "docs/quick-map.md")
DIAGRAM_COUNT = 3

# A shipped document is prose. Anything larger is not one, and reading it
# without a bound turns this gate into a way to exhaust a public runner.
MAX_BYTES = 2_000_000

# Node ids the flow diagram must use. They are fixed so the rules below can be
# decided without guessing which box is which.
COORDINATOR, ADAPTERS, PERSON = "SM", "ADAPT", "PERSON"

# The mail adapter reaches a customer only once an adopter configures it. The
# default adapter holds fixtures and opens no connection, so a solid line here
# tells a reader that mail leaves out of the box.
MAIL_ADAPTER, MAILBOX = "SMTP", "MAILBOX"
# Inside an extracted arrow a dot appears only in the dotted forms, and no
# dotted form omits it. So a dot decides the question.
DOTTED = re.compile(r"\.")

UNENFORCED = "declares no foreign key"

FENCE = re.compile(r"^```(\S*)")
# A node is declared by any of Mermaid's shape brackets, or by `subgraph ID`.
DECLARE = re.compile(r"(?:^|\s)([A-Za-z_]\w{0,63})\s*(?:\[\(|\[|\(\[|\(\(|\(|\{|>)")
SUBGRAPH = re.compile(r"^\s*subgraph\s+([A-Za-z_][\w]*)")
# An optional head, a run of link characters, an optional head. Bounded,
# because an unbounded run is quadratic on a long line that never matches.
ARROW = r"(?:[<ox])?[-=.~]{2,64}(?:[>ox])?"
EDGE = re.compile(r"([A-Za-z_]\w{0,63})\s*(" + ARROW + r")\s*([A-Za-z_]\w{0,63})")
ER_HEAD = re.compile(r"^\s*erDiagram\b")
ER_ENTITY = re.compile(r"^\s*([A-Za-z_][\w]*)\s*\{")
# `CONVERSATION ||..o{ TURN : "holds"`. The middle token is cardinality.
ER_REL = re.compile(
    r"^\s*([A-Za-z_][\w]*)\s+[|}o{][|}o{.\-]*[|}o{]\s+([A-Za-z_][\w]*)\s*:")
COMMENT = re.compile(r"^\s*%%")
STYLE = re.compile(r"^\s*(?:style|class|classDef|linkStyle)\b")
# Two ids joined by link characters. If this matches a line and the edge
# pattern found nothing, the form is one this checker does not read.
LINKISH = re.compile(r"[A-Za-z_]\w{0,63}\s*[<ox]?[-=.~]{2,64}[>ox]?")
# Bounded and line-anchored. The unbounded form was quadratic under
# `findall`, and a 300 KB document took 44 seconds.
LINK = re.compile(r"\[[^\]\n]{0,500}\]\(([^)\n]{0,500})\)")
TABLE_ROW = re.compile(r"^\s*\|\s*([^|]+?)\s*\|")
SECTION_71 = re.compile(r"^### 7\.1\b", re.M)
NEXT_HEADING = re.compile(r"^#{1,3} ", re.M)
# A legend may carry its own subheading, so only a new section ends one.
SECTION_HEADING = re.compile(r"^#{1,2} ")
OPEN_ITEM = re.compile(r"^(\d+)\.\s", re.M)


def read_text(path: str) -> tuple[str | None, str | None]:
    """Returns (text, error message). One of the two is always None.

    A traceback is not a finding. A file this script cannot decode, cannot
    open, or that is too large to be prose reports and the run continues.
    """
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            return None, "not a regular file"
        with open(path, encoding="utf-8") as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                return None, "not a regular file"
            text = handle.read(MAX_BYTES + 1)
        if len(text) > MAX_BYTES:
            return None, f"larger than {MAX_BYTES} bytes, so it is not prose"
        return text, None
    except UnicodeDecodeError:
        return None, "not UTF-8"
    except OSError as error:
        return None, error.strerror or str(error)


def read_repo_file(root: str, path: str, findings: list[str]) -> str | None:
    text, error = read_text(os.path.join(root, path))
    if error is not None:
        findings.append(f"{path}: {error}")
    return text


def blocks(text: str) -> tuple[list[tuple[str, list[str], int]], list[int]]:
    """Returns (fenced blocks, lines where a fence opened and never closed).

    A block is (tag, body lines, index of its closing line).
    """
    out, tag, body, opened = [], None, [], None
    for number, line in enumerate(text.splitlines()):
        fence = FENCE.match(line)
        if fence and tag is None:
            tag, body, opened = fence.group(1), [], number
        elif fence:
            out.append((tag, body, number))
            tag = None
        elif tag is not None:
            body.append(line)
    return out, ([] if tag is None else [opened])


def prose_text(text: str) -> str:
    """The document with every fenced block removed, by position.

    Removing a block by string replacement deletes every copy of it. A link
    shown inside a fence and then used in prose would lose the prose copy, and
    the checked document would be one the author never wrote.
    """
    kept, inside = [], False
    for line in text.splitlines():
        if FENCE.match(line):
            inside = not inside
            continue
        if not inside:
            kept.append(line)
    return "\n".join(kept)


def strip_labels_keeping_brackets(line: str) -> str:
    """Removes every label and keeps the shape brackets around a node.

    A label is prose, and prose holds a word before a bracket. `park a draft
    (DEC-11)` reads exactly like a node declaration. An unquoted pipe label
    does the same, so both forms go.
    """
    return re.sub(r"\|[^|]*\|", " ", strip_quoted(line))


def strip_quoted(line: str) -> str:
    """Removes the quoted text of a label and keeps the brackets around it.

    A label is prose, and prose holds a word before a bracket. `park a draft
    (DEC-11)` reads exactly like a node declaration, so a label left in place
    mints a box called `draft` that nobody drew.
    """
    return re.sub(r'"[^"]*"', "", line)


# `A -- text --> B` and `A -. text .-> B`. The text carries no link
# character, so the two runs around it collapse into one arrow. A chain
# `A --> B --> C` does not match, because a `>` cannot start the text.
EDGE_TEXT = re.compile(r"([-=.~]{2,64})[^-=.~<>|\n]+?([-=.~]{2,64}[>ox]?)")

SHAPES = (re.compile(r"\[[^\[\]]*\]"),
          re.compile(r"\([^()]*\)"),
          re.compile(r"\{[^{}]*\}"),
          re.compile(r">[^<>]*<"))


def strip_labels(line: str) -> str:
    """Reduces a line to its node ids and the links between them.

    The label goes away completely. Leaving a pipe behind puts a character
    between an arrow and its target, and then the target matches nothing.

    The shape brackets go too. Mermaid lets one line declare a node and join
    it, as `A["Alpha"] --> B`, and the brackets sat between the source and the
    arrow. The pattern then matched nothing and `B` was never compared against
    anything. Nested shapes such as `([...])` need more than one pass, so this
    strips until the line stops changing.
    """
    line = re.sub(r'"[^"]*"', " ", line)
    line = re.sub(r"\|[^|]*\|", " ", line)
    line = EDGE_TEXT.sub(r"\1\2", line)
    for _ in range(8):
        before = line
        for shape in SHAPES:
            line = shape.sub(" ", line)
        if line == before:
            break
    return line


def scan_edges(bare: str) -> list[tuple[str, str, str]]:
    """Returns each (source, arrow, target) triple on one stripped line.

    A chain such as `A --> B -.-> C` holds two edges, and the second starts
    inside the first. So the scan restarts at each target. The arrow travels
    with the pair, because a rule about one edge must not read the whole line.
    """
    out, start = [], 0
    while True:
        match = EDGE.search(bare, start)
        if not match:
            return out
        out.append((match.group(1), match.group(2), match.group(3)))
        start = match.start(3)


def is_entity_diagram(body: list[str]) -> bool:
    return any(ER_HEAD.match(line) for line in body)


def entity_nodes(body: list[str]) -> tuple[set[str], set[str]]:
    """Returns (declared entities, entities used in a relationship)."""
    declared, used = set(), set()
    for line in body:
        entity = ER_ENTITY.match(line)
        if entity and not ER_HEAD.match(line):
            declared.add(entity.group(1))
        relation = ER_REL.match(line)
        if relation:
            used.add(relation.group(1))
            used.add(relation.group(2))
    return declared, used


def diagram_nodes(body: list[str]) -> tuple[set[str], set[str]]:
    """Returns (declared ids, ids used in an edge)."""
    if is_entity_diagram(body):
        return entity_nodes(body)
    declared, used = set(), set()
    for line in body:
        bare = strip_labels(line)
        if COMMENT.match(line):
            continue
        sub = SUBGRAPH.match(line)
        if sub:
            declared.add(sub.group(1))
            continue
        if STYLE.match(line):
            continue
        for match in DECLARE.finditer(strip_labels_keeping_brackets(line)):
            declared.add(match.group(1))
        found = scan_edges(bare)
        for source, _, target in found:
            used.add(source)
            used.add(target)
        if not found and LINKISH.search(bare):
            used.add(f"?unreadable link on: {bare.strip()[:60]}")
    return declared, used


def edges(body: list[str]) -> list[tuple[str, str]]:
    """Returns each (source, target) pair the diagram draws."""
    out = []
    for line in body:
        if STYLE.match(line) or COMMENT.match(line):
            continue
        out.extend((source, target)
                   for source, _, target in scan_edges(strip_labels(line)))
    return out


def legend_after(text: str, closing_line: int) -> str:
    """Returns the text between one fence and the next, which holds its legend."""
    lines = text.splitlines()
    tail = lines[closing_line + 1:]
    for number, line in enumerate(tail):
        # The next fence or the next heading, whichever comes first. Running
        # to the end of the file would let a sentence anywhere below satisfy
        # a rule about this diagram.
        if FENCE.match(line) or SECTION_HEADING.match(line):
            return "\n".join(tail[:number])
    return "\n".join(tail)


def legend_names(legend: str) -> set[str]:
    named = set()
    for line in legend.splitlines():
        row = TABLE_ROW.match(line)
        if row:
            named.add(row.group(1).strip("` "))
    return named


def read_map(
        root: str, findings: list[str]
) -> tuple[str | None, list[tuple[str, list[str], int]] | None]:
    """Returns (text, every fence) for the map, or (None, None).

    One reader, so the dangling-fence report has one home. Two copies of it
    meant one had no case and could be deleted while the suite stayed green.
    """
    text = read_repo_file(root, MAP, findings)
    if text is None:
        return None, None
    found, dangling = blocks(text)
    for line in dangling:
        findings.append(f"{MAP}: a fence opened at line {line + 1} and never closes")
    return text, found


def diagrams_only(
        found: list[tuple[str, list[str], int]]
) -> list[tuple[str, list[str], int]]:
    """The mermaid-tagged blocks, numbered from one.

    Every check numbers from this one list. Numbering from all fences instead
    would make two checks report different diagrams under the same number.
    """
    return [b for b in found if b[0] == "mermaid"]


def map_blocks(
        root: str, findings: list[str]
) -> tuple[str | None, list[tuple[str, list[str], int]] | None]:
    """Returns (text, mermaid blocks) for the map, or (None, None)."""
    text, found = read_map(root, findings)
    if found is None:
        return None, None
    return text, diagrams_only(found)


def flow_diagram(
        mermaid: list[tuple[str, list[str], int]]
) -> tuple[int | None, list[str] | None, int | None]:
    """The first diagram that is not an entity diagram and declares the coordinator.

    Selecting by position would send a reader debugging a reordered document
    to the wrong cause.
    """
    for index, (_, body, closing) in enumerate(mermaid, 1):
        if is_entity_diagram(body):
            continue
        declared, _ = diagram_nodes(body)
        if COORDINATOR in declared:
            return index, body, closing
    return None, None, None


def check_diagrams(root: str, findings: list[str]) -> None:
    _, found = read_map(root, findings)
    if found is None:
        return
    tagged = diagrams_only(found)
    for tag, _, closing in found:
        if tag != "mermaid":
            findings.append(
                f"{MAP}: a fence closing at line {closing + 1} is tagged "
                f"'{tag}', not mermaid. This file holds diagrams only")
    if len(tagged) != DIAGRAM_COUNT:
        findings.append(
            f"{MAP}: wants {DIAGRAM_COUNT} diagrams, found {len(tagged)}")
    for index, (_, body, _) in enumerate(tagged, 1):
        opens = sum(1 for line in body if SUBGRAPH.match(line))
        closes = sum(1 for line in body if line.strip() == "end")
        if opens != closes:
            findings.append(
                f"{MAP}: diagram {index} has {opens} subgraph(s) and {closes} end(s)")
        declared, used = diagram_nodes(body)
        for node in sorted(used - declared):
            findings.append(
                f"{MAP}: diagram {index} draws an edge to undeclared node '{node}'")


def check_legends(root: str, findings: list[str]) -> None:
    text, mermaid = map_blocks(root, findings)
    if mermaid is None:
        return
    if not mermaid:
        findings.append(f"{MAP}: no diagram to check legends against")
        return
    for index, (_, body, closing) in enumerate(mermaid, 1):
        declared, _ = diagram_nodes(body)
        if not declared:
            findings.append(f"{MAP}: diagram {index} declares no node")
            continue
        named = legend_names(legend_after(text, closing))
        for node in sorted(declared - named):
            findings.append(
                f"{MAP}: diagram {index} node '{node}' has no legend row")


def check_flow_edges(root: str, findings: list[str]) -> None:
    """The parked reply reaches a person through the adapter."""
    _, mermaid = map_blocks(root, findings)
    if mermaid is None:
        return
    index, body, _ = flow_diagram(mermaid)
    if body is None:
        findings.append(
            f"{MAP}: no flow diagram declaring '{COORDINATOR}' to check the "
            f"park path against")
        return
    drawn = edges(body)
    if (COORDINATOR, PERSON) in drawn:
        # Two kinds of work wait for a person and they wait in two places. A
        # customer reply parks in the adapter (DEC-11). A gated internal write
        # parks in the ledger and calls no adapter (DEC-34), so a person finds
        # it through the escalations report. One direct edge collapses both
        # into a path that matches neither.
        findings.append(
            f"{MAP}: the coordinator reaches '{PERSON}' directly. A customer "
            f"reply parks in the adapter (DEC-11) and a gated internal write "
            f"parks in the ledger (DEC-34). Draw the path a reviewer takes")
    if (COORDINATOR, ADAPTERS) not in drawn:
        findings.append(
            f"{MAP}: no park edge from '{COORDINATOR}' to '{ADAPTERS}'")
    if (ADAPTERS, PERSON) not in drawn:
        findings.append(
            f"{MAP}: no edge from '{ADAPTERS}' to '{PERSON}'")


def check_configured_path(root: str, findings: list[str]) -> None:
    """The path back to the customer is drawn broken, because it is optional."""
    _, mermaid = map_blocks(root, findings)
    if mermaid is None:
        return
    _, body, _ = flow_diagram(mermaid)
    if body is None:
        findings.append(
            f"{MAP}: no flow diagram declaring '{COORDINATOR}' to check the "
            f"mail path against")
        return
    seen = False
    for line in body:
        if COMMENT.match(line):
            continue
        bare = strip_labels(line)
        arrows = [arrow for source, arrow, target in scan_edges(bare)
                  if (source, target) == (MAIL_ADAPTER, MAILBOX)]
        if not arrows:
            continue
        seen = True
        if not all(DOTTED.search(arrow) for arrow in arrows):
            findings.append(
                f"{MAP}: the edge from '{MAIL_ADAPTER}' to '{MAILBOX}' is not "
                f"drawn with a broken line. That path needs a configuration "
                f"choice")
    if not seen:
        findings.append(
            f"{MAP}: no edge from '{MAIL_ADAPTER}' to '{MAILBOX}'")


def check_er_unenforced(root: str, findings: list[str]) -> None:
    text, mermaid = map_blocks(root, findings)
    if mermaid is None:
        return
    seen = False
    for index, (_, body, closing) in enumerate(mermaid, 1):
        if not is_entity_diagram(body):
            continue
        seen = True
        if UNENFORCED not in legend_after(text, closing):
            findings.append(
                f"{MAP}: diagram {index} draws relationships and its legend does "
                f"not say the database {UNENFORCED}")
    if not seen:
        findings.append(f"{MAP}: no erDiagram found")


def shipped_markdown(root: str, findings: list[str]) -> Iterator[str]:
    """Every markdown file a reader receives.

    Build output and vendored trees hold documents this repository did not
    write. `.claude/`, `.decisions/` and `.flow/` hold machine-written session
    state, and a stale link inside one would fail an unrelated pull request.

    Anything that is not a regular file is skipped. `os.walk` suppresses
    symlinked directories only, so a symlinked file is still yielded and
    opening it follows the link. A link to a character device never returns,
    and a FIFO reports size zero and hangs the same way. One regular-file test
    covers the symlink, the FIFO, the socket and the device node.
    """
    skip = {"node_modules", "dist", ".git", "corpus", "__pycache__", ".trail",
            ".claude", ".decisions", ".flow"}
    walked = os.walk(
        root, onerror=lambda error: findings.append(
            f"{error.filename}: {error.strerror or error}"))
    for base, dirs, files in walked:
        dirs[:] = [d for d in dirs if d not in skip]
        for name in files:
            if not name.endswith(".md"):
                continue
            path = os.path.join(base, name)
            try:
                if not stat.S_ISREG(os.lstat(path).st_mode):
                    continue
            except OSError as error:
                findings.append(f"{path}: {error.strerror or error}")
                continue
            yield path


def check_links(root: str, findings: list[str]) -> None:
    scanned = 0
    for path in sorted(shipped_markdown(root, findings)):
        relative = os.path.relpath(path, root)
        text, error = read_text(path)
        if error is not None:
            findings.append(f"{relative}: {error}")
            continue
        scanned += 1
        _, dangling = blocks(text)
        for line in dangling:
            findings.append(
                f"{relative}: a fence opened at line {line + 1} and never "
                f"closes, so the rest of the file is not checked")
        # A fence can hold a link-shaped string that names no file.
        for raw in LINK.findall(prose_text(text)):
            parts = raw.split()
            if not parts:
                findings.append(f"{relative}: a link target is empty")
                continue
            target = parts[0].strip("<>")
            if target.startswith(("#", "http://", "https://", "mailto:")):
                continue
            target = target.split("#")[0]
            if not target:
                continue
            resolved = os.path.normpath(
                os.path.join(os.path.dirname(path), target))
            if not os.path.exists(resolved):
                findings.append(
                    f"{relative}: link '{target}' resolves nowhere")
    if scanned == 0:
        # A checkout problem and a wrong root both read as a clean gate
        # otherwise.
        findings.append("no markdown file was read, so nothing was checked")


def open_items(register: str) -> list[int] | None:
    """The numbered open items section 7 lists.

    The count is read rather than assumed. An item the register grows would
    otherwise never need a row.
    """
    heading = re.search(r"^## 7\. ", register, re.M)
    if heading is None:
        return None
    tail = register[heading.end():]
    end = SECTION_71.search(tail)
    body = tail[:end.start()] if end else tail
    return [int(n) for n in OPEN_ITEM.findall(body)]


def design_table(register: str) -> str | None:
    """The rows of section 7.1, bounded by the next heading.

    Splitting on the first occurrence anywhere would read a fence, and reading
    to the end of the document would let any row-shaped line satisfy an item.
    """
    start = SECTION_71.search(register)
    if start is None:
        return None
    tail = register[start.end():]
    end = NEXT_HEADING.search(tail)
    section = tail[:end.start()] if end else tail
    return "\n".join(
        line.strip() for line in section.splitlines()
        if line.lstrip().startswith("|"))


def check_design_index(root: str, findings: list[str]) -> None:
    """Every open item has a row, and every file a row names exists."""
    register = read_repo_file(root, REGISTER, findings)
    if register is None:
        return
    # A fence can hold an example heading. Reading it as the real section
    # turns this gate into seven findings that block a merge.
    register = prose_text(register)
    items = open_items(register)
    if items is None:
        findings.append(f"{REGISTER}: no section 7 to read")
        return
    if not items:
        findings.append(f"{REGISTER}: section 7 lists no open item")
        return
    if items != list(range(1, len(items) + 1)):
        findings.append(
            f"{REGISTER}: section 7 numbers its items {items}, which is not a "
            f"run from 1. Other documents cite these numbers")
    table = design_table(register)
    if table is None:
        findings.append(f"{REGISTER}: no section 7.1 to read")
        return
    for item in items:
        if not re.search(rf"^\s*\|\s*{item}\.\s", table, re.M):
            findings.append(
                f"{REGISTER}: section 7.1 has no row for open item {item}")
    for named in re.findall(r"`([^`]+\.md)`", table):
        if not os.path.exists(os.path.join(root, DESIGN_DIR, named)):
            findings.append(
                f"{REGISTER}: section 7.1 names '{named}', which does not exist "
                f"under {DESIGN_DIR}/")


DECISIONS_SECTION = re.compile(
    r"^## Decisions affected\s*$(.*?)(?=^## |\Z)", re.M | re.S)
# Not fixed-width. The register holds DEC-43 today, and at DEC-100 a `\d{2}`
# pattern reads the first two digits and reports a citation nobody wrote.
DEC_ID = re.compile(r"DEC-\d{2,}")
# A row of the register's own table. Applied to section 2 alone, because that
# is the section this rule names: a DEC quoted in a later section's prose, or
# in a table of something else, defines nothing.
REGISTER_ROW = re.compile(r"^\s*\|\s*(DEC-\d{2,})\s*\|", re.M)
SECTION_2 = re.compile(r"^## 2\.\s.*?(?=^## |\Z)", re.M | re.S)
# The declaration a record carries, and the whole of what this check reads.
#
# An earlier rule read the verdict out of the section's opening sentence. It
# cannot be done. "None. DEC-05 governs this work and none of it changes" and
# "DEC-05 governs this work, and none of it changes" say the same thing and
# open with opposite words, and the repository's own corpus holds both
# spellings. Worse, the phrase CONTRIBUTING.md tells an author to write for a
# change that affects nothing — "Implementation detail." — does not begin with
# "none" either, so the rule admitted exactly what it existed to refuse.
#
# So the author declares and the checker reads. There is no sentence to parse.
AFFECTS = re.compile(r"^Affects:\s*(.*?)\s*$", re.M)
AFFECTS_NONE = re.compile(r"^none$", re.I)


def register_decs(register: str) -> set[str]:
    """The decisions section 2 defines, and no others."""
    section = SECTION_2.search(prose_text(register))
    if section is None:
        return set()
    return set(REGISTER_ROW.findall(section.group(0)))


def affects_line(text: str, path: str, findings: list[str]) -> str | None:
    """The record's declaration, or None with a finding explaining which fault.

    Exactly one line, inside the section. Two would let a record say both
    things and leave the reader to choose.
    """
    section = DECISIONS_SECTION.search(prose_text(text))
    if section is None:
        findings.append(f"{path}: no 'Decisions affected' section")
        return None
    declared = AFFECTS.findall(section.group(1))
    if not declared:
        findings.append(
            f"{path}: names no 'Affects:' line under 'Decisions affected'")
        return None
    if len(declared) > 1:
        findings.append(f"{path}: carries {len(declared)} 'Affects:' lines")
        return None
    return declared[0]


def markdown_under(root: str, directory: str, findings: list[str],
                   ) -> list[tuple[str, bool]]:
    """Every markdown file under one directory, as (path, is at the top level).

    Walks, rather than listing one level. A record filed one directory deeper
    was reached by nothing, which made the whole rule optional to anyone who
    made a subdirectory.
    """
    where = os.path.join(root, directory)
    if not os.path.isdir(where):
        findings.append(f"{directory}/: not a directory")
        return []
    found = []
    for base, dirs, files in os.walk(
            where, onerror=lambda error: findings.append(
                f"{error.filename}: {error.strerror or error}")):
        dirs.sort()
        for name in sorted(files):
            if not name.endswith(".md") or name == "README.md":
                continue
            path = os.path.join(base, name)
            rel = os.path.relpath(path, root).replace(os.sep, "/")
            found.append((rel, os.path.dirname(path) == where))
    return found


def check_decisions(root: str, findings: list[str]) -> None:
    """A design record declares the decisions it cites, and lives beside them.

    Three directories, so the rule cannot be escaped by choosing a fourth:

      docs/decisions/  a record, declaring at least one DEC the register
                       defines. Flat: a subdirectory would fall out of the
                       style gate, whose glob is one level deep.
      intent/          the template alone. This is the path the workflow named
                       before this rule, so it is the habit a contributor
                       falls back into, and a file left here would be read by
                       nothing while still passing the style gate.
      intent/archive/  frozen, and closed. No record there declares anything,
                       because the declaration did not exist when they were
                       written. One that does is a live record misfiled.

    Only `docs/decisions/` fails closed on emptiness. The archive may be
    emptied one day and that is not a fault; a repository with no design
    record at all has lost them.
    """
    register = read_repo_file(root, REGISTER, findings)
    if register is None:
        return
    defined = register_decs(register)
    if not defined:
        findings.append(f"{REGISTER}: section 2 defines no decision to cite")
        return

    records = markdown_under(root, DECISIONS_DIR, findings)
    if not records:
        findings.append(f"{DECISIONS_DIR}/ holds no design record")
    for path, at_top in records:
        if not at_top:
            findings.append(
                f"{path}: design records sit directly in {DECISIONS_DIR}/, "
                f"because the style checker reads one level")
            continue
        text = read_repo_file(root, path, findings)
        if text is None:
            continue
        declared = affects_line(text, path, findings)
        if declared is None:
            continue
        if AFFECTS_NONE.match(declared):
            findings.append(
                f"{path}: declares 'Affects: none', so it is not a design "
                f"record. Its rationale belongs in the pull request")
            continue
        cited = DEC_ID.findall(declared)
        if not cited:
            findings.append(f"{path}: declares 'Affects: {declared}', "
                            f"which names no DEC")
            continue
        unknown = sorted(set(cited) - defined)
        if unknown:
            findings.append(
                f"{path}: declares {', '.join(unknown)}, which section 2 of "
                f"{REGISTER} does not define")

    stray = [name for name in sorted(os.listdir(os.path.join(root, "intent")))
             if name.endswith(".md") and name != "TEMPLATE.md"]
    for name in stray:
        findings.append(
            f"intent/{name}: intent/ holds the template alone. A design "
            f"record belongs under {DECISIONS_DIR}/, and a change that "
            f"affects no decision writes no file")

    for path, _ in markdown_under(root, ARCHIVE_DIR, findings):
        text = read_repo_file(root, path, findings)
        if text is None:
            continue
        section = DECISIONS_SECTION.search(prose_text(text))
        if section is not None and AFFECTS.search(section.group(1)):
            findings.append(
                f"{path}: declares 'Affects:', so it is a design record and "
                f"belongs under {DECISIONS_DIR}/. The archive is frozen")


# "DEC-01 to DEC-43", and every ordinary way of writing it.
#
# The connector is "any few words or punctuation", not a fixed alternation.
# The first version listed `to|through|-`, and "DEC-01 up to DEC-42" walked
# straight through it — a guard that pins one spelling is the same
# class-for-member mistake it exists to catch. The digits are `\d+`, so
# "DEC-1" counts too.
#
# A comma, a full stop, a newline or a digit ends the connector, so a list
# ("DEC-05, DEC-06") is not read as a range and two sentences that each
# mention a decision are not joined into one. "and" and "or" are excluded for
# the same reason: "DEC-08 and DEC-15 hold across the repository" names a pair,
# not a span, and reading it as one reported a false range in this repository's
# own quick map.
DEC_RANGE = re.compile(r"DEC-(\d+)(?:(?!\band\b|\bor\b)[^,.\n\d]){1,14}DEC-(\d+)")
# "43 numbered decisions" and "It holds 43 decisions".
DEC_COUNT = re.compile(r"(\d+)\s+(?:numbered\s+)?decisions")


def check_dec_range(root: str, findings: list[str]) -> None:
    """Every stated range and count matches what section 2 defines.

    README.md said DEC-01 to DEC-42 in two places while the register defined
    43, and CONTRIBUTING.md and AGENTS.md said 43. Three documents, two
    answers, and the register settles it — so nothing but drift kept them
    apart (issue #79).

    The register is read the way `decisions` reads it, through section 2's
    table rows, so one parse decides both checks.
    """
    register = read_repo_file(root, REGISTER, findings)
    if register is None:
        return
    decs = register_decs(register)
    if not decs:
        findings.append(f"{REGISTER}: section 2 defines no decisions, so no range can be checked")
        return
    numbers = sorted(int(dec.split("-")[1]) for dec in decs)
    lowest, highest = numbers[0], numbers[-1]
    # A gap makes "DEC-01 to DEC-43" false even when both ends are right, and
    # the register is the thing that would carry the gap.
    if numbers != list(range(lowest, highest + 1)):
        missing = sorted(set(range(lowest, highest + 1)) - set(numbers))
        findings.append(
            f"{REGISTER}: section 2 skips "
            + ", ".join(f"DEC-{n:02d}" for n in missing)
            + ", so no document can state a range")
        return

    checked = 0
    for doc in RANGE_DOCS:
        text = read_repo_file(root, doc, findings)
        if text is None:
            continue
        # Whitespace collapsed first. "DEC-01 to\nDEC-43" is one claim that a
        # line break split in two, and a scan that stopped at the newline read
        # this repository's own quick map as stating no range at all — passing
        # a stale one in silence, which is the defect this check exists for.
        bare = re.sub(r"\s+", " ", prose_text(text))
        for first, last in DEC_RANGE.findall(bare):
            checked += 1
            if (int(first), int(last)) != (lowest, highest):
                findings.append(
                    f"{doc}: states DEC-{first} to DEC-{last}; section 2 of "
                    f"{REGISTER} defines DEC-{lowest:02d} to DEC-{highest:02d}")
        for count in DEC_COUNT.findall(bare):
            checked += 1
            if int(count) != len(decs):
                findings.append(
                    f"{doc}: states {count} decisions; section 2 of "
                    f"{REGISTER} defines {len(decs)}")
    # Fail closed. A rename that stops these documents stating the range at
    # all would otherwise pass by saying nothing.
    if checked == 0:
        findings.append(
            "no document states the register's range or count, so this check "
            f"proved nothing; one of {', '.join(RANGE_DOCS)} must state it")


def manifest_scripts(root: str, findings: list[str]) -> list[str]:
    """The script names `package.json` defines, in the order it defines them.

    Read with the JSON parser rather than a pattern, because a script body can
    hold a brace and a quoted name.
    """
    text = read_repo_file(root, MANIFEST, findings)
    if text is None:
        return []
    try:
        scripts = json.loads(text).get("scripts", {})
    except json.JSONDecodeError as error:
        findings.append(f"{MANIFEST}: not JSON ({error})")
        return []
    if not isinstance(scripts, dict):
        findings.append(f"{MANIFEST}: 'scripts' is not an object")
        return []
    return [name for name in scripts if isinstance(name, str)]


def check_script_index(root: str, findings: list[str]) -> None:
    """Every script the manifest defines is a command the runbook names.

    `seed-history` existed in `package.json` and in no document at all, so the
    only way to learn of it was to read the manifest (issue #79).

    The match is on the command a reader would type — `pnpm run <name>` or
    `pnpm <name>` — not on the bare word. "build", "check" and "test" are
    ordinary English, and a substring rule counted every prose use of them and
    reported a runbook that documented nothing.
    """
    names = manifest_scripts(root, findings)
    if not names:
        if not findings:
            findings.append(f"{MANIFEST}: defines no scripts, so this check proved nothing")
        return
    runbook = read_repo_file(root, RUNBOOK, findings)
    if runbook is None:
        return
    # Fenced commands count: that is where a runbook puts them.
    # `pnpm run <name>`, and the short spelling only for the names this
    # repository actually writes that way. A bare `pnpm <word>` match let any
    # script whose name collides with a pnpm subcommand pass undocumented: a
    # script called `install` was satisfied by the `pnpm install` in the setup
    # section, and so were `exec`, `dlx` and `store`.
    SHORT = {"test"}
    typed = set(re.findall(r"pnpm\s+run\s+([A-Za-z0-9:_-]+)", runbook))
    typed |= {
        name for name in re.findall(r"pnpm\s+([A-Za-z0-9:_-]+)", runbook)
        if name in SHORT
    }
    for name in names:
        if name not in typed:
            findings.append(
                f"{RUNBOOK}: names no `pnpm run {name}`, which {MANIFEST} defines")
    # The other direction. A runbook naming a command that no longer exists
    # sends a reader to a failure, and it is the likelier rot: a script is
    # deleted far more often than the paragraph describing it.
    defined = set(names)
    for name in sorted(typed):
        if name not in defined:
            findings.append(
                f"{RUNBOOK}: names `pnpm run {name}`, which {MANIFEST} does not define")


# A quick-map row opens with the directory in backticks: `| `coordinator` |`.
MAP_ROW = re.compile(r"^\|\s*`([A-Za-z0-9_-]+)`\s*\|(.*)$", re.M)
# The list itself: the first paragraph under the heading, and nothing after
# it. Reading the whole section let the prose below name a decision the list
# had dropped, so removing two ids from the list changed nothing — the same
# vacuity this check exists to refuse.
MAP_UNCOVERED = re.compile(
    r"^##\s*Decisions no row names\s*$\s*\n(.*?)(?:\n\s*\n|\Z)", re.M | re.S)


def check_map_coverage(root: str, findings: list[str]) -> None:
    """The quick map's own list of what it leaves out is the truth.

    The map said two decisions appeared in no row. Four did. A sentence
    counting rows of a table beside it is exactly the claim a checker should
    decide, and this file's whole argument is that such claims get checked
    (issue #79).

    The list is read as a set of ids, not a count, so a number in prose never
    has to be kept in step with it.
    """
    text = read_repo_file(root, QUICK_MAP, findings)
    if text is None:
        return
    bare = prose_text(text)
    rows = MAP_ROW.findall(bare)
    # Two, not a number sized for today's map. The hazard is a scan that read
    # nothing at all — a renamed heading, a reshaped table — not a map that is
    # briefly small.
    if len(rows) < 2:
        findings.append(f"{QUICK_MAP}: found {len(rows)} directory rows, so it scanned nothing")
        return
    covered: set[str] = set()
    for _, rest in rows:
        covered |= set(re.findall(r"DEC-(\d+)", rest))

    register = read_repo_file(root, REGISTER, findings)
    if register is None:
        return
    defined = {dec.split("-")[1] for dec in register_decs(register)}
    if not defined:
        findings.append(f"{REGISTER}: section 2 defines no decisions")
        return
    uncovered = {f"DEC-{n}" for n in sorted(defined - covered)}

    section = MAP_UNCOVERED.search(bare)
    if section is None:
        findings.append(
            f"{QUICK_MAP}: has no '## Decisions no row names' section, so the "
            f"decisions its rows leave out are stated nowhere")
        return
    listed = set(re.findall(r"DEC-\d+", section.group(1)))
    if listed != uncovered:
        missing = ", ".join(sorted(uncovered - listed)) or "none"
        extra = ", ".join(sorted(listed - uncovered)) or "none"
        findings.append(
            f"{QUICK_MAP}: the section lists the wrong set. Named and covered "
            f"by a row: {extra}. Covered by no row and not named: {missing}")


def check_script_claim(root: str, findings: list[str]) -> None:
    """The runbook never claims the console ships no script.

    The claim was true once and went stale when the console gained its one
    pinned script (issue #105). A reader who meets it again is sent to a false
    statement, and the console's own guard reads its source files rather than
    the runbook, so the phrasing rule lives here.

    Each phrase is read against the runbook with its whitespace collapsed and
    its case folded. The runbook is wrapped prose, and a claim that returns
    starts a sentence. Both spellings have to read as the one this check
    exists to stop.
    """
    runbook = read_repo_file(root, RUNBOOK, findings)
    if runbook is None:
        return
    bare = " ".join(runbook.split()).casefold()
    for phrase, claim in (
        ("ships no script", "the console ships no script"),
        ("there is no script", "there is no script"),
        ("ships no javascript", "the console ships no JavaScript"),
    ):
        if phrase in bare:
            findings.append(f"{RUNBOOK}: claims {claim}")


CHECKS = {
    "diagrams": check_diagrams,
    "legends": check_legends,
    "flow-edges": check_flow_edges,
    "configured-path": check_configured_path,
    "er-unenforced": check_er_unenforced,
    "links": check_links,
    "design-index": check_design_index,
    "decisions": check_decisions,
    "dec-range": check_dec_range,
    "script-index": check_script_index,
    "script-claim": check_script_claim,
    "map-coverage": check_map_coverage,
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--only", default="")
    args = parser.parse_args()

    # A repeat would run the check twice and inflate both counts.
    wanted = list(dict.fromkeys(
        name.strip() for name in args.only.split(",") if name.strip()))
    for name in wanted:
        if name not in CHECKS:
            print(f"unknown check '{name}'", file=sys.stderr)
            return 2
    running = wanted or list(CHECKS)
    findings = []
    for name in running:
        try:
            CHECKS[name](args.root, findings)
        except Exception as error:  # noqa: BLE001 - a crash is a finding
            # Findings print after the loop, so one raising check used to
            # erase every finding before it.
            findings.append(f"check '{name}' raised {type(error).__name__}: {error}")

    # One unterminated fence in the map reports through two checks.
    for finding in dict.fromkeys(findings):
        print(finding)
    if findings:
        print(f"\n{len(dict.fromkeys(findings))} finding(s)")
        return 1
    print(f"docs clean: {len(running)} check(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
