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


def run(root: str, check: str):
    try:
        return subprocess.run(
            [sys.executable, CHECKER, "--root", root, "--only", check],
            capture_output=True, text=True, timeout=60)
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
    write(root, ".creatumo/design/aaa.md", "x\n")
    grown = REGISTER_OK.replace("7. Seven.\n", "7. Seven.\n8. Eight.\n")
    write(root, "docs/v1-architecture.md", grown)
    return "design-index", FAIL, "no row for open item 8"


def case_section_71_inside_a_fence(root):
    # Splitting on the first occurrence anywhere read a fence as the table.
    write(root, ".creatumo/design/aaa.md", "x\n")
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
    write(root, ".creatumo/design/aaa.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", PASS, None


def case_design_index_missing_item(root):
    write(root, ".creatumo/design/aaa.md", "x\n")
    write(root, "docs/v1-architecture.md", REGISTER_OK.replace(
        "| 4. Clusters | `aaa.md` | blocked |\n", ""))
    return "design-index", FAIL, "no row for open item 4"


def case_design_index_names_absent_file(root):
    write(root, "docs/v1-architecture.md", REGISTER_OK)
    return "design-index", FAIL, "does not exist"


REGISTER_OK = """## 7. Open items for V2

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
| 1. One | `aaa.md` | proposed |
| 2. Two | `aaa.md` | ratified |
| 3. Three | `aaa.md` | ratified |
| 4. Clusters | `aaa.md` | blocked |
| 5. Five | `aaa.md` | blocked |
| 6. Six | none | closed without one |
| 7. Seven | `aaa.md` | proposed |
"""

CASES = [
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
    ("an unreadable directory is a finding", case_unreadable_directory),
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
    ("a map that cannot be read is a finding", case_map_that_cannot_be_read),
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
    got = subprocess.run([sys.executable, CHECKER, *args],
                         capture_output=True, text=True, timeout=60)
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
    for name, build in CASES:
        with tempfile.TemporaryDirectory() as root:
            check, want, wanted_text = build(root)
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
    failures += check_crash_guard()

    # The command line is a contract too. An unknown name is a usage error and
    # not a finding, and a blank or repeated `--only` must not change what runs.
    with tempfile.TemporaryDirectory() as root:
        write(root, "docs/architecture-map.md", GOOD_FLOW + SMALL + ER)
        write(root, ".creatumo/design/aaa.md", "x\n")
        write(root, "docs/v1-architecture.md", REGISTER_OK)
        failures += check_cli("an unknown check is a usage error",
                              ["--root", root, "--only", "nonsense"], 2,
                              "unknown check 'nonsense'")
        failures += check_cli("a blank --only runs every check",
                              ["--root", root, "--only", " , , "], 0,
                              "docs clean: 7 check(s)")
        failures += check_cli("a repeated --only runs once",
                              ["--root", root, "--only", "links,links,links"], 0,
                              "docs clean: 1 check(s)")

    total = len(CASES)
    if failures:
        print(f"\n{failures} of {total} case(s) failed")
        return 1
    print(f"check-docs: {total} case(s) pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
