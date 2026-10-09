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
  er-unenforced Each entity diagram's legend says which tables declare no
                foreign key. A database test checks the drawing itself.
  links         Every relative link in a shipped document resolves.
  design-index  The register's design table accounts for every open item it
                lists, and every file it names exists. It names every entry
                under docs/design/, and each name says what the document is.
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
  map-rows      The quick map has a row for every source directory and the
                console, and no row for a directory that is gone.
  licence       The repository root holds the Apache License 2.0, and every
                workspace package declares that licence.
  cooldown      Every Dependabot ecosystem waits at least a day, so no update
                proposal lands inside pnpm's release-age gate.

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
import glob
import hashlib
import json
import os
import posixpath
import re
import stat
import subprocess
import sys
import unicodedata

MAP = "docs/architecture-map.md"
REGISTER = "docs/v1-architecture.md"
DESIGN_DIR = "docs/design"
# A design document's name: two or more lowercase parts joined by hyphens,
# one of them a word, all letters, with a letter past `f`. An allow rule,
# because a list of the names a tool generates never ends: a UUID, a hash, a
# ULID, a cuid, a timestamp. Each lacks the hyphens or the word.
DOCUMENT_NAME = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)+\.md$")
WORD = re.compile(r"^[a-z]*[g-z][a-z]*$")


def says_what_it_is(entry: str) -> bool:
    """Whether a file name passes the rule `DOCUMENT_NAME` and `WORD` state."""
    if not DOCUMENT_NAME.match(entry):
        return False
    return any(len(part) > 1 and WORD.match(part) for part in entry[: -len(".md")].split("-"))
# The folders under docs/design, each with what it holds.
DESIGN_FOLDERS = {
    "console-canvas": "the console's artboards, which its README describes",
}
DECISIONS_DIR = "docs/decisions"
ARCHIVE_DIR = "intent/archive"
MANIFEST = "package.json"
RUNBOOK = "docs/operations.md"
QUICK_MAP = "docs/quick-map.md"
LICENCE_FILE = "LICENSE"
DEPENDABOT = ".github/dependabot.yml"
WORKSPACE = "pnpm-workspace.yaml"
# The directories pnpm never takes a workspace package from.
IGNORED_DIRS = frozenset({"node_modules", "bower_components"})
# The SPDX identifier every package declares, and the text it names. The check
# compares the terms by digest. It takes everything up to and including their
# closing line, with whitespace collapsed, because the published text centres
# its heading with spaces.
LICENCE_ID = "Apache-2.0"
LICENCE_TERMS_END = "END OF TERMS AND CONDITIONS"
# The digest of the text the Apache Software Foundation publishes at
# https://www.apache.org/licenses/LICENSE-2.0.txt, taken by the rule above.
# GitHub's own template for apache-2.0 gives the same digest. To reproduce:
#   curl -s https://www.apache.org/licenses/LICENSE-2.0.txt | python3 -c \
#     "import sys,hashlib; t=sys.stdin.read(); e='END OF TERMS AND CONDITIONS'; \
#     print(hashlib.sha256(' '.join(t[:t.index(e)+len(e)].split()).encode()).hexdigest())"
LICENCE_TERMS_SHA256 = "59d8f0ba87ad9a2f1a431123c8d16646e5b89ba53653e818f16d136d77263c99"
# Only the appendix may follow the terms, and it stays the published
# template. The copyright line belongs in NOTICE, as the Apache Software
# Foundation advises, so no text an adopter writes after the terms can change
# them. A file may also end at the terms. This is the digest of the same
# apache.org appendix, taken the same way.
LICENCE_APPENDIX_SHA256 = "15e0e14d590e112dcf1801fb0ca4a74c6178f468147941bfe6840cb55fa84ca4"
# The documents that state the register's range. Each says it in prose a reader
# believes, and each went stale when DEC-43 arrived: two said DEC-42 while the
# register defined 43.
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
    walked = os.walk(root, onerror=walk_errors(findings, root))
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


def ignored_by_git(root: str, paths: list[str]) -> set[str]:
    """The paths, relative to `root`, that git ignores there.

    Git reads `.gitignore`, `.git/info/exclude` and the user's own excludes
    file, so an editor's swap file or a file browser's metadata counts as
    ignored wherever the contributor told git to ignore it. A root that is no
    git work tree ignores nothing, and git's absence is the same.
    """
    if not paths:
        return set()
    # With core.precomposeunicode, which macOS git writes on, git composes the
    # names it reads from the disk, but not those it reads on stdin, and the
    # disk can list a name decomposed. So then each path goes to git
    # composed, and each answer maps back to every name listed that way.
    # Otherwise a name is its bytes.
    compose = precomposes(root)
    asked: dict[str, list[str]] = {}
    for path in paths:
        asked.setdefault(unicodedata.normalize("NFC", path) if compose else path, []).append(path)
    # Bytes, not text: a file name need not be valid UTF-8.
    try:
        done = subprocess.run(
            ["git", "-C", root, "check-ignore", "--stdin", "-z"],
            input=b"\0".join(os.fsencode(path) for path in asked) + b"\0",
            capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return set()
    # 0: some path is ignored; 1: none is; anything else: no work tree here.
    if done.returncode not in (0, 1):
        return set()
    answers = (os.fsdecode(path) for path in done.stdout.split(b"\0") if path)
    return {listed for answer in answers for listed in asked.get(answer, [answer])}


def precomposes(root: str) -> bool:
    """Whether git composes the names it reads from the disk under `root`.

    Only git on macOS reads the setting, and only a value of true composes.
    `git init` and `git clone` there write it true. Unset or unreadable, git
    composes nothing.
    """
    if sys.platform != "darwin":
        return False
    try:
        done = subprocess.run(
            ["git", "-C", root, "config", "--type=bool", "core.precomposeunicode"],
            capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return done.returncode == 0 and done.stdout.strip() == "true"


def record_problem(design: str, record: str) -> str | None:
    """Why `record` names no file under `design`, or None when it names one.

    A disk that ignores case opens `AAA.md` for `aaa.md`, and a checkout on a
    disk that does not then breaks the link. So each part of the name must
    match an entry as it is listed. A folder that cannot be listed is a
    folder that cannot be read, not a file that does not exist.
    """
    at = design
    for part in posixpath.normpath(record).split("/"):
        try:
            if part not in os.listdir(at):
                return "does not exist"
        except NotADirectoryError:
            return "does not exist"
        except FileNotFoundError:
            return "does not exist"
        except OSError as error:
            return f"cannot be read ({error.strerror or error})"
        at = os.path.join(at, part)
    return None if os.path.isfile(at) else "does not exist"


def check_design_index(root: str, findings: list[str]) -> None:
    """Every open item has a row, every file a row names exists, and the table
    names every entry under docs/design, each by a name that says what it is."""
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
    # Read the directory once, first. A missing or unreadable one is one
    # finding, not a "does not exist" for every row the table names.
    design = os.path.join(root, DESIGN_DIR)
    try:
        entries = sorted(os.listdir(design))
    except FileNotFoundError:
        findings.append(f"{DESIGN_DIR}/: does not exist")
        return
    except OSError as error:
        findings.append(f"{DESIGN_DIR}/: cannot read ({error.strerror or error})")
        return
    named = {posixpath.normpath(record) for record in re.findall(r"`([^`]+\.md)`", table, re.I)}
    for record in sorted(named):
        problem = record_problem(design, record)
        if problem is not None:
            findings.append(
                f"{REGISTER}: section 7.1 names '{record}', which {problem} "
                f"under {DESIGN_DIR}/")
    # The reverse direction. A document the register never names is one
    # nobody finds from the decision it serves, and a name a tool generated
    # tells a reader nothing about it. So every entry at the top of the
    # directory is a design document the table names, or a folder this check
    # knows. A link to nothing is a document that does not exist.
    # A file git ignores, such as an editor's swap file, never ships, and it
    # is no document. Every other entry answers to the rules below.
    ignored = ignored_by_git(root, [posixpath.join(DESIGN_DIR, entry) for entry in entries])
    for entry in entries:
        if posixpath.join(DESIGN_DIR, entry) in ignored:
            continue
        if os.path.isdir(os.path.join(design, entry)):
            if entry not in DESIGN_FOLDERS:
                findings.append(
                    f"{DESIGN_DIR}/{entry}/ is a folder this check does not know. "
                    f"Name it in DESIGN_FOLDERS with what it holds")
            continue
        if not says_what_it_is(entry):
            findings.append(
                f"{DESIGN_DIR}/{entry} has a name that says nothing. Use lowercase "
                f"words joined by hyphens, ending in .md")
        if entry not in named:
            findings.append(
                f"{DESIGN_DIR}/{entry} is a design document section 7.1 does not name")


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
    for base, dirs, files in os.walk(where, onerror=walk_errors(findings, root)):
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
    apart.

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
    only way to learn of it was to read the manifest.

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
    decide, and this file's whole argument is that such claims get checked.

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


SOURCE_SUFFIXES = (".ts", ".tsx", ".mts", ".cts")


def holds_source(root: str, directory: str, findings: list[str]) -> bool | None:
    """True when a TypeScript file sits anywhere under `directory`.

    A subtree it cannot read is a finding, not an absence of source. With no
    source found and a subtree unread, the answer is None: the check cannot
    tell, so it names neither a missing row nor an extra one.
    """
    unread: list[OSError] = []
    record = walk_errors(findings, root, f"{QUICK_MAP}: cannot read ", quote=True)

    def unreadable(error: OSError) -> None:
        unread.append(error)
        record(error)

    for _, _, files in os.walk(directory, onerror=unreadable):
        if any(name.endswith(SOURCE_SUFFIXES) for name in files):
            return True
    return None if unread else False


def walk_errors(findings: list[str], root: str, label: str = "", quote: bool = False):
    """An `os.walk` error handler that records each unreadable path.

    The path is given from `root`, so a finding reads the same in any checkout.
    """
    def record(error: OSError) -> None:
        where = os.path.relpath(error.filename, root) if error.filename else root
        if quote:
            where = f"`{where}`"
        findings.append(f"{label}{where}: {error.strerror or error}")
    return record


def check_map_rows(root: str, findings: list[str]) -> None:
    """The quick map has one row for each directory a reader can open.

    The directories on disk decide: each one under `src/` that holds a
    TypeScript file, and `console` when `console/src` exists. A hidden
    directory is not one, and neither is a cache or a leftover that holds no
    source. So a checkout with such a directory reads the same as a clean
    clone.
    """
    text = read_repo_file(root, QUICK_MAP, findings)
    if text is None:
        return
    rows = {name for name, _ in MAP_ROW.findall(prose_text(text))}
    source = os.path.join(root, "src")
    on_disk: set[str] = set()
    unknown: set[str] = set()
    entries: list[os.DirEntry] = []
    if os.path.isdir(source):
        try:
            entries = list(os.scandir(source))
        except OSError as error:
            findings.append(f"{QUICK_MAP}: cannot read `src`: {error.strerror or error}")
            return
    if entries:
        for entry in entries:
            if not entry.is_dir() or entry.name.startswith("."):
                continue
            verdict = holds_source(root, entry.path, findings)
            if verdict is None:
                unknown.add(entry.name)
            elif verdict:
                on_disk.add(entry.name)
    if not on_disk and unknown:
        findings.append(f"{QUICK_MAP}: could not read the directories it found under src/, so it compared nothing")
        return
    if not on_disk:
        findings.append(f"{QUICK_MAP}: found no source directories under src/, so it compared nothing")
        return
    if os.path.isdir(os.path.join(root, "console", "src")):
        on_disk.add("console")
    for name in sorted(on_disk - rows):
        findings.append(f"{QUICK_MAP}: has no row for the directory `{name}`")
    for name in sorted(rows - on_disk - unknown):
        findings.append(f"{QUICK_MAP}: has a row for `{name}`, which is not a source directory")


def check_script_claim(root: str, findings: list[str]) -> None:
    """The runbook never claims the console ships no script.

    The claim was true once and went stale when the console gained its one
    pinned script. A reader who meets it again is sent to a false statement,
    and the console's own guard reads its source files rather than the
    runbook, so the phrasing rule lives here.

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


def list_item(value: str) -> str | None:
    """The text of one list item after its dash, or None when it cannot be read.

    A quoted item runs to its closing quote, so a `#` inside it is part of the
    path. A bare item ends at a comment. An empty item, an unclosed quote or
    text after the closing quote cannot be read. Neither can a bare item that
    opens with a YAML indicator: YAML reads `!!str x` as the string "x", so an
    exclusion is only read in quotes, as `'!x'`.
    """
    value = value.strip()
    if value[:1] in tuple("!&*|>%@`{[]}?:,-"):
        return None
    if value[:1] in ("'", '"'):
        close = value.find(value[0], 1)
        if close < 0:
            return None
        rest = value[close + 1:].strip()
        if rest and not rest.startswith("#"):
            return None
        text = value[1:close]
    else:
        text = re.split(r"(?:^|\s)#", value, maxsplit=1)[0].strip()
    return text or None


def package_list(text: str, findings: list[str]) -> list[str]:
    """The items of the block-style `packages:` list, failing closed.

    The list ends at the next unindented line that is not a list item. An
    indented line inside it that is not a readable item is a finding, because
    ending the list there would leave every later package unchecked.
    """
    entries: list[str] = []
    inside = False
    for line in text.splitlines():
        head = re.match(r"^packages:(.*)$", line)
        if head:
            rest = head.group(1).strip()
            if rest and not rest.startswith("#"):
                findings.append(
                    f"{WORKSPACE}: lists its packages in a form this check cannot read")
                return []
            inside = True
            continue
        if not inside or not line.strip() or line.lstrip().startswith("#"):
            continue
        dash = re.match(r"^\s*-(?:\s(.*))?$", line)
        if dash:
            item = list_item(dash.group(1) or "")
            if item is None:
                findings.append(
                    f"{WORKSPACE}: cannot read the package list item {line.strip()!r}")
            else:
                entries.append(item)
        elif line[0].isspace():
            findings.append(
                f"{WORKSPACE}: cannot read the package list item {line.strip()!r}")
        else:
            inside = False
    return entries


def workspace_packages(root: str, findings: list[str]) -> list[str]:
    """The manifest path of every package the workspace lists.

    The check reads the list from `pnpm-workspace.yaml`, so it covers a package
    added later with no edit here. It reads a block-style `packages:` list
    only. Each item is a quoted or bare directory or glob, where `*` matches
    within one directory and `**` matches any depth. An item starting with `!`
    excludes what it matches. A glob that matches no package is a finding.

    The check always reads the root manifest. pnpm includes the workspace root
    whatever the list says, and without the file the root is the only package.
    """
    path = os.path.join(root, WORKSPACE)
    if not os.path.lexists(path):
        return [MANIFEST]
    text = read_repo_file(root, WORKSPACE, findings)
    if text is None:
        return [MANIFEST]
    # A byte-order mark is an encoding detail, not part of the first key.
    text = text.removeprefix("\ufeff")
    before = len(findings)
    entries = package_list(text, findings)
    if not entries:
        if len(findings) == before:
            findings.append(f"{WORKSPACE}: lists no packages, so only the root manifest is checked")
        return [MANIFEST]
    def matching(pattern: str) -> list[str]:
        # pnpm matches `<pattern>/package.json`, where `*` stays inside one
        # directory, and it never takes a package from `node_modules` or
        # `bower_components`. The check escapes the root, so a glob character
        # in the checkout's own path matches only itself.
        found = glob.glob(os.path.join(glob.escape(root), pattern, MANIFEST), recursive=True)
        relative = (os.path.relpath(m, root) for m in sorted(found))
        return [m for m in relative if IGNORED_DIRS.isdisjoint(m.split(os.sep))]

    manifests = [MANIFEST]
    excluded: set[str] = set()
    for entry in entries:
        if entry.startswith("!"):
            found = matching(entry[1:])
            if not found:
                findings.append(f"{WORKSPACE}: {entry!r} matches no package")
            excluded.update(found)
        elif "*" in entry:
            found = matching(entry)
            if not found:
                findings.append(f"{WORKSPACE}: {entry!r} matches no package")
            manifests += found
        else:
            manifests.append(os.path.normpath(os.path.join(entry, MANIFEST)))
    return [m for m in dict.fromkeys(manifests) if m == MANIFEST or m not in excluded]


def check_licence(root: str, findings: list[str]) -> None:
    """The code carries the licence its owner chose, in every place a reader looks.

    A reader of the root sees `LICENSE`. A reader of one package sees that
    package's manifest, and a package that declares nothing reads as
    unlicensed. So the check reads both. The file must hold the Apache License
    2.0 and not merely exist, and each workspace package must declare it.
    """
    if not os.path.lexists(os.path.join(root, LICENCE_FILE)):
        findings.append(f"{LICENCE_FILE}: missing")
    else:
        text = read_repo_file(root, LICENCE_FILE, findings)
        if text is not None:
            # A byte-order mark is an encoding detail, not part of the text.
            text = text.removeprefix("\ufeff")
            end = text.find(LICENCE_TERMS_END)
            split = end + len(LICENCE_TERMS_END) if end >= 0 else len(text)
            terms = " ".join(text[:split].split())
            appendix = " ".join(text[split:].split())
            if end < 0 or hashlib.sha256(terms.encode()).hexdigest() != LICENCE_TERMS_SHA256:
                findings.append(f"{LICENCE_FILE}: is not the Apache License 2.0")
            elif appendix and hashlib.sha256(appendix.encode()).hexdigest() != LICENCE_APPENDIX_SHA256:
                findings.append(
                    f"{LICENCE_FILE}: the text after the terms is not the published appendix; "
                    "keep that template unchanged or remove it, and put a copyright line in NOTICE")
    for manifest in workspace_packages(root, findings):
        if not os.path.lexists(os.path.join(root, manifest)):
            findings.append(f"{manifest}: missing")
            continue
        text = read_repo_file(root, manifest, findings)
        if text is None:
            continue
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            findings.append(f"{manifest}: does not parse")
            continue
        if not isinstance(data, dict):
            findings.append(f"{manifest}: is not a JSON object")
            continue
        declared = data.get("license")
        if declared is None:
            findings.append(f"{manifest}: declares no license")
        elif declared != LICENCE_ID:
            findings.append(f"{manifest}: declares {declared!r}, not {LICENCE_ID!r}")


def check_cooldown(root: str, findings: list[str]) -> None:
    """Every Dependabot ecosystem waits at least a day before it proposes.

    pnpm holds back a release younger than one day, so a proposal for one
    would not match what an install resolves. The file is read by its block
    structure. Each item of the `updates:` list starts at a dash in the list's
    column, whatever key follows the dash, and runs to the next one. Its
    `package-ecosystem:` and `cooldown:` are read at the item's own key column,
    and `cooldown` holds a `default-days:` of 1 or more, in block or flow form.
    An item whose ecosystem cannot be read is a finding.
    """
    if not os.path.lexists(os.path.join(root, DEPENDABOT)):
        findings.append(f"{DEPENDABOT}: missing")
        return
    text = read_repo_file(root, DEPENDABOT, findings)
    if text is None:
        return
    lines = text.removeprefix("\ufeff").splitlines()
    start = next((n for n, line in enumerate(lines) if re.match(r"^updates:\s*(#.*)?$", line)), None)
    items: list[tuple[int, int, list[tuple[int, str]]]] = []
    dash_column = None
    for n in range(start + 1 if start is not None else len(lines), len(lines)):
        line = lines[n]
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip())
        dash = re.match(r"^(\s*)-(?:\s+(\S.*))?\s*$", line)
        if dash and (dash_column is None or indent == dash_column):
            dash_column = indent
            if dash.group(2):
                # The text after the dash is the item's first key line.
                key_column = len(line) - len(dash.group(2))
                items.append((n + 1, key_column, [(key_column, dash.group(2))]))
            else:
                # A bare dash: the item's keys sit on the lines below it, and
                # the first of them sets its key column.
                items.append((n + 1, -1, []))
        elif items and indent > dash_column:
            if items[-1][1] == -1:
                items[-1] = (items[-1][0], indent, items[-1][2])
            items[-1][2].append((indent, line.strip()))
        elif indent == 0:
            # A top-level key ends the list.
            break
        else:
            findings.append(f"{DEPENDABOT}: cannot read line {n + 1} of the updates list")
            break
    if not items:
        findings.append(f"{DEPENDABOT}: names no ecosystem")
        return
    for line_number, key_column, body in items:
        ecosystem = None
        days = None
        cooldown_open = False
        for indent, content in body:
            if cooldown_open and indent > key_column:
                value = re.match(r"^default-days:\s*(\d+)\s*(#.*)?$", content)
                if value and days is None:
                    days = int(value.group(1))
                continue
            cooldown_open = False
            if indent != key_column:
                continue
            key = re.match(r"^([A-Za-z-]+):\s*(.*?)\s*(#.*)?$", content)
            if not key:
                continue
            name, value = key.group(1), key.group(2)
            if name == "package-ecosystem" and value:
                ecosystem = value.strip("'\"")
            elif name == "cooldown":
                if value.startswith("{"):
                    flow = re.search(r"(?:^|[{,\s])default-days:\s*(\d+)", value)
                    days = int(flow.group(1)) if flow else None
                elif not value:
                    cooldown_open = True
        if ecosystem is None:
            findings.append(
                f"{DEPENDABOT}: cannot read the ecosystem of the item at line {line_number}")
        elif days is None or days < 1:
            findings.append(
                f"{DEPENDABOT}: {ecosystem} waits no day before proposing an update")


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
    "map-rows": check_map_rows,
    "licence": check_licence,
    "cooldown": check_cooldown,
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
