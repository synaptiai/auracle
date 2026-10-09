#!/usr/bin/env python3
"""Cases for the documentation checker. Run: python3 scripts/test_check_docs.py

Each case builds a throwaway repository root, runs one check against it, and
asserts the exit code. A case that expects FAIL also names a substring of the
finding it wants, so a check that fails for another reason does not pass by
accident.

The fixtures below use every edge form the shipped map uses: bare, labelled,
dotted, and entity cardinality. An earlier version tested the bare form only,
and the check was near-vacuous on the real document while every case passed.
"""
import contextlib
import importlib.util
import io
import os
import subprocess
import sys
import tempfile
import unicodedata

CHECKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-docs.py")
PASS, FAIL = 0, 1

GOOD_FLOW = """```mermaid
flowchart TB
  subgraph ADAPT["Adapters"]
    HD["Helpdesk adapter"]
    SMTP["Mail adapter"]
  end
  MAILBOX["A mailbox"]
  SM["The run coordinator"]
  OBX[("outbox table")]
  PERSON(["A person"])
  APPR["The approval bridge"]
  SM -->|"both gates pass"| OBX
  SM --> ADAPT
  ADAPT --> PERSON
  PERSON --> APPR
  APPR -->|"on approval only"| OBX
  SMTP -.->|"once configured"| MAILBOX
  style HD stroke-dasharray: 5 5
```

| Name | What it means |
|---|---|
| ADAPT | The adapters. |
| HD | The reference helpdesk adapter. |
| SMTP | The mail adapter. |
| MAILBOX | An email account. |
| SM | The run coordinator. |
| OBX | The outbox. |
| PERSON | A person. |
| APPR | The approval bridge. |
"""

SMALL = """```mermaid
flowchart TB
  A["One"]
  B["Two"]
  A --> B
```

| Name | What it means |
|---|---|
| A | The first thing. |
| B | The second thing. |
"""

ER = """```mermaid
erDiagram
  RUN {
    uuid run_id
  }
  CONVERSATION {
    uuid conversation_id
  }
  CONVERSATION ||..o{ RUN : "joined in code"
```

The database declares no foreign key, so every relationship is unenforced.

| Name | What it means |
|---|---|
| RUN | One pass over one ticket. |
| CONVERSATION | One thread with one customer. |
"""


def write(root: str, path: str, text: str) -> None:
    full = os.path.join(root, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w") as handle:
        handle.write(text)


class Hung:
    """Stands in for a run that never returned, so the case can fail."""
    returncode = -1
    stdout = ""
    stderr = "the checker did not return within 60 seconds"


def git_env(root: str) -> dict[str, str]:
    """The environment a case runs git in, about its own root alone.

    A git hook exports where its repository is. This drops those names, and
    stops git's search for a repository at the root's parent.
    """
    env = {name: value for name, value in os.environ.items()
           if name not in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR")}
    env["GIT_CEILING_DIRECTORIES"] = os.path.dirname(os.path.abspath(root))
    return env


def run(root: str, check: str):
    env = git_env(root)
    try:
        return subprocess.run(
            [sys.executable, CHECKER, "--root", root, "--only", check],
            capture_output=True, text=True, timeout=60, env=env)
    except subprocess.TimeoutExpired:
        return Hung()


def case_diagrams_pass(root):
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
    return "diagrams", PASS, None


def case_undeclared_node(root):
    # TYPO is used in an edge and never declared. A parser accepts this and
    # silently mints an unlabelled node, so the checker must catch it.
    broken = GOOD_FLOW.replace("PERSON --> APPR", "PERSON --> TYPO")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'TYPO'"


def case_undeclared_node_behind_a_label(root):
    # The shipped map writes most edges as `X -->|"text"| Y`. A typo in the
    # target of a labelled edge is the likeliest real mistake, and it went
    # undetected until a mutation against the real document found it.
    broken = GOOD_FLOW.replace('"on approval only"| OBX', '"on approval only"| OBXX')
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'OBXX'"


def case_undeclared_node_behind_a_dotted_label(root):
    broken = GOOD_FLOW.replace(
        '"once configured"| MAILBOX', '"once configured"| NOWHERE')
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'NOWHERE'"


def case_configured_path_is_broken(root):
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
    return "configured-path", PASS, None


def case_configured_path_drawn_solid(root):
    # A solid line tells a reader that mail reaches a customer out of the box.
    # The default adapter holds fixtures and opens no connection, so it does
    # not.
    broken = GOOD_FLOW.replace(
        'SMTP -.->|"once configured"| MAILBOX', 'SMTP -->|"once configured"| MAILBOX')
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "configured-path", FAIL, "not drawn with a broken line"


def case_label_text_declares_nothing(root):
    # An edge label is prose. Text such as "call no adapter (DEC-34)" holds a
    # word followed by a bracket, which is also how a node is declared. The
    # reader must not meet a box called `adapter` that nobody drew.
    labelled = GOOD_FLOW.replace(
        "  SM --> ADAPT", '  SM -->|"park a draft (DEC-11), call no other adapter"| ADAPT')
    write(root, "docs/architecture-map.md", labelled + SMALL + ER)
    return "legends", PASS, None


def case_er_relationship_typo_fails(root):
    # An entity diagram joins with cardinality, not with an arrow. A typo on
    # either side of it must still surface.
    broken = ER.replace("CONVERSATION ||..o{ RUN", "CONVERSATION ||..o{ RUNN")
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + broken)
    return "diagrams", FAIL, "undeclared node 'RUNN'"


def case_unbalanced_subgraph(root):
    broken = GOOD_FLOW.replace("  end\n", "", 1)
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "subgraph"


def case_wrong_fence_count(root):
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL)
    return "diagrams", FAIL, "wants 3 diagrams"


def case_untagged_fence(root):
    # Three tagged diagrams stay, so the count rule is satisfied and only the
    # tag rule can catch the fourth fence. An untagged diagram renders as plain
    # text. An earlier version of this case untagged one of the three, and then
    # passed on the count finding with the tag rule deleted.
    extra = "```\nflowchart TB\n  Z[\"Zed\"]\n```\n\n| Name | What it means |\n|---|---|\n| Z | A stray. |\n"
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER + extra)
    return "diagrams", FAIL, "not mermaid"


def case_legends_pass(root):
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
    return "legends", PASS, None


def case_node_missing_from_legend(root):
    # SMTP is declared and drawn, but no legend row explains it. A reader with
    # no coding knowledge then meets a box the page never names.
    stripped = GOOD_FLOW.replace("| SMTP | The mail adapter. |\n", "")
    write(root, "docs/architecture-map.md", stripped + SMALL + ER)
    return "legends", FAIL, "no legend row"


def case_flow_edges_pass(root):
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
    return "flow-edges", PASS, None


def case_coordinator_reaches_person_directly(root):
    # This is the DEC-11 error the diagram exists to prevent: a parked draft
    # lands in the adapter, so the coordinator never reaches a person directly.
    # The park edge stays, so only the direct-edge rule can catch this. An
    # earlier version of this case replaced the park edge instead, and then
    # passed on the missing-park-edge finding with the DEC-11 rule deleted.
    broken = GOOD_FLOW.replace(
        "  SM --> ADAPT\n", "  SM --> ADAPT\n  SM --> PERSON\n")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "flow-edges", FAIL, "parks in the ledger (DEC-34)"


def case_park_edge_missing(root):
    broken = GOOD_FLOW.replace("  SM --> ADAPT\n", "")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "flow-edges", FAIL, "no park edge"


def case_adapter_never_reaches_person(root):
    # The draft lands in the adapter and stops there, so no person ever sees
    # it. The park edge stays, so only this rule can catch it.
    broken = GOOD_FLOW.replace("  ADAPT --> PERSON\n", "")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "flow-edges", FAIL, "no edge from 'ADAPT' to 'PERSON'"


def case_er_unenforced_pass(root):
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
    return "er-unenforced", PASS, None


def case_er_missing_disclaimer(root):
    # Without the sentence, the diagram asserts constraints the database does
    # not declare.
    quiet = ER.replace(
        "The database declares no foreign key, so every relationship is unenforced.\n",
        "")
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + quiet)
    return "er-unenforced", FAIL, "does not say the database declares no foreign key"


def case_er_cardinality_mints_no_phantom_node(root):
    # Mermaid writes cardinality as `||..o{`. A flowchart parser reading that
    # line finds `o{` and declares a node called `o`, which no legend names.
    # An entity diagram must be read as one, or every relationship line
    # invents a box.
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
    return "legends", PASS, None


def case_er_entity_missing_from_legend(root):
    # The entity parser must still find real entities, or the legend check
    # becomes vacuous on the entity diagram.
    stripped = ER.replace("| CONVERSATION | One thread with one customer. |\n", "")
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + stripped)
    return "legends", FAIL, "no legend row"


def case_links_pass(root):
    write(root, "docs/target.md", "# Target\n")
    write(root, "README.md", "See [the target](docs/target.md).\n")
    return "links", PASS, None


def case_dead_link(root):
    write(root, "README.md", "See [the target](docs/missing.md).\n")
    return "links", FAIL, "resolves nowhere"


def case_anchor_and_external_links_ignored(root):
    write(root, "README.md",
          "See [a section](#heading) and [a site](https://example.invalid/x).\n")
    return "links", PASS, None


def case_symlinked_markdown_is_skipped(root):
    # os.walk(followlinks=False) suppresses symlinked directories only. A
    # symlinked file is still yielded, and opening it follows the link. A
    # link to a character device never returns, and CI is a public runner
    # that a fork can reach.
    write(root, "README.md", "# Fine\n")
    os.symlink("/dev/zero", os.path.join(root, "trap.md"))
    return "links", PASS, None


def case_file_that_is_not_utf8(root):
    # A traceback is not a finding. The run must name the file and carry on.
    write(root, "README.md", "# Fine\n")
    with open(os.path.join(root, "bad.md"), "wb") as handle:
        handle.write(b"\xff\xfe# not utf-8\n")
    return "links", FAIL, "not UTF-8"


def case_unreadable_directory(root):
    # os.walk discards an OSError by default, so an unreadable subtree used to
    # vanish and the gate read clean.
    write(root, "README.md", "# Fine\n")
    write(root, "docs/sealed/x.md", "[gone](nowhere.md)\n")
    os.chmod(os.path.join(root, "docs/sealed"), 0o000)
    return "links", FAIL, "Permission denied"


def case_link_shown_in_a_fence_and_used_in_prose(root):
    # Removing a fence by string replacement deletes every copy of it, so the
    # prose copy went unchecked. Showing a link and then using it is ordinary.
    write(root, "README.md",
          "```\n[the guide](docs/missing.md)\n```\n\nSee [the guide](docs/missing.md).\n")
    return "links", FAIL, "resolves nowhere"


def case_no_markdown_at_all(root):
    # A checkout problem and a wrong root both read as a clean gate otherwise.
    os.makedirs(os.path.join(root, "empty"), exist_ok=True)
    return "links", FAIL, "nothing was checked"


def case_second_entity_diagram_without_the_sentence(root):
    # The check used to return after the first entity diagram.
    quiet = ER.replace(
        "The database declares no foreign key, so every relationship is unenforced.\n",
        "")
    write(root, "docs/architecture-map.md", GOOD_FLOW + ER + quiet)
    return "er-unenforced", FAIL, "does not say the database declares no foreign key"


def case_unterminated_fence(root):
    write(root, "docs/architecture-map.md",
          GOOD_FLOW + SMALL + ER + "```mermaid\nflowchart TB\n  A[\"x\"]\n")
    return "diagrams", FAIL, "never closes"


def case_no_diagram_to_judge(root):
    write(root, "docs/architecture-map.md", "# Empty\n")
    return "legends", FAIL, "no diagram to check legends against"


def case_register_grows_an_open_item(root):
    # The item count is read from section 7, not assumed. An eighth item with
    # no row must report.
    write(root, "docs/design/a-record.md", "x\n")
    grown = REGISTER_OK.replace("7. Seven.\n", "7. Seven.\n8. Eight.\n")
    write(root, "docs/v1-architecture.md", grown)
    return "design-index", FAIL, "no row for open item 8"


def case_section_71_inside_a_fence(root):
    # Splitting on the first occurrence anywhere read a fence as the table.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md",
          "```\n### 7.1 an example, not the table\n```\n\n" + REGISTER_OK)
    return "design-index", PASS, None


def case_configured_path_edge_missing(root):
    broken = "\n".join(
        l for l in GOOD_FLOW.split("\n") if "SMTP -.->" not in l)
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "configured-path", FAIL, "no edge from 'SMTP' to 'MAILBOX'"


def case_disclaimer_below_the_next_section(root):
    # The legend ends at the next section. A sentence further down the page
    # must not satisfy a rule about this diagram.
    quiet = ER.replace(
        "The database declares no foreign key, so every relationship is unenforced.\n",
        "")
    tail = "\n## Later\n\nThe database declares no foreign key.\n"
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + quiet + tail)
    return "er-unenforced", FAIL, "does not say the database declares no foreign key"


def case_map_that_cannot_be_read(root):
    # An unreadable file is a finding. Returning empty text instead would let
    # every rule about the map pass on a document nobody read.
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
    os.chmod(os.path.join(root, "docs/architecture-map.md"), 0o000)
    return "diagrams", FAIL, "Permission denied"


def case_configured_path_without_a_flow_diagram(root):
    # The twin guard in flow-edges has a case and this one did not, which is
    # the easiest kind of gap to miss by reading.
    renamed = GOOD_FLOW.replace("SM", "COORD")
    write(root, "docs/architecture-map.md", renamed + SMALL + ER)
    return "configured-path", FAIL, "no flow diagram declaring 'SM'"


def case_map_with_no_entity_diagram(root):
    # Both entity cases pinned the missing sentence. Neither removed the
    # diagram, so the rule that reports its absence went unguarded.
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + SMALL)
    return "er-unenforced", FAIL, "no erDiagram found"


def case_mermaid_comment_is_not_an_edge(root):
    # `%%` starts a Mermaid comment. Prose in one holds dashes, and a general
    # arrow pattern read them as edges to words nobody declared.
    noted = GOOD_FLOW.replace(
        "  SM --> ADAPT",
        "  %% the reviewer opens the draft -- see DEC-11\n  SM --> ADAPT")
    write(root, "docs/architecture-map.md", noted + SMALL + ER)
    return "diagrams", PASS, None


def case_legend_under_a_subheading(root):
    # A legend may sit under its own subheading. Bounding the legend at the
    # next heading of any level then hid it, and every box read as unnamed.
    titled = GOOD_FLOW.replace(
        "\n| Name | What it means |", "\n### Legend\n\n| Name | What it means |")
    write(root, "docs/architecture-map.md", titled + SMALL + ER)
    return "legends", PASS, None


def case_labelled_dotted_edge(root):
    # `A -. text .-> B` is Mermaid's dotted form with edge text. It must read
    # as one dotted arrow, not as two arrows around a word.
    labelled = GOOD_FLOW.replace(
        '  SMTP -.->|"once configured"| MAILBOX',
        "  SMTP -. once an adopter configures it .-> MAILBOX")
    write(root, "docs/architecture-map.md", labelled + SMALL + ER)
    return "configured-path", PASS, None


def case_labelled_solid_edge_is_not_dotted(root):
    labelled = GOOD_FLOW.replace(
        '  SMTP -.->|"once configured"| MAILBOX',
        "  SMTP -- once an adopter configures it --> MAILBOX")
    write(root, "docs/architecture-map.md", labelled + SMALL + ER)
    return "configured-path", FAIL, "not drawn with a broken line"


def case_labelled_edge_text_declares_nothing(root):
    labelled = GOOD_FLOW.replace(
        "  PERSON --> APPR", "  PERSON -- carries a draft --> APPRX")
    write(root, "docs/architecture-map.md", labelled + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'APPRX'"


def case_chain_keeps_its_middle_node(root):
    # `A --> B --> C` holds two edges. Reading the middle as edge text would
    # join A to C and lose B.
    chained = GOOD_FLOW.replace(
        "  ADAPT --> PERSON\n  PERSON --> APPR", "  ADAPT --> PERSON --> APPRX")
    write(root, "docs/architecture-map.md", chained + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'APPRX'"


def case_pipe_inside_a_quoted_label(root):
    # Stripping pipe labels before quoted text let a pipe inside a label
    # swallow the rest of the line, losing a declaration and an edge.
    piped = GOOD_FLOW.replace('SM["The run coordinator"]', 'SM["a | b"]')
    write(root, "docs/architecture-map.md", piped + SMALL + ER)
    return "flow-edges", PASS, None


def case_an_edge_with_no_target(root):
    # The fail-closed guard: a link form this checker cannot read must report
    # rather than vanish.
    broken = GOOD_FLOW.replace("  PERSON --> APPR", "  PERSON -->")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "unreadable link"


def case_inline_declaration_then_edge(root):
    # Mermaid lets one line declare a node and join it: `A["Alpha"] --> B`.
    # The shape brackets sat between the source and the arrow, so the pattern
    # matched nothing and the target was never compared against anything.
    broken = GOOD_FLOW.replace(
        "  PERSON --> APPR", '  PERSON(["A person"]) --> APPRX')
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'APPRX'"


def case_inline_declaration_on_the_target(root):
    broken = GOOD_FLOW.replace(
        "  SM --> ADAPT", '  SMX --> ADAPT["Adapters"]')
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'SMX'"


def case_circle_head_edge_reaches_a_person(root):
    # Mermaid draws a link many ways. `--o` is one, and an edge the pattern
    # does not recognise is never compared against any rule, so the checker
    # failed open on the rule it exists for.
    broken = GOOD_FLOW.replace("  ADAPT --> PERSON", "  SM --o PERSON\n  ADAPT --> PERSON")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "flow-edges", FAIL, "parks in the ledger (DEC-34)"


def case_long_arrow_to_an_undeclared_node(root):
    # `--->` is idiomatic Mermaid for rank spacing.
    broken = GOOD_FLOW.replace("  ADAPT --> PERSON", "  ADAPT ---> PERSONX")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'PERSONX'"


def case_cross_head_edge_to_an_undeclared_node(root):
    broken = GOOD_FLOW.replace("  PERSON --> APPR", "  PERSON --x APPRX")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'APPRX'"


def case_mail_path_solid_in_a_chain(root):
    # The rule decided dottedness per line. Any dotted arrow elsewhere on the
    # line satisfied it, so a solid mail path passed inside a chain.
    broken = GOOD_FLOW.replace(
        '  SMTP -.->|"once configured"| MAILBOX', "  SMTP --> MAILBOX -.-> HD")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "configured-path", FAIL, "not drawn with a broken line"


def case_unquoted_pipe_label_declares_nothing(root):
    # `strip_quoted` removed double-quoted text only, so an unquoted label
    # minted a phantom declaration and hid a real typo.
    broken = GOOD_FLOW.replace(
        "  SM --> ADAPT", "  SM -->|retrieve to ADAPTX[the box]| ADAPTX")
    write(root, "docs/architecture-map.md", broken + SMALL + ER)
    return "diagrams", FAIL, "undeclared node 'ADAPTX'"


def case_map_is_a_symlink_to_a_device(root):
    # `open()` on a FIFO blocks before `fstat` can run, so the two fixed
    # paths need the test before the open, not after it.
    os.makedirs(os.path.join(root, "docs"), exist_ok=True)
    os.symlink("/dev/zero", os.path.join(root, "docs/architecture-map.md"))
    return "diagrams", FAIL, "not a regular file"


def case_fence_tagged_something_else(root):
    # The map holds diagrams and nothing else. A fence tagged `sh` says which
    # tag it carries, so a reader does not hunt for a missing backtick.
    extra = "```sh\necho hi\n```\n"
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER + extra)
    return "diagrams", FAIL, "is tagged 'sh', not mermaid"


def case_dangling_fence_in_any_document(root):
    # A fence that never closes deletes the tail of a document from every
    # link check. A real design document in this repository carried one, and
    # 188 of its lines went unchecked while the gate read clean.
    write(root, "README.md",
          "# Title\n\n```sql\nSELECT 1;\n\nSee [gone](nowhere.md).\n")
    return "links", FAIL, "never closes"


def case_fence_with_an_attributed_info_string(root):
    # ```sh title="x" is an ordinary opener. Reading it as prose inverts the
    # parity, and the real closing fence then reads as an opener.
    write(root, "README.md",
          '# Title\n\n```sh title="run it"\necho hi\n```\n\nSee [gone](nowhere.md).\n')
    return "links", FAIL, "resolves nowhere"


def case_link_target_of_only_whitespace(root):
    # `[x](   )` used to raise IndexError, and findings print only after every
    # check completes, so one crash erased every finding before it.
    write(root, "README.md", "See [the guide](   ).\n")
    return "links", FAIL, "empty"


def case_no_section_7(root):
    write(root, "docs/v1-architecture.md", "# Register\n\n## 8. Something\n")
    return "design-index", FAIL, "no section 7 to read"


def case_section_7_lists_nothing(root):
    write(root, "docs/v1-architecture.md",
          "# Register\n\n## 7. Open items for V2\n\nNone yet.\n\n### 7.1 Where\n\n| A |\n|---|\n")
    return "design-index", FAIL, "lists no open item"


def case_open_items_are_not_a_run_from_one(root):
    write(root, "docs/v1-architecture.md",
          "# Register\n\n## 7. Open items for V2\n\n1. One.\n3. Three.\n\n### 7.1 Where\n\n| 1. One | none | x |\n| 3. Three | none | x |\n")
    return "design-index", FAIL, "is not a run from 1"


def case_no_section_71(root):
    write(root, "docs/v1-architecture.md",
          "# Register\n\n## 7. Open items for V2\n\n1. One.\n")
    return "design-index", FAIL, "no section 7.1 to read"


def case_diagram_declares_no_node(root):
    empty = "```mermaid\nflowchart TB\n```\n\n| Name | What it means |\n|---|---|\n"
    write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + empty)
    return "legends", FAIL, "declares no node"


def case_document_too_large_to_be_prose(root):
    write(root, "docs/architecture-map.md", "x" * 2_000_001)
    return "diagrams", FAIL, "not prose"


def case_no_flow_diagram(root):
    # Every rule that names the coordinator needs the diagram that declares it.
    renamed = GOOD_FLOW.replace("SM", "COORD")
    write(root, "docs/architecture-map.md", renamed + SMALL + ER)
    return "flow-edges", FAIL, "no flow diagram declaring 'SM'"


def case_design_index_pass(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", PASS, None


def case_design_index_missing_item(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n", ""))
    return "design-index", FAIL, "no row for open item 4"


def case_design_index_record_unnamed(root):
    # The reverse direction: a record the register never names is a record
    # nobody can find from the decision it serves.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/b-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/b-record.md is a design document section 7.1 does not name"


def case_design_index_record_generated_name(root):
    # A generated identifier tells a reader nothing about the record.
    name = "0123abcd-4567-89ab-cdef-0123456789ab.md"
    write(root, f"docs/design/{name}", "x\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        f"| 4. Clusters | `a-record.md` | blocked |\n| (none) | `{name}` | ratified |\n"))
    return "design-index", FAIL, f"docs/design/{name} has a name that says nothing"


def case_design_index_ignores_subdirectory(root):
    # A canvas or other folder under docs/design/ is no record.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/console-canvas/README.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", PASS, None


def case_design_index_dir_unreadable(root):
    # docs/design is a file here, so it cannot be listed. The finding names
    # that, not a missing record for each row.
    write(root, "docs/design", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/: cannot read", "does not exist under"


def case_design_index_dir_missing(root):
    # No docs/design at all is one finding, not one for each row.
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/: does not exist", "names 'a-record.md'"


def case_design_index_names_record_in_folder(root):
    # A row may name a file inside a folder under docs/design.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/console-canvas/README.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        "| 4. Clusters | `a-record.md` | blocked |\n| (none) | `console-canvas/README.md` | ratified |\n"))
    return "design-index", PASS, None


def case_design_index_names_a_folder(root):
    # A row that names a folder names no record.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/notes.md/inner.txt", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        "| 4. Clusters | `a-record.md` | blocked |\n| (none) | `notes.md` | ratified |\n"))
    return "design-index", FAIL, "names 'notes.md', which does not exist"


def case_design_index_names_wrong_case(root):
    # A disk that ignores case finds `A-Record.md` for `a-record.md`. A checkout on a
    # disk that does not would not, so the name must match as written.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace("`a-record.md`", "`A-Record.md`"))
    return "design-index", FAIL, "names 'A-Record.md', which does not exist"


def case_design_index_named_uppercase_extension(root):
    # A row may name a record whose extension is upper case.
    write(root, "docs/design/a-record.MD", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace("`a-record.md`", "`a-record.MD`"))
    return "design-index", FAIL, "docs/design/a-record.MD has a name that says nothing", "does not name"


def case_design_index_ulid_name(root):
    name = "01ARZ3NDEKTSV4RRFFQ69G5FAV.md"
    write(root, f"docs/design/{name}", "x\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        f"| 4. Clusters | `a-record.md` | blocked |\n| (none) | `{name}` | ratified |\n"))
    return "design-index", FAIL, f"docs/design/{name} has a name that says nothing"


def case_design_index_date_name(root):
    # A name of digits and dashes says when, not what.
    name = "2026-10-08-1530.md"
    write(root, f"docs/design/{name}", "x\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        f"| 4. Clusters | `a-record.md` | blocked |\n| (none) | `{name}` | ratified |\n"))
    return "design-index", FAIL, f"docs/design/{name} has a name that says nothing"


def case_design_index_folder_named_md(root):
    # A folder whose name ends in .md is no document, and no folder the check
    # knows.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/notes.md/inner.txt", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/notes.md/ is a folder this check does not know"


def case_design_index_uppercase_generated(root):
    name = "0123ABCD-4567-89AB-CDEF-0123456789AB.md"
    write(root, f"docs/design/{name}", "x\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        f"| 4. Clusters | `a-record.md` | blocked |\n| (none) | `{name}` | ratified |\n"))
    return "design-index", FAIL, f"docs/design/{name} has a name that says nothing"


def case_design_index_short_hex_name(root):
    # The short id form the records once used is no name either.
    name = "0a1b2c3d.md"
    write(root, f"docs/design/{name}", "x\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        f"| 4. Clusters | `a-record.md` | blocked |\n| (none) | `{name}` | ratified |\n"))
    return "design-index", FAIL, f"docs/design/{name} has a name that says nothing"


def case_design_index_uppercase_extension(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/b-record.MD", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/b-record.MD is a design document section 7.1 does not name"


def case_design_index_names_absent_file(root):
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "does not exist"


def named_extra(root, name):
    """A register whose table names one more document, and that document."""
    write(root, f"docs/design/{name}", "x\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        f"| 4. Clusters | `a-record.md` | blocked |\n| (none) | `{name}` | ratified |\n"))


def case_design_index_row_through_a_file(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        "| 4. Clusters | `a-record.md` | blocked |\n| (none) | `a-record.md/inner.md` | ratified |\n"))
    return "design-index", FAIL, "names 'a-record.md/inner.md', which does not exist"


def case_design_index_row_with_dot_slash(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace("`a-record.md`", "`./a-record.md`"))
    return "design-index", PASS, None


def case_design_index_row_through_unreadable_folder(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/console-canvas/README.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `a-record.md` | blocked |\n",
        "| 4. Clusters | `a-record.md` | blocked |\n| (none) | `console-canvas/README.md` | ratified |\n"))
    os.chmod(os.path.join(root, "docs/design/console-canvas"), 0o000)
    return ("design-index", FAIL, "names 'console-canvas/README.md', which cannot be read",
            "which does not exist")


def case_design_index_unnamed_other_extension(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/b-record.markdown", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/b-record.markdown is a design document section 7.1 does not name"


def case_design_index_one_letter_word(root):
    named_extra(root, "z-2026.md")
    return "design-index", FAIL, "docs/design/z-2026.md has a name that says nothing"


def git_work_tree(root, ignore):
    """Make `root` a git work tree whose `.gitignore` holds `ignore`."""
    subprocess.run(["git", "init", "-q", root], check=True, env=git_env(root))
    write(root, ".gitignore", ignore)


def case_design_index_skips_dot_files(root):
    # A file browser writes .DS_Store into any folder it opens, and git
    # ignores it.
    git_work_tree(root, ".DS_Store\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/.DS_Store", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", PASS, None


def case_design_index_skips_ignored_swap_file(root):
    # An editor's swap file sits beside the document it edits.
    git_work_tree(root, ".*.sw?\n")
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/.a-record.md.swp", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", PASS, None


def case_design_index_skips_a_decomposed_ignored_name(root):
    # macOS can list a name decomposed, while .gitignore holds it composed,
    # and git there ignores the file. Elsewhere a name is its bytes, and git
    # does not.
    git_work_tree(root, "caf\u00e9.swp\n")
    write(root, "docs/design/a-record.md", "x\n")
    decomposed = unicodedata.normalize("NFD", "caf\u00e9.swp")
    write(root, "docs/design/" + decomposed, "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    if sys.platform == "darwin":
        return "design-index", PASS, None
    return "design-index", FAIL, f"docs/design/{decomposed} has a name that says nothing"


def case_design_index_follows_git_on_decomposed_names(root):
    # With core.precomposeunicode off, git does not compose a name, so a
    # decomposed file is not the composed one .gitignore names, on any disk.
    git_work_tree(root, "caf\u00e9.swp\n")
    subprocess.run(["git", "-C", root, "config", "core.precomposeunicode", "false"],
                   check=True, env=git_env(root))
    write(root, "docs/design/a-record.md", "x\n")
    decomposed = unicodedata.normalize("NFD", "caf\u00e9.swp")
    write(root, "docs/design/" + decomposed, "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, f"docs/design/{decomposed} has a name that says nothing"


def case_design_index_unset_setting_composes_nothing(root):
    # With the setting unset, git composes nothing, on macOS too.
    git_work_tree(root, "caf\u00e9.swp\n")
    subprocess.run(["git", "-C", root, "config", "--unset", "core.precomposeunicode"],
                   env=git_env(root))
    write(root, "docs/design/a-record.md", "x\n")
    decomposed = unicodedata.normalize("NFD", "caf\u00e9.swp")
    write(root, "docs/design/" + decomposed, "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, f"docs/design/{decomposed} has a name that says nothing"


def case_design_index_reads_an_unignored_dot_file(root):
    # Git ignores only what it is told to. Outside a work tree, nothing is.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/.DS_Store", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/.DS_Store is a design document section 7.1 does not name"


def case_design_index_dot_named_document(root):
    # A dot-named document is still a document, and git commits it.
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/.hidden-notes.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/.hidden-notes.md is a design document section 7.1 does not name"


def case_design_index_dot_named_other_file(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/.notes.txt", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/.notes.txt is a design document section 7.1 does not name"


def case_design_index_dot_folder(root):
    write(root, "docs/design/a-record.md", "x\n")
    write(root, "docs/design/.drafts/notes.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "docs/design/.drafts/ is a folder this check does not know"


def case_design_index_single_word_name(root):
    named_extra(root, "ledger.md")
    return "design-index", FAIL, "docs/design/ledger.md has a name that says nothing"


def case_design_index_cuid_name(root):
    named_extra(root, "cjld2cjxh0000qzrmn831i7rn.md")
    return "design-index", FAIL, "docs/design/cjld2cjxh0000qzrmn831i7rn.md has a name that says nothing"


def case_design_index_nanoid_name(root):
    named_extra(root, "V1StGXR8_Z5jdHi6B-myT.md")
    return "design-index", FAIL, "docs/design/V1StGXR8_Z5jdHi6B-myT.md has a name that says nothing"


def case_design_index_short_sha_name(root):
    named_extra(root, "0a1b2c3.md")
    return "design-index", FAIL, "docs/design/0a1b2c3.md has a name that says nothing"


def case_design_index_timestamp_name(root):
    named_extra(root, "20261008t153000z-2026-10-08.md")
    return "design-index", FAIL, "docs/design/20261008t153000z-2026-10-08.md has a name that says nothing"


# Section 2 defines the decisions, and section 7 lists the open items. One
# fixture carries both, because the blank `--only` case below runs every check
# against a single root and each of the two reads its own section.
REGISTER_OK = """## 2. Decision register

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-01 | The first decision | Something else |
| DEC-02 | The second decision | Something else |

## 7. Open items for V2

1. One.
2. Two. **Closed.**
3. Three. **Closed.**
4. Four.
5. Five.
6. Six. **Closed.**
7. Seven.

### 7.1 Where the V2 design documents live

| Item | Document | Status |
|---|---|---|
| 1. One | `a-record.md` | proposed |
| 2. Two | `a-record.md` | ratified |
| 3. Three | `a-record.md` | ratified |
| 4. Clusters | `a-record.md` | blocked |
| 5. Five | `a-record.md` | blocked |
| 6. Six | none | closed without one |
| 7. Seven | `a-record.md` | proposed |
"""



# A design record declares the decisions it cites. An archived record declares
# nothing, because the declaration did not exist when it was written.
RECORD = """# A change

## Decisions affected

Affects: DEC-01

DEC-01. The change ratifies it.
"""

ARCHIVED = """# A detail

## Decisions affected

None. DEC-01 and DEC-02 govern this work and neither changes.
"""


def write_decisions(root, record=RECORD, archived=ARCHIVED, register=None):
    write(root, "docs/v1-architecture.md", register or REGISTER_OK)
    write(root, "docs/decisions/a-record.md", record)
    write(root, "intent/archive/a-detail.md", archived)
    write(root, "intent/TEMPLATE.md", "# The template\n")


def case_decisions_pass(root):
    write_decisions(root)
    return "decisions", PASS, None


def case_record_citing_an_unknown_dec(root):
    write_decisions(root, record=RECORD.replace("Affects: DEC-01", "Affects: DEC-99"))
    return "decisions", FAIL, "declares DEC-99, which section 2 of docs/v1-architecture.md does not define"


def case_a_dec_defined_outside_section_2(root):
    # The rule names section 2. A row in a later section, or a DEC quoted in
    # prose, defines nothing — and a whole-document scan cannot tell the
    # difference. Without this case that scoping can be deleted and every
    # other case stays green.
    grown = REGISTER_OK + "\n## 9. Later\n\nDEC-77 was considered and rejected.\n"
    write_decisions(root, record=RECORD.replace("Affects: DEC-01", "Affects: DEC-77"),
                    register=grown)
    return "decisions", FAIL, "declares DEC-77, which section 2 of docs/v1-architecture.md does not define"


def case_record_declaring_none(root):
    # The phrase CONTRIBUTING.md tells an author to write for a change that
    # affects nothing. The rule this replaced admitted it.
    write_decisions(root, record=RECORD.replace("Affects: DEC-01", "Affects: none"))
    return "decisions", FAIL, "declares 'Affects: none', so it is not a design record"


def case_record_declaring_none_in_any_case(root):
    write_decisions(root, record=RECORD.replace("Affects: DEC-01", "Affects: NONE"))
    return "decisions", FAIL, "declares 'Affects: none', so it is not a design record"


def case_record_with_no_affects_line(root):
    # A record whose section is prose alone. This is every record written
    # before the declaration existed, so it must not read as clean.
    write_decisions(root, record=ARCHIVED.replace("None. ", "DEC-01 governs this, and "))
    return "decisions", FAIL, "names no 'Affects:' line under 'Decisions affected'"


def case_record_with_two_affects_lines(root):
    doubled = RECORD.replace("Affects: DEC-01", "Affects: DEC-01\nAffects: none")
    write_decisions(root, record=doubled)
    return "decisions", FAIL, "carries 2 'Affects:' lines"


def case_affects_naming_no_dec(root):
    write_decisions(root, record=RECORD.replace("Affects: DEC-01", "Affects: the composer"))
    return "decisions", FAIL, "which names no DEC"


def case_record_without_the_section(root):
    write_decisions(root, record="# A change\n\n## Problem\n\nNone stated.\n")
    return "decisions", FAIL, "no 'Decisions affected' section"


def case_record_in_a_subdirectory(root):
    # The style checker's glob reads one level. A record filed deeper would
    # leave both checks behind while looking filed.
    write_decisions(root)
    write(root, "docs/decisions/2026/hidden.md", RECORD.replace("Affects: DEC-01", "Affects: none"))
    return "decisions", FAIL, "design records sit directly in docs/decisions/"


def case_a_loose_record_left_in_intent(root):
    # The path the workflow named before this rule, so it is the habit a
    # contributor falls back into.
    write_decisions(root)
    write(root, "intent/a-change.md", RECORD)
    return "decisions", FAIL, "intent/ holds the template alone"


def case_a_live_record_misfiled_into_the_archive(root):
    write_decisions(root, archived=RECORD)
    return "decisions", FAIL, "declares 'Affects:', so it is a design record"


def case_the_archive_may_hold_prose_citing_decs(root):
    # 25 of the 35 archived records name DECs in their prose. The archive rule
    # reads the declaration alone, so none of them is a finding.
    write_decisions(root, archived=ARCHIVED.replace(
        "None. DEC-01", "None. DEC-01, DEC-02, DEC-99"))
    return "decisions", PASS, None


def case_no_design_records_at_all(root):
    # Fails closed. An empty directory must not read the same as a clean one.
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    write(root, "docs/decisions/README.md", "The design records live here.\n")
    write(root, "intent/TEMPLATE.md", "# The template\n")
    write(root, "intent/archive/a-detail.md", ARCHIVED)
    return "decisions", FAIL, "holds no design record"


def case_an_empty_archive_is_not_a_fault(root):
    # Asymmetric on purpose: the archive is frozen and may be emptied.
    write_decisions(root)
    os.remove(os.path.join(root, "intent/archive/a-detail.md"))
    return "decisions", PASS, None


def case_readme_is_not_a_record(root):
    write_decisions(root)
    write(root, "docs/decisions/README.md", "The design records live here.\n")
    write(root, "intent/archive/README.md", "Frozen records live here.\n")
    return "decisions", PASS, None


def case_register_that_defines_no_decision(root):
    write_decisions(root, register="## 2. Decision register\n\nNothing yet.\n")
    return "decisions", FAIL, "section 2 defines no decision to cite"


def case_declaration_inside_a_fence_is_not_one(root):
    # The template shows the shape in a fence. Reading a fenced example as the
    # real declaration would let every record inherit the template's answer.
    fenced = "# A change\n\n## Decisions affected\n\n```\nAffects: DEC-01\n```\n\nprose.\n"
    write_decisions(root, record=fenced)
    return "decisions", FAIL, "names no 'Affects:' line under 'Decisions affected'"


def case_a_three_digit_dec_is_read_whole(root):
    # `DEC-\d{2}` reads the first two digits of DEC-100 and reports a citation
    # nobody wrote. The register holds 43 today; this is the rule, not a bug
    # anyone can see yet.
    grown = REGISTER_OK.replace(
        "| DEC-02 | The second decision | Something else |",
        "| DEC-02 | The second decision | Something else |\n"
        "| DEC-100 | The hundredth decision | Something else |")
    write_decisions(root, record=RECORD.replace("Affects: DEC-01", "Affects: DEC-100"),
                    register=grown)
    return "decisions", PASS, None



# Two cases below deny access with a mode bit, and a mode bit never denies
# root. Cloud agents and CI containers commonly run as root, where those cases
# would assert a failure that cannot happen and pass for the wrong reason.
# They skip there instead. A skip is honest; a pass is not.
NEEDS_DENIAL = "needs-permission-denial"

# check_crash_guard, plus the four check_cli cases in main().
EXTRA_CASES = 5


def denies_permission() -> bool:
    """Whether a mode bit can actually deny this process."""
    getuid = getattr(os, "getuid", None)
    return getuid is None or getuid() != 0



# --- dec-range ---------------------------------------------------------

RANGE_REGISTER = """## 2. Decision register

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-01 | The first decision | Something else |
| DEC-02 | The second decision | Something else |
| DEC-03 | The third decision | Something else |
"""


def range_repo(root, readme):
    write(root, "docs/v1-architecture.md", RANGE_REGISTER)
    write(root, "README.md", readme)
    write(root, "CONTRIBUTING.md", "# Contributing\n")
    write(root, "AGENTS.md", "# Agents\n")
    # Every document in RANGE_DOCS, because an unreadable one is a finding:
    # the check fails closed rather than passing over a document it cannot
    # read.
    write(root, "docs/quick-map.md", "# Quick map\n")


def case_dec_range_matches(root):
    range_repo(root, "The register holds DEC-01 to DEC-03.\n")
    return "dec-range", PASS, None


def case_dec_range_stale(root):
    # The defect: README said DEC-42 while the register defined 43.
    range_repo(root, "The register holds DEC-01 to DEC-02.\n")
    return "dec-range", FAIL, "states DEC-01 to DEC-02"


def case_dec_count_stale(root):
    range_repo(root, "It holds 5 numbered decisions, DEC-01 to DEC-03.\n")
    return "dec-range", FAIL, "states 5 decisions"


def case_dec_count_matches(root):
    range_repo(root, "It holds 3 numbered decisions, DEC-01 to DEC-03.\n")
    return "dec-range", PASS, None


def case_dec_range_stated_nowhere(root):
    # Fail closed. A rename that stops every document stating the range would
    # otherwise pass by saying nothing at all.
    range_repo(root, "# Readme\n")
    return "dec-range", FAIL, "proved nothing"


def case_dec_range_in_a_fence(root):
    # A fenced example is not a claim. `prose_text` blanks it, like every
    # other check here.
    range_repo(root, "```\nDEC-01 to DEC-99\n```\n\nThe register holds DEC-01 to DEC-03.\n")
    return "dec-range", PASS, None


def case_dec_register_skips_a_number(root):
    # A gap makes any range false, and the register is what would carry it.
    range_repo(root, "The register holds DEC-01 to DEC-03.\n")
    write(root, "docs/v1-architecture.md", RANGE_REGISTER.replace(
        "| DEC-02 | The second decision | Something else |\n", ""))
    return "dec-range", FAIL, "skips DEC-02"


# --- script-index ------------------------------------------------------

def script_repo(root, scripts, runbook):
    write(root, "package.json", '{"scripts": ' + scripts + '}')
    write(root, "docs/operations.md", runbook)


def case_script_index_complete(root):
    script_repo(root, '{"build": "tsc", "seed-history": "node x.js"}',
                "Run `pnpm run build`, then `pnpm run seed-history`.\n")
    return "script-index", PASS, None


def case_script_index_missing(root):
    # The defect: `seed-history` was in the manifest and in no document.
    script_repo(root, '{"build": "tsc", "seed-history": "node x.js"}',
                "Run `pnpm run build`.\n")
    return "script-index", FAIL, "names no `pnpm run seed-history`"


def case_script_index_bare_word_is_not_a_command(root):
    # "build" is ordinary English. A substring rule counted every prose use of
    # it and reported a runbook that documented nothing.
    script_repo(root, '{"build": "tsc"}', "The build is incremental.\n")
    return "script-index", FAIL, "names no `pnpm run build`"


def case_script_index_accepts_the_short_spelling(root):
    # `pnpm test` is how the repository writes that one.
    script_repo(root, '{"test": "vitest run"}', "Run `pnpm test`.\n")
    return "script-index", PASS, None


def case_script_index_manifest_not_json(root):
    script_repo(root, '{"build": "tsc",}', "Run `pnpm run build`.\n")
    return "script-index", FAIL, "not JSON"


def case_script_index_no_scripts(root):
    write(root, "package.json", '{"name": "x"}')
    write(root, "docs/operations.md", "# Runbook\n")
    return "script-index", FAIL, "proved nothing"



def case_dec_range_wrapped_across_lines(root):
    # The claim the scan could not see. "DEC-01 to\nDEC-43" is one sentence a
    # line break split, and the quick map wraps exactly there — so a stale
    # range in it passed in silence.
    range_repo(root, "The register holds every decision, DEC-01 to\nDEC-02.\n")
    return "dec-range", FAIL, "states DEC-01 to DEC-02"


def case_dec_range_evasive_connector(root):
    # A fixed alternation of to|through|- let ordinary English through.
    range_repo(root, "The register holds DEC-01 up to DEC-02.\n")
    return "dec-range", FAIL, "states DEC-01 to DEC-02"


def case_dec_list_is_not_a_range(root):
    # "DEC-01, DEC-02" and "DEC-01 and DEC-02" name a pair. Reading either as a
    # span reported a false range in this repository's own quick map.
    range_repo(root, "It affects DEC-01, DEC-02.\n\nDEC-01 and DEC-02 hold.\n"
                     "The register holds DEC-01 to DEC-03.\n")
    return "dec-range", PASS, None


def case_dec_range_in_the_quick_map(root):
    # The fourth document, which this repository added and the scan did not
    # read. `AGENTS.md` states a range, so the fail-closed clause never fired.
    range_repo(root, "The register holds DEC-01 to DEC-03.\n")
    write(root, "docs/quick-map.md", "Holds every decision, DEC-01 to DEC-02.\n")
    return "dec-range", FAIL, "states DEC-01 to DEC-02"


def case_script_index_runbook_names_a_dropped_script(root):
    # The other direction. A runbook naming a command that no longer exists
    # sends a reader to a failure, and a script is deleted far more often than
    # the paragraph describing it.
    script_repo(root, '{"build": "tsc"}',
                "Run `pnpm run build`, then `pnpm run seed-history`.\n")
    return "script-index", FAIL, "names `pnpm run seed-history`"


def case_script_index_pnpm_subcommand_collision(root):
    # A script whose name collides with a pnpm subcommand passed undocumented,
    # because the setup section contains `pnpm install`.
    script_repo(root, '{"install": "node x.js"}', "Run `pnpm install` first.\n")
    return "script-index", FAIL, "names no `pnpm run install`"


def case_script_claim_runbook_says_the_console_ships_no_script(root):
    # The claim was true once and went stale. Every wording that could return it
    # is refused, because the console's own guard reads its source files and
    # never the runbook.
    script_repo(root, '{"build": "tsc"}',
                "The console ships no script. Run `pnpm run build`.\n")
    return "script-claim", FAIL, "claims the console ships no script"


def case_script_claim_wrapped_claim_fails(root):
    # The runbook is wrapped prose, so a returning claim can arrive with a
    # line break inside the phrase. The break sits before the last word, where
    # the shipped paragraph wraps.
    script_repo(root, '{"build": "tsc"}',
                "The console ships no\nJavaScript of its own. Run `pnpm run build`.\n")
    return "script-claim", FAIL, "claims the console ships no JavaScript"


def case_script_claim_sentence_initial_claim_fails(root):
    # This phrasing reads as a sentence of its own, so its ordinary spelling
    # capitalizes the first word. A case-sensitive match would read it as clean.
    script_repo(root, '{"build": "tsc"}',
                "There is no script to install. Run `pnpm run build`.\n")
    return "script-claim", FAIL, "claims there is no script"


def case_script_claim_clean_runbook_passes(root):
    script_repo(root, '{"build": "tsc"}',
                "The console ships one script, and no more. Run `pnpm run build`.\n")
    return "script-claim", PASS, None


MAP_REGISTER = """## 2. Decision register

| ID | Decision | Rejected alternatives |
|----|----------|----------------------|
| DEC-01 | The first decision | Something else |
| DEC-02 | The second decision | Something else |
| DEC-03 | The third decision | Something else |
"""


def map_repo(root, listed, rows=None):
    write(root, "docs/v1-architecture.md", MAP_REGISTER)
    body = rows if rows is not None else (
        "\n".join(f"| `dir{n}` | DEC-0{n} | `src/x.test.ts` | 1. Setup |" for n in (1, 2))
    )
    write(root, "docs/quick-map.md",
          "# Quick map\n\n| dir | Decisions | Key test | Runbook |\n|---|---|---|---|\n"
          + body + "\n\n## Decisions no row names\n\n" + listed
          + "\n\nProse below may mention DEC-01 freely.\n")


def case_map_coverage_matches(root):
    map_repo(root, "DEC-03.")
    return "map-coverage", PASS, None


def case_map_coverage_understates(root):
    # The defect: the map said two decisions appeared in no row. Four did.
    # Two rows, because one row is a table this check refuses to trust.
    map_repo(root, "DEC-03.", rows=(
        "| `dir1` | DEC-01 | `src/x.test.ts` | 1. Setup |\n"
        "| `dir2` | DEC-01 | `src/x.test.ts` | 1. Setup |"))
    return "map-coverage", FAIL, "DEC-02"


def case_map_coverage_names_a_covered_decision(root):
    map_repo(root, "DEC-02, DEC-03.")
    return "map-coverage", FAIL, "DEC-02"


def case_map_coverage_section_absent(root):
    write(root, "docs/v1-architecture.md", MAP_REGISTER)
    write(root, "docs/quick-map.md",
          "# Quick map\n\n| dir | Decisions | Key test | Runbook |\n|---|---|---|---|\n"
          + "\n".join(f"| `dir{n}` | DEC-0{n} | `src/x.test.ts` | 1. Setup |" for n in (1, 2, 3))
          + "\n")
    return "map-coverage", FAIL, "has no '## Decisions no row names' section"


def case_map_coverage_reads_no_rows(root):
    write(root, "docs/v1-architecture.md", MAP_REGISTER)
    write(root, "docs/quick-map.md", "# Quick map\n\nNo table here.\n")
    return "map-coverage", FAIL, "scanned nothing"


def rows_repo(root, rows, dirs, console=False):
    for name in dirs:
        write(root, f"src/{name}/index.ts", "export {};\n")
    if console:
        write(root, "console/src/main.ts", "export {};\n")
    write(root, "docs/quick-map.md",
          "# Quick map\n\n| Directory | Decisions | Key test | Runbook |\n|---|---|---|---|\n"
          + "\n".join(f"| `{name}` | none | `src/x.test.ts` | none |" for name in rows) + "\n")


def case_map_rows_match(root):
    rows_repo(root, ["alpha", "beta", "console"], ["alpha", "beta"], console=True)
    return "map-rows", PASS, None


def case_map_rows_miss_a_directory(root):
    # The defect: four source directories had no row, and nothing said so.
    rows_repo(root, ["alpha", "beta"], ["alpha", "beta", "gamma"])
    return "map-rows", FAIL, "gamma"


def case_map_rows_miss_the_console(root):
    rows_repo(root, ["alpha", "beta"], ["alpha", "beta"], console=True)
    return "map-rows", FAIL, "console"


def case_map_rows_name_a_removed_directory(root):
    rows_repo(root, ["alpha", "beta", "gone"], ["alpha", "beta"])
    return "map-rows", FAIL, "gone"


def case_map_rows_ignore_what_is_not_source(root):
    # A cache, a hidden directory and a leftover holding no source file are
    # not directories a reader can open in the map, so none needs a row.
    rows_repo(root, ["alpha"], ["alpha"])
    write(root, "src/__pycache__/x.pyc", "")
    write(root, "src/.cache/state.json", "{}\n")
    write(root, "src/leftover/run.actual.json", "{}\n")
    return "map-rows", PASS, None


def case_map_rows_count_source_below_the_top(root):
    # A directory whose only source sits in a subdirectory is still one a
    # reader opens.
    rows_repo(root, ["alpha"], ["alpha"])
    write(root, "src/deep/a/b/x.ts", "export {};\n")
    return "map-rows", FAIL, "deep"


def map_rows_extension_case(suffix):
    def case(root):
        # Each TypeScript extension makes a source directory on its own.
        rows_repo(root, ["alpha"], ["alpha"])
        write(root, f"src/only{suffix[1:]}/m{suffix}", "export {};\n")
        return "map-rows", FAIL, f"only{suffix[1:]}"
    return case


def case_map_rows_count_a_double_underscore_directory(root):
    # Only a hidden directory is skipped by name. A directory that opens with
    # two underscores and holds source needs a row like any other.
    rows_repo(root, ["alpha"], ["alpha"])
    write(root, "src/__fixtures__/x.ts", "export {};\n")
    return "map-rows", FAIL, "__fixtures__"


def case_map_rows_skip_a_hidden_directory_with_source(root):
    # A hidden directory is local state even when it holds source, so the map
    # needs no row for it.
    rows_repo(root, ["alpha"], ["alpha"])
    write(root, "src/.hidden/x.ts", "export {};\n")
    return "map-rows", PASS, None


def case_map_rows_read_an_unreadable_directory(root):
    # A subtree the walk cannot read is a fault to name, by its path from the
    # root, and not a directory with no source.
    rows_repo(root, ["alpha", "sealed"], ["alpha"])
    write(root, "src/sealed/inner/x.ts", "export {};\n")
    os.chmod(os.path.join(root, "src/sealed/inner"), 0o000)
    return ("map-rows", FAIL, "docs/quick-map.md: cannot read `src/sealed/inner`",
            "has a row for `sealed`")


def case_map_rows_read_only_unreadable_directories(root):
    # Every directory found and none read is not "no source directories".
    rows_repo(root, ["sealed"], [])
    write(root, "src/sealed/inner/x.ts", "export {};\n")
    os.chmod(os.path.join(root, "src/sealed/inner"), 0o000)
    return "map-rows", FAIL, "could not read the directories it found under src/"


def case_map_rows_read_an_unreadable_source_root(root):
    # An unreadable `src/` itself is a finding, not a crash of the check.
    rows_repo(root, ["alpha"], ["alpha"])
    os.chmod(os.path.join(root, "src"), 0o000)
    return "map-rows", FAIL, "docs/quick-map.md: cannot read `src`"


def case_map_rows_read_no_source_tree(root):
    # A tree with no `src/` at all is a scan that read nothing, not a match.
    write(root, "docs/quick-map.md",
          "# Quick map\n\n| Directory | Decisions | Key test | Runbook |\n|---|---|---|---|\n"
          "| `alpha` | none | `src/x.test.ts` | none |\n| `beta` | none | `src/x.test.ts` | none |\n")
    return "map-rows", FAIL, "no source directories"


# The repository's own licence file, so a case passes only on the full text.
with open(os.path.join(os.path.dirname(CHECKER), "..", "LICENSE")) as _handle:
    APACHE = _handle.read()

# The two lines that open the licence, and nothing else. GitHub detects no
# licence in this file, so neither may the check.
APACHE_HEADER_ONLY = """
                                 Apache License
                           Version 2.0, January 2004
"""

MIT = """MIT License

Copyright (c) 2026 Someone

Permission is hereby granted, free of charge, to any person obtaining a copy
"""

# The shape of the real file: comments after the list, then another map.
WORKSPACE = ("packages:\n  - '.'\n  - 'console'\n\n# Build scripts pnpm may run.\n#\n"
             "#   esbuild        vitest's bundler\nallowBuilds:\n  esbuild: true\n")


def licence_repo(root, licence=APACHE, root_pkg='{"license": "Apache-2.0"}',
                 console_pkg='{"license": "Apache-2.0"}', workspace=WORKSPACE):
    if licence is not None:
        write(root, "LICENSE", licence)
    write(root, "package.json", root_pkg)
    if console_pkg is not None:
        write(root, "console/package.json", console_pkg)
    if workspace is not None:
        write(root, "pnpm-workspace.yaml", workspace)


DEPENDABOT = """version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    cooldown:
      default-days: 2
    groups:
      minor-and-patch:
        update-types: [minor, patch]

  # The workflow actions.
  - package-ecosystem: github-actions
    directory: /
    cooldown:
      default-days: 1
"""


def case_cooldown_on_every_ecosystem_passes(root):
    write(root, ".github/dependabot.yml", DEPENDABOT)
    return "cooldown", PASS, None


def case_cooldown_missing_on_one_ecosystem_fails(root):
    # The plausible wrong version: a new ecosystem added without the wait, so
    # its updates land inside pnpm's one-day gate.
    write(root, ".github/dependabot.yml", DEPENDABOT + """
  - package-ecosystem: docker
    directory: /
""")
    return "cooldown", FAIL, ".github/dependabot.yml: docker waits no day before proposing an update"


def case_cooldown_of_zero_days_fails(root):
    write(root, ".github/dependabot.yml",
          DEPENDABOT.replace("default-days: 1", "default-days: 0"))
    return "cooldown", FAIL, "github-actions waits no day"


def case_cooldown_key_order_second_item_fails(root):
    # YAML keys come in any order. An item that opens with another key is
    # still an item, and its missing cooldown is still a finding.
    write(root, ".github/dependabot.yml", DEPENDABOT + """
  - directory: /
    package-ecosystem: docker
""")
    return "cooldown", FAIL, ".github/dependabot.yml: docker waits no day"


def case_cooldown_key_order_first_item_fails(root):
    write(root, ".github/dependabot.yml", """version: 2
updates:
  - directory: /
    package-ecosystem: docker
  - package-ecosystem: npm
    directory: /
    cooldown:
      default-days: 2
""")
    return "cooldown", FAIL, ".github/dependabot.yml: docker waits no day"


def case_cooldown_nested_under_groups_fails(root):
    # Dependabot reads `cooldown` at the item's own level only.
    write(root, ".github/dependabot.yml", """version: 2
updates:
  - package-ecosystem: npm
    directory: /
    groups:
      g:
        cooldown:
          default-days: 2
""")
    return "cooldown", FAIL, ".github/dependabot.yml: npm waits no day"


def case_cooldown_comment_at_column_zero_passes(root):
    write(root, ".github/dependabot.yml", """version: 2
updates:
  - package-ecosystem: npm
# A comment at the margin, inside the item.
    directory: /
    cooldown:
      default-days: 2
""")
    return "cooldown", PASS, None


def case_cooldown_flow_map_passes(root):
    write(root, ".github/dependabot.yml", """version: 2
updates:
  - package-ecosystem: npm
    directory: /
    cooldown: {default-days: 2, semver-major-days: 7}
""")
    return "cooldown", PASS, None


def case_cooldown_item_without_ecosystem_fails(root):
    write(root, ".github/dependabot.yml", DEPENDABOT + """
  - directory: /
""")
    return "cooldown", FAIL, ".github/dependabot.yml: cannot read the ecosystem of the item at line"


def case_cooldown_bare_dash_item_fails(root):
    # A dash alone on its line, with the keys indented below it, is an item.
    write(root, ".github/dependabot.yml", DEPENDABOT + """
  -
    package-ecosystem: docker
    directory: /
""")
    return "cooldown", FAIL, ".github/dependabot.yml: docker waits no day"


def case_cooldown_unreadable_line_fails_closed(root):
    # A line at the list's column that is not an item must not end the read
    # in silence, or every item after it goes unchecked.
    write(root, ".github/dependabot.yml", DEPENDABOT.replace(
        "\n  # The workflow actions.\n", "\n  not-an-item: x\n"))
    return "cooldown", FAIL, ".github/dependabot.yml: cannot read line"


def case_cooldown_file_missing_fails(root):
    return "cooldown", FAIL, ".github/dependabot.yml: missing"


def case_cooldown_no_ecosystem_fails(root):
    write(root, ".github/dependabot.yml", "version: 2\nupdates: []\n")
    return "cooldown", FAIL, ".github/dependabot.yml: names no ecosystem"


def case_licence_complete_passes(root):
    licence_repo(root)
    return "licence", PASS, None


def case_licence_file_missing(root):
    licence_repo(root, licence=None)
    return "licence", FAIL, "LICENSE: missing"


def case_licence_file_is_another_licence(root):
    # A LICENSE file alone proves nothing. MIT text in it would publish the
    # code under terms the owner did not choose.
    licence_repo(root, licence=MIT)
    return "licence", FAIL, "LICENSE: is not the Apache License 2.0"


def case_licence_workspace_package_lacks_field(root):
    # The plausible wrong version reads the root manifest alone. The console
    # is a package of its own, and a reader of its manifest sees no licence.
    licence_repo(root, console_pkg='{"name": "@auracle/console"}')
    return "licence", FAIL, "console/package.json: declares no license"


def case_licence_package_declares_another(root):
    licence_repo(root, root_pkg='{"license": "MIT"}')
    return "licence", FAIL, "package.json: declares 'MIT', not 'Apache-2.0'"


def case_licence_package_does_not_parse(root):
    licence_repo(root, console_pkg='{"license": ')
    return "licence", FAIL, "console/package.json: does not parse"


def case_licence_workspace_names_a_missing_package(root):
    # A package the workspace lists and the checker cannot read is a finding,
    # never a package that silently has no licence to check.
    licence_repo(root, console_pkg=None)
    return "licence", FAIL, "console/package.json: missing"


def case_licence_header_only_fails(root):
    licence_repo(root, licence=APACHE_HEADER_ONLY)
    return "licence", FAIL, "LICENSE: is not the Apache License 2.0"


def case_licence_altered_text_fails(root):
    # One word changed inside the terms is another licence.
    licence_repo(root, licence=APACHE.replace("perpetual", "temporary", 1))
    return "licence", FAIL, "LICENSE: is not the Apache License 2.0"


def case_licence_root_checked_when_the_list_omits_it(root):
    # pnpm always includes the workspace root, whatever the list says. A list
    # without '.' must not take the root manifest out of the check.
    licence_repo(root, root_pkg='{"private": true}', workspace="packages:\n  - 'console'\n")
    return "licence", FAIL, "package.json: declares no license"


def case_licence_no_workspace_file_checks_the_root(root):
    licence_repo(root, root_pkg='{"private": true}', console_pkg=None, workspace=None)
    return "licence", FAIL, "package.json: declares no license"


def case_licence_flow_style_list_is_refused(root):
    licence_repo(root, workspace="packages: ['.', 'console']\n")
    return "licence", FAIL, "pnpm-workspace.yaml: lists its packages in a form this check cannot read"


def case_licence_recursive_glob_is_read(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/**'\n")
    write(root, "pkgs/a/b/package.json", '{"private": true}')
    return "licence", FAIL, "pkgs/a/b/package.json: declares no license"


def case_licence_negated_entry_is_excluded(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/*'\n  - '!pkgs/skip'\n")
    write(root, "pkgs/one/package.json", '{"license": "Apache-2.0"}')
    write(root, "pkgs/skip/package.json", '{"private": true}')
    return "licence", PASS, None


def case_licence_glob_matching_nothing_fails(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'nowhere/*'\n")
    return "licence", FAIL, "pnpm-workspace.yaml: 'nowhere/*' matches no package"


def case_licence_exclusion_does_not_cross_a_directory(root):
    # In pnpm `*` stays inside one directory. `!pkgs/*` excludes pkgs/a and
    # keeps pkgs/a/b, so pkgs/a/b is still checked.
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/*'\n  - 'pkgs/*/*'\n  - '!pkgs/*'\n")
    write(root, "pkgs/a/package.json", '{"private": true}')
    write(root, "pkgs/a/b/package.json", '{"private": true}')
    return "licence", FAIL, "pkgs/a/b/package.json: declares no license"


def case_licence_recursive_exclusion_reaches_any_depth(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/**'\n  - '!**/test/**'\n")
    write(root, "pkgs/one/package.json", '{"license": "Apache-2.0"}')
    write(root, "pkgs/test/package.json", '{"private": true}')
    return "licence", PASS, None


def case_licence_node_modules_is_never_a_package(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/**'\n")
    write(root, "pkgs/a/package.json", '{"license": "Apache-2.0"}')
    write(root, "pkgs/a/node_modules/dep/package.json", '{"name": "dep"}')
    return "licence", PASS, None


def case_licence_bower_components_is_never_a_package(root):
    # pnpm ignores bower_components as it ignores node_modules.
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/**'\n")
    write(root, "pkgs/a/package.json", '{"license": "Apache-2.0"}')
    write(root, "pkgs/a/bower_components/x/package.json", '{"name": "x"}')
    return "licence", PASS, None


def unreadable_item_repo(root, item):
    # An item the parser cannot read must not end the list in silence: every
    # package after it would go unchecked and the run would report clean.
    licence_repo(root, workspace=f"packages:\n  - '.'\n  {item}\n  - 'b'\n", console_pkg=None)
    write(root, "b/package.json", '{"private": true}')


def case_licence_bare_dash_fails_closed(root):
    unreadable_item_repo(root, "-")
    return "licence", FAIL, "pnpm-workspace.yaml: cannot read the package list item '-'"


def case_licence_empty_item_fails_closed(root):
    unreadable_item_repo(root, "- ''")
    return "licence", FAIL, "cannot read the package list item \"- ''\""


def case_licence_text_after_quote_fails_closed(root):
    unreadable_item_repo(root, "- 'it''s'")
    return "licence", FAIL, "cannot read the package list item \"- 'it''s'\""


def case_licence_later_package_still_checked(root):
    # The item after an unreadable one is still read and checked.
    unreadable_item_repo(root, "-")
    return "licence", FAIL, "b/package.json: declares no license"


def case_licence_zero_indent_list_is_read(root):
    # pnpm accepts a block list whose dashes start in column 0.
    licence_repo(root, workspace="packages:\n- '.'\n- console\n", console_pkg='{"private": true}')
    return "licence", FAIL, "console/package.json: declares no license"


def case_licence_quoted_hash_is_part_of_the_path(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'x#y'\n", console_pkg=None)
    write(root, "x#y/package.json", '{"private": true}')
    return "licence", FAIL, "x#y/package.json: declares no license"


def case_licence_manifest_not_an_object_fails(root):
    licence_repo(root, console_pkg='["license", "Apache-2.0"]')
    return "licence", FAIL, "console/package.json: is not a JSON object"


def case_licence_rider_after_the_terms_fails(root):
    # A clause appended after the terms is another licence, whatever the terms
    # say. Only the appendix template may follow them.
    licence_repo(root, licence=APACHE + "\nCommons Clause: you may not sell the Software.\n")
    return "licence", FAIL, "LICENSE: the text after the terms is not the published appendix"


def case_licence_filled_appendix_is_named(root):
    # The copyright line belongs in NOTICE. The appendix stays the template,
    # so no text an adopter writes into it can change the terms.
    licence_repo(root, licence=APACHE.replace("[yyyy]", "2026").replace(
        "[name of copyright owner]", "Synapti"))
    return "licence", FAIL, "LICENSE: the text after the terms is not the published appendix"


def rider_in_the_copyright_line(root, owner):
    # A rider written as the owner's name is still a rider.
    licence_repo(root, licence=APACHE.replace("[yyyy] [name of copyright owner]", owner))
    return "licence", FAIL, "LICENSE: the text after the terms is not the published appendix"


def case_licence_comma_rider_fails(root):
    return rider_in_the_copyright_line(root, "2026 Synapti, and the Software may not be sold")


def case_licence_licensed_under_rider_fails(root):
    return rider_in_the_copyright_line(
        root, "2026 Synapti. Licensed under these terms for non-commercial use only")


def case_licence_empty_package_list(root):
    licence_repo(root, workspace="packages:\n\nallowBuilds:\n  esbuild: true\n")
    return "licence", FAIL, "pnpm-workspace.yaml: lists no packages, so only the root manifest is checked"


def case_licence_workspace_byte_order_mark_is_read(root):
    licence_repo(root, workspace="\ufeff" + WORKSPACE, console_pkg='{"private": true}')
    return "licence", FAIL, "console/package.json: declares no license"


def case_licence_terms_without_appendix_pass(root):
    # The appendix is guidance for an adopter, and a file may leave it out.
    end = APACHE.index("END OF TERMS AND CONDITIONS") + len("END OF TERMS AND CONDITIONS")
    licence_repo(root, licence=APACHE[:end] + "\n")
    return "licence", PASS, None


def case_licence_crlf_passes(root):
    # A Windows checkout writes CRLF. Binary mode, because `write` would
    # translate the line endings back.
    licence_repo(root)
    with open(os.path.join(root, "LICENSE"), "wb") as handle:
        handle.write(APACHE.replace("\n", "\r\n").encode())
    return "licence", PASS, None


def case_licence_yaml_tag_item_fails_closed(root):
    # In YAML `- !!str console` is the string "console", not an exclusion.
    # The check cannot read an unquoted item that opens with a YAML
    # indicator. So the item is a finding, not a guess.
    licence_repo(root, workspace="packages:\n  - '.'\n  - !!str console\n",
                 console_pkg='{"private": true}')
    return "licence", FAIL, "cannot read the package list item '- !!str console'"


def case_licence_unquoted_exclusion_fails_closed(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - console\n  - !console\n")
    return "licence", FAIL, "cannot read the package list item '- !console'"


def case_licence_exclusion_matching_nothing_fails(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - console\n  - '!nowhere'\n")
    return "licence", FAIL, "pnpm-workspace.yaml: '!nowhere' matches no package"


def case_licence_byte_order_mark_is_read(root):
    licence_repo(root, licence="\ufeff" + APACHE)
    return "licence", PASS, None


def case_licence_workspace_glob_is_read(root):
    licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/*'\n")
    write(root, "pkgs/one/package.json", '{"license": "Apache-2.0"}')
    write(root, "pkgs/two/package.json", '{"private": true}')
    return "licence", FAIL, "pkgs/two/package.json: declares no license"


CASES = [
    ("a cooldown on every ecosystem passes", case_cooldown_on_every_ecosystem_passes),
    ("an ecosystem with no cooldown fails", case_cooldown_missing_on_one_ecosystem_fails),
    ("a cooldown of zero days fails", case_cooldown_of_zero_days_fails),
    ("a missing Dependabot file fails", case_cooldown_file_missing_fails),
    ("an item opening with another key is read", case_cooldown_key_order_second_item_fails),
    ("a first item opening with another key is read", case_cooldown_key_order_first_item_fails),
    ("a cooldown nested under groups does not count", case_cooldown_nested_under_groups_fails),
    ("a comment at the margin keeps the item", case_cooldown_comment_at_column_zero_passes),
    ("a flow-style cooldown is read", case_cooldown_flow_map_passes),
    ("an item with no ecosystem fails", case_cooldown_item_without_ecosystem_fails),
    ("a bare-dash item is read", case_cooldown_bare_dash_item_fails),
    ("an unreadable line in the list fails closed", case_cooldown_unreadable_line_fails_closed),
    ("a Dependabot file naming no ecosystem fails", case_cooldown_no_ecosystem_fails),
    ("a licence and a field in every package passes", case_licence_complete_passes),
    ("a missing licence file fails", case_licence_file_missing),
    ("a licence file holding another licence fails", case_licence_file_is_another_licence),
    ("a workspace package with no licence field fails",
     case_licence_workspace_package_lacks_field),
    ("a package declaring another licence fails", case_licence_package_declares_another),
    ("a package manifest that does not parse fails", case_licence_package_does_not_parse),
    ("a workspace package with no manifest fails",
     case_licence_workspace_names_a_missing_package),
    ("a workspace glob is expanded", case_licence_workspace_glob_is_read),
    ("a licence file holding only the heading fails", case_licence_header_only_fails),
    ("a licence file with altered terms fails", case_licence_altered_text_fails),
    ("the root is checked when the list omits it",
     case_licence_root_checked_when_the_list_omits_it),
    ("no workspace file means the root alone", case_licence_no_workspace_file_checks_the_root),
    ("a flow-style package list is refused", case_licence_flow_style_list_is_refused),
    ("a recursive glob reaches nested packages", case_licence_recursive_glob_is_read),
    ("a negated entry excludes its package", case_licence_negated_entry_is_excluded),
    ("a glob matching nothing fails", case_licence_glob_matching_nothing_fails),
    ("an exclusion does not cross a directory",
     case_licence_exclusion_does_not_cross_a_directory),
    ("a recursive exclusion reaches any depth",
     case_licence_recursive_exclusion_reaches_any_depth),
    ("node_modules is never a workspace package",
     case_licence_node_modules_is_never_a_package),
    ("a byte-order mark does not change the licence", case_licence_byte_order_mark_is_read),
    ("CRLF line endings do not change the licence", case_licence_crlf_passes),
    ("a YAML-tagged item fails closed", case_licence_yaml_tag_item_fails_closed),
    ("an unquoted exclusion fails closed", case_licence_unquoted_exclusion_fails_closed),
    ("an exclusion matching nothing fails", case_licence_exclusion_matching_nothing_fails),
    ("a bare dash fails closed", case_licence_bare_dash_fails_closed),
    ("an empty item fails closed", case_licence_empty_item_fails_closed),
    ("text after a closing quote fails closed", case_licence_text_after_quote_fails_closed),
    ("a package after an unreadable item is still checked",
     case_licence_later_package_still_checked),
    ("a zero-indent list is read", case_licence_zero_indent_list_is_read),
    ("a quoted # is part of the path", case_licence_quoted_hash_is_part_of_the_path),
    ("a manifest that is not an object fails", case_licence_manifest_not_an_object_fails),
    ("a rider after the terms fails", case_licence_rider_after_the_terms_fails),
    ("a filled-in appendix is named", case_licence_filled_appendix_is_named),
    ("the terms without the appendix pass", case_licence_terms_without_appendix_pass),
    ("a rider after a comma fails", case_licence_comma_rider_fails),
    ("a rider that says Licensed under fails", case_licence_licensed_under_rider_fails),
    ("an empty package list checks the root alone", case_licence_empty_package_list),
    ("a byte-order mark in the workspace file is read",
     case_licence_workspace_byte_order_mark_is_read),
    ("bower_components is never a workspace package",
     case_licence_bower_components_is_never_a_package),
    ("a stated DEC range that matches the register passes", case_dec_range_matches),
    ("a range split by a line break is still read", case_dec_range_wrapped_across_lines),
    ("an evasive range connector is still read", case_dec_range_evasive_connector),
    ("a list of decisions is not a range", case_dec_list_is_not_a_range),
    ("a stale range in the quick map fails", case_dec_range_in_the_quick_map),
    ("a runbook naming a dropped script fails",
     case_script_index_runbook_names_a_dropped_script),
    ("a script colliding with a pnpm subcommand fails",
     case_script_index_pnpm_subcommand_collision),
    ("a runbook claiming the console ships no script fails",
     case_script_claim_runbook_says_the_console_ships_no_script),
    ("a runbook whose claim a line break splits fails",
     case_script_claim_wrapped_claim_fails),
    ("a sentence-initial claim is read like any other",
     case_script_claim_sentence_initial_claim_fails),
    ("a runbook that claims no such thing passes",
     case_script_claim_clean_runbook_passes),
    ("a quick map whose uncovered list is right passes", case_map_coverage_matches),
    ("a quick map that understates what it omits fails", case_map_coverage_understates),
    ("a quick map naming a covered decision fails",
     case_map_coverage_names_a_covered_decision),
    ("a quick map with no uncovered section fails", case_map_coverage_section_absent),
    ("a quick map with no rows fails", case_map_coverage_reads_no_rows),
    ("a quick map with a row for every directory passes", case_map_rows_match),
    ("a quick map that misses a directory fails", case_map_rows_miss_a_directory),
    ("a quick map that misses the console fails", case_map_rows_miss_the_console),
    ("a quick map that names a removed directory fails", case_map_rows_name_a_removed_directory),
    ("a quick map ignores directories that hold no source", case_map_rows_ignore_what_is_not_source),
    ("a quick map misses source below the top of a directory", case_map_rows_count_source_below_the_top),
    ("a quick map misses a directory of .tsx source", map_rows_extension_case(".tsx")),
    ("a quick map misses a directory of .mts source", map_rows_extension_case(".mts")),
    ("a quick map misses a directory of .cts source", map_rows_extension_case(".cts")),
    ("a quick map needs no row for a hidden directory with source", case_map_rows_skip_a_hidden_directory_with_source),
    ("a quick map misses a double-underscore directory that holds source", case_map_rows_count_a_double_underscore_directory),
    ("a quick map names a source directory it cannot read", case_map_rows_read_an_unreadable_directory, NEEDS_DENIAL),
    ("a quick map whose every directory is unreadable says so", case_map_rows_read_only_unreadable_directories, NEEDS_DENIAL),
    ("a quick map over an unreadable src names it", case_map_rows_read_an_unreadable_source_root, NEEDS_DENIAL),
    ("a quick map over no source tree fails", case_map_rows_read_no_source_tree),
    ("a stale DEC range fails", case_dec_range_stale),
    ("a stale DEC count fails", case_dec_count_stale),
    ("a DEC count that matches passes", case_dec_count_matches),
    ("a range stated in no document fails", case_dec_range_stated_nowhere),
    ("a DEC range inside a fence is not a claim", case_dec_range_in_a_fence),
    ("a register that skips a number fails", case_dec_register_skips_a_number),
    ("a runbook naming every script passes", case_script_index_complete),
    ("a script named in no document fails", case_script_index_missing),
    ("a bare word is not a documented command",
     case_script_index_bare_word_is_not_a_command),
    ("the short pnpm spelling counts", case_script_index_accepts_the_short_spelling),
    ("a manifest that is not JSON fails", case_script_index_manifest_not_json),
    ("a manifest with no scripts fails", case_script_index_no_scripts),
    ("three tagged fences with declared nodes pass", case_diagrams_pass),
    ("an edge to an undeclared node fails", case_undeclared_node),
    ("a labelled edge to an undeclared node fails",
     case_undeclared_node_behind_a_label),
    ("a dotted labelled edge to an undeclared node fails",
     case_undeclared_node_behind_a_dotted_label),
    ("an entity relationship typo fails", case_er_relationship_typo_fails),
    ("an unbalanced subgraph fails", case_unbalanced_subgraph),
    ("the wrong number of diagrams fails", case_wrong_fence_count),
    ("an untagged fence fails", case_untagged_fence),
    ("every node explained in a legend passes", case_legends_pass),
    ("a node missing from the legend fails", case_node_missing_from_legend),
    ("the configured mail path stays broken", case_configured_path_is_broken),
    ("a solid mail path fails", case_configured_path_drawn_solid),
    ("label text declares no node", case_label_text_declares_nothing),
    ("entity cardinality mints no phantom node",
     case_er_cardinality_mints_no_phantom_node),
    ("an entity missing from the legend fails",
     case_er_entity_missing_from_legend),
    ("the park path through the adapter passes", case_flow_edges_pass),
    ("the coordinator reaching a person directly fails",
     case_coordinator_reaches_person_directly),
    ("a missing park edge fails", case_park_edge_missing),
    ("a draft that reaches no person fails", case_adapter_never_reaches_person),
    ("the unenforced sentence passes", case_er_unenforced_pass),
    ("an entity diagram with no disclaimer fails", case_er_missing_disclaimer),
    ("a link that resolves passes", case_links_pass),
    ("a symlinked document is skipped", case_symlinked_markdown_is_skipped),
    ("a document that is not UTF-8 is a finding", case_file_that_is_not_utf8),
    ("a link that resolves nowhere fails", case_dead_link),
    ("anchors and external links are ignored",
     case_anchor_and_external_links_ignored),
    ("an unreadable directory is a finding", case_unreadable_directory, NEEDS_DENIAL),
    ("a link shown in a fence and used in prose is checked",
     case_link_shown_in_a_fence_and_used_in_prose),
    ("a run that read nothing is a finding", case_no_markdown_at_all),
    ("a second entity diagram is checked too",
     case_second_entity_diagram_without_the_sentence),
    ("a fence that never closes fails", case_unterminated_fence),
    ("no diagram to judge is a finding", case_no_diagram_to_judge),
    ("an open item the register grew needs a row",
     case_register_grows_an_open_item),
    ("section 7.1 inside a fence is not the table",
     case_section_71_inside_a_fence),
    ("a missing mail edge fails", case_configured_path_edge_missing),
    ("a disclaimer below the next section does not count",
     case_disclaimer_below_the_next_section),
    ("a map that cannot be read is a finding", case_map_that_cannot_be_read, NEEDS_DENIAL),
    ("a missing flow diagram fails the mail rule",
     case_configured_path_without_a_flow_diagram),
    ("a map with no entity diagram fails", case_map_with_no_entity_diagram),
    ("a mermaid comment is not an edge", case_mermaid_comment_is_not_an_edge),
    ("a legend under a subheading is read", case_legend_under_a_subheading),
    ("a labelled dotted edge stays dotted", case_labelled_dotted_edge),
    ("a labelled solid mail path fails", case_labelled_solid_edge_is_not_dotted),
    ("labelled edge text declares no node",
     case_labelled_edge_text_declares_nothing),
    ("a chain keeps its middle node", case_chain_keeps_its_middle_node),
    ("a pipe inside a quoted label is not a label",
     case_pipe_inside_a_quoted_label),
    ("a design record and an archived record pass", case_decisions_pass),
    ("a record citing an unknown DEC fails", case_record_citing_an_unknown_dec),
    ("a DEC defined outside section 2 is not a definition",
     case_a_dec_defined_outside_section_2),
    ("a record declaring none fails", case_record_declaring_none),
    ("a record declaring NONE fails too", case_record_declaring_none_in_any_case),
    ("a record with no Affects line fails", case_record_with_no_affects_line),
    ("a record with two Affects lines fails", case_record_with_two_affects_lines),
    ("an Affects line naming no DEC fails", case_affects_naming_no_dec),
    ("a record without the section fails", case_record_without_the_section),
    ("a record in a subdirectory fails", case_record_in_a_subdirectory),
    ("a loose record left in intent/ fails", case_a_loose_record_left_in_intent),
    ("a live record misfiled into the archive fails",
     case_a_live_record_misfiled_into_the_archive),
    ("the archive may hold prose citing DECs",
     case_the_archive_may_hold_prose_citing_decs),
    ("no design record at all is a finding", case_no_design_records_at_all),
    ("an empty archive is not a fault", case_an_empty_archive_is_not_a_fault),
    ("a README is not a record", case_readme_is_not_a_record),
    ("a register defining no decision is a finding",
     case_register_that_defines_no_decision),
    ("a declaration inside a fence is not one",
     case_declaration_inside_a_fence_is_not_one),
    ("a three-digit DEC is read whole", case_a_three_digit_dec_is_read_whole),
    ("an edge with no target is a finding", case_an_edge_with_no_target),
    ("an inline declaration before an edge is read",
     case_inline_declaration_then_edge),
    ("an inline declaration after an edge is read",
     case_inline_declaration_on_the_target),
    ("a circle-head edge to a person is caught",
     case_circle_head_edge_reaches_a_person),
    ("a long arrow to an undeclared node fails",
     case_long_arrow_to_an_undeclared_node),
    ("a cross-head edge to an undeclared node fails",
     case_cross_head_edge_to_an_undeclared_node),
    ("a solid mail path inside a chain fails", case_mail_path_solid_in_a_chain),
    ("an unquoted pipe label declares no node",
     case_unquoted_pipe_label_declares_nothing),
    ("a map that is a device is a finding", case_map_is_a_symlink_to_a_device),
    ("a fence tagged something else names its tag",
     case_fence_tagged_something_else),
    ("a dangling fence in any document is a finding",
     case_dangling_fence_in_any_document),
    ("an attributed info string is still a fence",
     case_fence_with_an_attributed_info_string),
    ("a link target of only whitespace is a finding",
     case_link_target_of_only_whitespace),
    ("a register with no section 7 fails", case_no_section_7),
    ("a section 7 that lists nothing fails", case_section_7_lists_nothing),
    ("open items that skip a number fail", case_open_items_are_not_a_run_from_one),
    ("a register with no section 7.1 fails", case_no_section_71),
    ("a diagram that declares no node fails", case_diagram_declares_no_node),
    ("a document too large to be prose fails", case_document_too_large_to_be_prose),
    ("a map with no flow diagram fails", case_no_flow_diagram),
    ("a table accounting for every item passes", case_design_index_pass),
    ("an item missing from the table fails", case_design_index_missing_item),
    ("a table naming an absent file fails", case_design_index_names_absent_file),
    ("a record the table does not name fails", case_design_index_record_unnamed),
    ("a record with a generated name fails", case_design_index_record_generated_name),
    ("a folder under docs/design is no record", case_design_index_ignores_subdirectory),
    ("an unreadable design directory is named, once", case_design_index_dir_unreadable),
    ("a folder named like a record is a folder the check must know", case_design_index_folder_named_md),
    ("an upper-case generated name fails", case_design_index_uppercase_generated),
    ("a short hex name fails", case_design_index_short_hex_name),
    ("a document with an upper-case extension is read, and refused", case_design_index_uppercase_extension),
    ("a missing design directory is named, once", case_design_index_dir_missing),
    ("a row may name a record inside a folder", case_design_index_names_record_in_folder),
    ("a row that names a folder fails", case_design_index_names_a_folder),
    ("a row must name a record in its own case", case_design_index_names_wrong_case),
    ("a named upper-case extension still fails the name rule", case_design_index_named_uppercase_extension),
    ("a row through a file fails", case_design_index_row_through_a_file),
    ("a row written with ./ names the same document", case_design_index_row_with_dot_slash),
    ("an unreadable folder a row names through is named", case_design_index_row_through_unreadable_folder, NEEDS_DENIAL),
    ("a document the table does not name fails, whatever its extension", case_design_index_unnamed_other_extension),
    ("a single-word name fails", case_design_index_single_word_name),
    ("a dot-file a tool writes is no document", case_design_index_skips_dot_files),
    ("a swap file git ignores is no document", case_design_index_skips_ignored_swap_file),
    ("a dot-file git does not ignore is read", case_design_index_reads_an_unignored_dot_file),
    ("an ignored name the disk lists decomposed is no document", case_design_index_skips_a_decomposed_ignored_name),
    ("the lookup follows git's own setting for decomposed names", case_design_index_follows_git_on_decomposed_names),
    ("an unset setting composes no name", case_design_index_unset_setting_composes_nothing),
    ("a dot-named document still needs a row", case_design_index_dot_named_document),
    ("a dot-named file of another extension still needs a row", case_design_index_dot_named_other_file),
    ("a dot-named folder is still a folder the check must know", case_design_index_dot_folder),
    ("a name whose one word is a letter fails", case_design_index_one_letter_word),
    ("a cuid name fails", case_design_index_cuid_name),
    ("a nanoid name fails", case_design_index_nanoid_name),
    ("a short commit hash name fails", case_design_index_short_sha_name),
    ("a timestamp name fails", case_design_index_timestamp_name),
    ("a ULID name fails", case_design_index_ulid_name),
    ("a name of digits and dashes fails", case_design_index_date_name),
]


def check_crash_guard():
    """A check that raises must report, not erase every finding before it.

    No document can reach this, because every path is guarded. That is the
    point: the guard is the net under the unforeseen, so it is exercised
    against the module rather than through a file.
    """
    spec = importlib.util.spec_from_file_location("check_docs", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    def explode(root, findings):
        raise RuntimeError("boom")

    module.CHECKS = {"explode": explode}
    argv = sys.argv
    sys.argv = ["check-docs.py", "--only", "explode"]
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out):
            code = module.main()
    finally:
        sys.argv = argv
    text = out.getvalue()
    if code != 1:
        print(f"FAIL a check that raises reports: want exit 1, got {code}")
        return 1
    if "raised RuntimeError: boom" not in text:
        print(f"FAIL a check that raises reports: wanted the finding, got {text!r}")
        return 1
    print("pass a check that raises reports a finding")
    return 0


def check_cli(name, args, want, wanted_text):
    """One case that exercises the command line rather than a document."""
    root = args[args.index("--root") + 1] if "--root" in args else os.getcwd()
    got = subprocess.run([sys.executable, CHECKER, *args],
                         capture_output=True, text=True, timeout=60, env=git_env(root))
    output = (got.stdout + got.stderr).strip()
    if got.returncode != want:
        print(f"FAIL {name}: want exit {want}, got {got.returncode}")
        return 1
    if wanted_text and wanted_text not in output:
        print(f"FAIL {name}: wanted the output to say {wanted_text!r}")
        return 1
    return 0


def main() -> int:
    failures = 0
    skipped = 0
    for entry in CASES:
        name, build = entry[0], entry[1]
        needs = entry[2] if len(entry) > 2 else None
        if needs == NEEDS_DENIAL and not denies_permission():
            skipped += 1
            print(f"skip {name}: running as root, where a mode bit denies nothing")
            continue
        with tempfile.TemporaryDirectory() as root:
            # A case may name text the output must not hold, for a rule that
            # stops a finding rather than raising one.
            check, want, wanted_text, *rest = build(root)
            unwanted_text = rest[0] if rest else None
            got = run(root, check)
            output = (got.stdout + got.stderr).strip()
            if got.returncode != want:
                failures += 1
                print(f"FAIL {name}: want exit {want}, got {got.returncode}")
                print(output[:400])
            elif wanted_text and wanted_text not in output:
                # The case failed, and it failed for another reason. That is
                # how a rule stays deleted while its case still goes green.
                failures += 1
                print(f"FAIL {name}: wanted the finding to say {wanted_text!r}")
                print(output[:400])
            elif unwanted_text and unwanted_text in output:
                failures += 1
                print(f"FAIL {name}: the output must not say {unwanted_text!r}")
                print(output[:400])
    failures += check_crash_guard()

    # The command line is a contract too. An unknown name is a usage error and
    # not a finding, and a blank or repeated `--only` must not change what runs.
    with tempfile.TemporaryDirectory() as root:
        write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
        write(root, "docs/design/a-record.md", "x\n")
        write_decisions(root)
        # `dec-range` and `script-index` read four more files, and a root that
        # holds none of them reports rather than passing in silence. The
        # register here is the one `write_decisions` wrote, which defines two.
        write(root, "README.md", "The register holds DEC-01 to DEC-02.\n")
        write(root, "CONTRIBUTING.md", "# Contributing\n")
        write(root, "AGENTS.md", "# Agents\n")
        write(root, "package.json",
              '{"license": "Apache-2.0", "scripts": {"build": "tsc"}}')
        write(root, "LICENSE", APACHE)
        write(root, ".github/dependabot.yml", DEPENDABOT)
        write(root, "docs/operations.md", "Run `pnpm run build`.\n")
        write(root, "docs/quick-map.md",
              "| `a` | DEC-01 | `x.test.ts` | 1 |\n| `b` | DEC-02 | `x.test.ts` | 1 |\n"
              "\n## Decisions no row names\n\nnone.\n")
        # `map-rows` compares the rows with the source tree.
        write(root, "src/a/index.ts", "export {};\n")
        write(root, "src/b/index.ts", "export {};\n")
        failures += check_cli("an unknown check is a usage error",
                              ["--root", root, "--only", "nonsense"], 2,
                              "unknown check 'nonsense'")
        failures += check_cli("a blank --only runs every check",
                              ["--root", root, "--only", " , , "], 0,
                              "docs clean: 15 check(s)")
        failures += check_cli("a repeated --only runs once",
                              ["--root", root, "--only", "links,links,links"], 0,
                              "docs clean: 1 check(s)")

    # A checkout whose path holds a glob character must not change what a
    # workspace pattern matches.
    with tempfile.TemporaryDirectory(prefix="a[1]") as root:
        licence_repo(root, workspace="packages:\n  - '.'\n  - 'pkgs/*'\n", console_pkg=None)
        write(root, "pkgs/x/package.json", '{"private": true}')
        failures += check_cli("a bracket in the checkout path changes no match",
                              ["--root", root, "--only", "licence"], 1,
                              "pkgs/x/package.json: declares no license")

    # The crash guard and the four command-line cases run too, so counting
    # CASES alone undercounted every line below by five.
    total = len(CASES) + EXTRA_CASES
    if failures:
        print(f"\n{failures} of {total} case(s) failed")
        return 1
    # State the skip count. A run that reports only what passed reads the same
    # whether two cases were skipped or never existed.
    if skipped:
        print(f"check-docs: {total - skipped} case(s) pass, {skipped} skipped")
    else:
        print(f"check-docs: {total} case(s) pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
