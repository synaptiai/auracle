#!/usr/bin/env python3
"""Cases for the STE checker. Run: python3 scripts/test_ste_check.py

Each case writes one temporary markdown file and asserts the exit code.
The list and table exclusions are policy, so they get cases of their own.
"""
import os
import subprocess
import sys
import tempfile

CHECKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ste-check.py")
PASS, FAIL = 0, 1

LONG = "word " * 25
SEVEN = " ".join(f"Sentence number {n} here." for n in range(7))

CASES = [
    ("short sentence passes", PASS, "The relay sends first.\n"),
    ("21 words breaks rule 1", FAIL, LONG.strip() + ".\n"),
    ("six sentences pass", PASS,
     " ".join(f"Line {n} is short." for n in range(6)) + "\n"),
    ("seven sentences break rule 2", FAIL, SEVEN + "\n"),
    # Front matter is metadata, not prose. No shipped file opens with it, but a
    # run that names a design document reads one, and its keys would read as
    # one 30-word sentence.
    ("front matter at the start is not prose", PASS,
     "---\ntitle: \"" + ("word " * 20).strip() + "\"\nauthor: code\n"
     + "tags: [a, b, c]\n---\n\nThe relay sends first.\n"),
    # Only at the start. A thematic break later in a document is a rule,
    # and the prose between two of them is prose.
    ("prose between two later rules still breaks rule 1", FAIL,
     "The relay sends first.\n\n---\n" + LONG.strip() + ".\n---\n"),
    ("a long sentence after front matter still breaks rule 1", FAIL,
     "---\ntitle: short\n---\n\n" + LONG.strip() + ".\n"),
    # A block that opens and never closes is not front matter, so its text
    # stays prose rather than vanishing from the check.
    ("an unclosed opening rule is not front matter", FAIL,
     "---\n" + LONG.strip() + ".\n"),
    # A block is front matter only when every line in it is a known key. A
    # blank line or a sentence ends it, so prose between an opening rule and a
    # later one stays prose, and a later pair of rules hides nothing.
    ("prose after a blank line under an opening rule is not front matter", FAIL,
     "---\n\n" + LONG.strip() + ".\n\n---\n"),
    ("front matter that runs into a blank line is not front matter", FAIL,
     "---\ntitle: x\n\n" + LONG.strip() + ".\n\n---\n"),
    ("a later pair of rules after real front matter hides nothing", FAIL,
     "---\ntitle: short\n---\n\nShort.\n\n---\n\n" + LONG.strip() + ".\n\n---\n"),
    # Front matter holds metadata keys alone. Prose between two rules is prose,
    # with or without a key above it and with no blank line anywhere.
    ("prose between an opening rule and its closer is not front matter", FAIL,
     "---\n" + LONG.strip() + ".\n---\n\nShort.\n"),
    ("a key line does not make the prose under it metadata", FAIL,
     "---\ntitle: x\n" + LONG.strip() + ".\n---\n"),
    ("a later rule with no blank line hides nothing after front matter", FAIL,
     "---\ntitle: b\n---\n" + LONG.strip() + ".\n---\n"),
    ("an unknown key is not front matter", FAIL,
     "---\nnote: " + LONG.strip() + ".\n---\n"),
    # Only at the very start. A block further down is a rule and prose, and the
    # prose above it is never dropped.
    ("front matter below prose is not front matter", FAIL,
     LONG.strip() + ".\n\n---\ntitle: x\n---\n"),
    ("front matter below prose with no blank line is not front matter", FAIL,
     LONG.strip() + ".\n---\ntitle: x\n---\n"),
    # A block that never closes is not front matter, even at the end of a file.
    ("a key line that never closes is prose", FAIL,
     "---\ntitle: " + LONG.strip() + "."),
    # A key is a key only with its colon. A sentence that opens with a key word
    # is prose.
    ("a line that only opens with a key word is prose", FAIL,
     "---\ntitle: x\ntags are " + LONG.strip() + ".\n---\n"),
    # A byte-order mark is not text. Front matter after one is still metadata.
    ("front matter after a byte-order mark is not prose", PASS,
     "\ufeff---\ntitle: \"" + ("word " * 20).strip() + "\"\n---\n\nThe relay sends first.\n"),
    # Rule 2 is prose only. A procedure of seven steps is legal.
    ("seven numbered steps pass", PASS,
     "\n".join(f"{n}. Step {n} runs." for n in range(1, 8)) + "\n"),
    ("seven bullets pass", PASS,
     "\n".join(f"- Point {n} holds." for n in range(1, 8)) + "\n"),
    ("seven table rows pass", PASS,
     "| A | B |\n|---|---|\n" + "\n".join(f"| r{n} | v{n} |" for n in range(7)) + "\n"),
    # A long sentence still counts inside a list or a table cell.
    ("long sentence in a list breaks rule 1", FAIL, f"- {LONG.strip()}.\n"),
    ("long sentence in a table cell breaks rule 1", FAIL,
     f"| A | B |\n|---|---|\n| x | {LONG.strip()}. |\n"),
    # A fence holds code, and code is not prose.
    ("code fence is ignored", PASS, f"```\n{LONG}\n```\n"),
    ("inline code counts as one word", PASS,
     "The file `src/coordinator/coordinator.ts` holds it.\n"),
    # Issue #117. Code drops out exactly where a markdown reader sees code.
    # Each case below was a shape where pairing markers across the whole file
    # hid prose a reader sees, or read code a reader sees as prose.
    ("a tilde fence is ignored", PASS, f"~~~\n{LONG}\n~~~\n"),
    ("backticks inside a sentence open no fence", FAIL,
     "Type ``` to open one.\n\n" + LONG.strip() + ".\n\n```\ncode\n```\n"),
    ("stray backticks in two paragraphs hide nothing", FAIL,
     "A stray ` here.\n\n" + LONG.strip() + ".\n\n" + SEVEN + "\n\nAnother ` here.\n"),
    # A fence that never closes hides nothing. A reader of the rendered page
    # sees code to the end, but a fence left open is a slip, and the prose
    # after it is what the writer meant a reader to see.
    ("an unclosed fence line pairs with no later backtick", FAIL,
     "```\n" + LONG.strip() + " with `x` here.\n"),
    ("a line that is not a closing fence pairs with no fence", FAIL,
     "```\n" + LONG.strip() + ".\n``` trailing\n"),
    ("an unclosed fence hides nothing", FAIL, "```\n" + LONG.strip() + ".\n"),
    ("an escaped backtick opens no span", FAIL,
     "An escaped \\` mark.\n" + LONG.strip() + " and `code`.\n"),
    # A table is one GitHub draws: a header, then a delimiter row. Its rows
    # and cells are units, so a span never crosses either.
    ("a code span never crosses two table rows", FAIL,
     "| h | i |\n|---|---|\n| `a | " + LONG.strip() + ". |\n| b` | c |\n"),
    ("a code span never crosses two cells of one row", FAIL,
     "| h | i | j |\n|---|---|---|\n| `a | " + LONG.strip() + ". | b` |\n"),
    # Pipe lines with no delimiter row are paragraph text to a reader, so a
    # span runs across them.
    ("pipe lines with no delimiter row are paragraph text", PASS,
     "Intro `x\n| not a table " + LONG.strip() + "\nwords y` z.\n"),
    ("a delimiter row with no header is paragraph text", FAIL,
     "|---|\n| a |\n    " + LONG.strip() + ".\n"),
    ("a delimiter row that does not match its header is paragraph text", FAIL,
     "| a | b |\n|---|\n    " + LONG.strip() + ".\n"),
    ("an empty row is no delimiter", FAIL, "Intro\n| |\n    " + LONG.strip() + ".\n"),
    # A table may interrupt a paragraph: its last line is the header.
    ("a table under a paragraph takes only its last line", FAIL,
     SEVEN + "\n| a | b |\n|---|---|\n| c | d |\n"),
    ("a table without outer pipes is a table", PASS,
     "a | b\n--|--\n" + ("word " * 12).strip() + " | " + ("word " * 12).strip() + "\n"),
    # Every line under a table is a row until a blank line or another block.
    ("a line under a table is a row", PASS,
     "| a | b |\n|---|---|\n" + ("word " * 12).strip() + " | " + ("word " * 12).strip() + "\n"),
    ("a line of one pipe ends a table", FAIL,
     "| a |\n|---|\n| b |\n|\n" + SEVEN + "\n"),
    ("a row's cells past its header are not drawn", PASS,
     "| a |\n|---|\n| b | " + LONG.strip() + ". |\n"),
    ("a delimiter row needs no pipe", FAIL,
     "alpha `x\n:-:\n" + LONG.strip() + " y`\n"),
    ("a lone tag ends a table", FAIL, "| a |\n|---|\n| b |\n<span>\n" + SEVEN + "\n"),
    ("a footnote is a unit of its own", PASS,
     " ".join(f"Line {n} is short." for n in range(4)) + "\n[^1]: Note one. Note two. Note three.\n\nRef[^1].\n"),
    ("a footnote ends a table", FAIL, "| a |\n|---|\n| b |\n[^1]: " + SEVEN + "\n\nRef[^1].\n"),
    ("a header of one pipe opens no table", FAIL, "|\n|---|\n" + SEVEN + "\n"),
    ("a delimiter that fails in a paragraph rules out a later table", FAIL,
     "a | b\n|---|\n" + ("word " * 12).strip() + "\n| - |\n" + ("word " * 12).strip() + ".\n"),
    ("a table in a list item is a table", PASS,
     "- | a | b |\n  |---|---|\n  | " + ("word " * 12).strip() + " | " + ("word " * 12).strip() + " |\n"),
    ("a code span never crosses two list items", FAIL,
     "- `a " + LONG.strip() + ".\n- b` c\n"),
    ("a span that starts in a heading never wraps", FAIL,
     "# Heading `x\n" + LONG.strip() + " y`.\n"),
    ("a code span that wraps onto the next line is one term", PASS,
     "Run `pnpm\nrun fit-groundedness` first.\n"),
    ("a fence between a list item and a paragraph keeps them apart", FAIL,
     "- A point.\n```\ncode\n```\n" + SEVEN + "\n"),
    ("a fence between a table and a wrapped sentence keeps them apart", FAIL,
     "| A | B |\n|---|---|\n| a | b |\n```\ncode\n```\n"
     + ("word " * 13).strip() + "\n" + ("word " * 13).strip() + ".\n"),
    ("a fence between two paragraphs is no sentence of its own", PASS,
     ("word " * 12).strip() + "\n```\ncode\n```\n" + ("word " * 12).strip() + "\n"),
    ("three inline backticks pair with no single backtick", FAIL,
     "Inline ```a``` here, then " + LONG.strip() + " and a stray ` mark.\n"),
    ("a double-backtick span holding a backtick is one term", PASS,
     "Write ``a ` b`` to show one.\n"),
    # From the CommonMark rules for a code span. A run closes only on a run of
    # the same length, and a backslash inside a span is a literal character.
    ("runs of different lengths pair with nothing", FAIL,
     "A `stray run, then " + LONG.strip() + " and ``x``.\n"),
    ("a backslash inside a span does not escape its closer", FAIL,
     "Run `a\\` then " + LONG.strip() + " with a stray ` mark.\n"),
    # From the CommonMark rules for a fence. It closes on a run of its own
    # character at least as long as the one that opened it, and on nothing
    # else.
    ("a longer closing run closes a fence", PASS,
     "````\n" + LONG.strip() + ".\n``````\nShort.\n"),
    ("a shorter run inside a fence is code", PASS,
     "````\n```\n" + LONG.strip() + ".\n````\n"),
    # A backtick line inside a tilde fence is code. Read as a closer, it would
    # end the fence there, and the text under it would be measured as prose.
    ("a tilde fence does not close on backticks", PASS,
     "~~~\n```\n" + LONG.strip() + ".\n~~~\n"),
    ("a backtick fence whose info holds a backtick is no fence", FAIL,
     "``` a`b\n" + LONG.strip() + ".\n```\n"),
    ("a fence inside a list item is code", PASS,
     "- Run it:\n\n  ```sh\n  " + LONG.strip() + ".\n  ```\n"),
    # A fence and indented code end where their container ends: a block
    # quote, or a list item. Read by file, a fence opened in a quote ran past
    # it and hid the prose after it.
    ("a fence in a quote ends with the quote", FAIL,
     "> ```sh\n> code\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a fence in a list item ends with the item", FAIL,
     "- item\n  ```sh\n  code\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a fence that ends with its item is code", PASS,
     "- item\n  ```\n  " + LONG.strip() + ".\n- next\n"),
    ("a quoted fence line inside a fence is code", FAIL,
     "```md\n> ```\n> quoted\n```\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a fence opened on a list marker is code", PASS,
     "- ```sh\n  " + LONG.strip() + ".\n  ```\n"),
    ("a fence opened on a list marker closes inside the item", FAIL,
     "1. ```sh\n   echo\n   ```\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    # Four columns of indent make indented code or paragraph text, never a
    # fence line.
    ("an indented fence line opens no fence", FAIL,
     "Para.\n\n    ```\n    code\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("an indented fence line inside a paragraph opens no fence", FAIL,
     "Some text\n    ```\n" + LONG.strip() + ".\n```\n"),
    ("an indented fence line inside a fence is code", FAIL,
     "```md\n    ```\n```\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("indented code is code", PASS, "Para.\n\n    " + LONG.strip() + ".\n"),
    ("indented text that continues a paragraph is prose", FAIL,
     ("word " * 12).strip() + "\n    " + ("word " * 12).strip() + ".\n"),
    # A setext heading is a heading, and a span never leaves one.
    ("a span that starts in a setext heading never wraps", FAIL,
     "Title `a\n=====\n" + LONG.strip() + " b` end.\n"),
    # Raw HTML and an autolink bind as tightly as a code span, so a backtick
    # inside one opens nothing.
    ("a backtick inside an HTML tag opens no span", FAIL,
     "Open <a title=\"`\">x</a> then " + LONG.strip() + " and `code` here.\n"),
    ("a backtick inside an autolink opens no span", FAIL,
     "See <https://example.com/a`b> then " + LONG.strip() + " and `code` here.\n"),
    ("a backtick inside a processing instruction opens no span", FAIL,
     "A <?x ` ?> then " + LONG.strip() + " and `code` here.\n"),
    # What may start a block, taken from CommonMark. An ordered item interrupts
    # a paragraph only when it counts from 1, so a year that opens a wrapped
    # line is the paragraph's next line, and its sentences still count.
    ("an ordered item that is not 1 does not interrupt a paragraph", FAIL,
     "We counted the items in\n2. ```\n   " + LONG.strip() + ".\nand so is this\n"),
    ("a year that opens a wrapped line is not a list", FAIL,
     "Sentence 0 here. Sentence 1 here. Sentence 2 here. It ends in\n"
     "2026. Sentence 4 here. Sentence 5 here. Sentence 6 here.\n"),
    ("a heading is never a lazy line", PASS,
     "> Quote para.\n# Heading\n    " + LONG.strip() + "\n"),
    ("a rule is never a lazy line", PASS,
     "- item\n***\n  ```\n  a\n\n" + LONG.strip() + "\n  ```\n"),
    ("indented code may follow a rule", PASS, "Para.\n\n***\n    " + LONG.strip() + "\n"),
    ("indented code may follow a setext heading", PASS,
     "Title\n-----\n    " + LONG.strip() + "\n"),
    ("a spaced rule is not three list items", PASS, "Para.\n\n- - -\n    " + LONG.strip() + "\n"),
    ("a setext heading in a quote is its own unit", FAIL,
     "> Title `a\n> ---\n> " + LONG.strip() + " b` end.\n"),
    ("a setext heading in a list item is its own unit", FAIL,
     "- Title `a\n  ---\n  " + LONG.strip() + " b` end.\n"),
    ("an underline on a lazy line is paragraph text", PASS,
     "- item `a\n" + LONG.strip() + "\n===\nmore b` end\n"),
    ("an indented heading is its own unit", FAIL,
     "Text ` open\n  # Head\n" + LONG.strip() + " ` close.\n"),
    # A quote that opens or closes ends a unit, and so does a lone `>`.
    ("a span never pairs into a quote", FAIL,
     "Text ` open.\n> " + LONG.strip() + " ` close.\n"),
    ("a lone quote marker is a paragraph break", FAIL,
     "> A ` open.\n>\n> " + LONG.strip() + " ` close.\n"),
    ("a span never pairs from one item into the next", FAIL,
     "1. a ` b\n1) " + LONG.strip() + " ` c\n"),
    # An item that opens empty ends at a blank line under it.
    ("an empty item ends at a blank line", PASS, "1)\n\n    " + LONG.strip() + ".\n"),
    # One parser decides the units. A second reader downstream, matching the
    # lines again, split a paragraph at a marker the block pass had read as
    # paragraph text, and read a whole block as a table.
    ("a quoted marker in an indented continuation line splits nothing", FAIL,
     "Sentence 0 here. Sentence 1 here. Sentence 2 here. And\n"
     "    > 1. Sentence 3 here. Sentence 4 here. Sentence 5 here. Sentence 6 here.\n"),
    ("the prose beside a table is still prose", FAIL,
     SEVEN + "\n| A | B |\n|---|---|\n| a | b |\n"),
    ("a long sentence wrapped above a table still breaks rule 1", FAIL,
     ("word " * 12).strip() + "\n" + ("word " * 12).strip() + ".\n| A |\n|---|\n| a |\n"),
    # An HTML block is not parsed: a fence line inside one opens no fence.
    ("a fence line inside an HTML block opens no fence", FAIL,
     "<div>\n```\n</div>\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a fence line inside a comment block opens no fence", FAIL,
     "<!--\n```\n-->\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a backtick inside an inline comment pairs with nothing outside it", FAIL,
     "A <!-- ` --> then " + LONG.strip() + " and a stray ` mark.\n"),
    ("a backtick in a link destination opens no span", FAIL,
     "A [b](u`v) then " + LONG.strip() + " and a stray ` mark.\n"),
    # With no `[` before it, `](` is text, and the span it holds is a span.
    ("a bracket with no link text is no link", PASS,
     "A ](u`v) then " + LONG.strip() + " and a stray ` mark.\n"),
    ("a span never pairs across a table row", FAIL,
     "A `x\n| a |\n|---|\n" + LONG.strip() + " y` z.\n"),
    ("an HTML block is never a lazy line", FAIL,
     "> A `x\n<div>\n" + LONG.strip() + " y` z.\n"),
    # An empty item's marker never labels the unit after its list.
    ("prose after a lone empty item is still a paragraph", FAIL, "-\n" + SEVEN + "\n"),
    ("a quote after a lone empty item is still a paragraph", FAIL, "-\n> " + SEVEN + "\n"),
    # A row is not paragraph text.
    # A pipe line with no delimiter row is not yet a table to a reader, so
    # the line under it continues the paragraph.
    ("a pipe line with no delimiter continues a paragraph", FAIL,
     "Intro text\n| not a table\n    " + LONG.strip() + ".\n"),
    ("an ordered line under a pipe line continues the paragraph", FAIL,
     "Intro text\n| not a table\n2. " + SEVEN + "\n"),
    # A quote opened in a waiting item is the item's first block.
    ("a quote that opens an item is the item's own", PASS, "-\n  > " + SEVEN + "\n"),
    ("a lone quote marker keeps the item waiting", PASS, "-\n  >\n  > " + SEVEN + "\n"),
    ("a quote on the marker line keeps the item waiting", PASS, "- >\n  >\n  > " + SEVEN + "\n"),
    ("a blank line after an empty item ends it", FAIL, "-\n\n" + SEVEN + "\n"),
    ("text past a quote in a waiting item is a paragraph", FAIL, "-\n  >\n  " + SEVEN + "\n"),
    ("a block tag ends at a blank line", PASS, "<div>\n\n~~~\n" + LONG.strip() + "\n~~~\n"),
    ("a lazy line never joins a table row", FAIL,
     "> | A |\n> |---|\nlazy `x\n> " + LONG.strip() + " y` z.\n"),
    ("indented code may follow a table row", PASS, "| A |\n|---|\n    " + LONG.strip() + "\n"),
    # An HTML block: how it starts, what ends it, and what it holds.
    ("a lone tag does not interrupt a paragraph", PASS,
     "para `x\n<span>\n" + LONG.strip() + " y`\n"),
    ("an HTML block ends with its container", FAIL,
     "> <div> `x\n" + LONG.strip() + " y` z.\n"),
    ("a comment on one line ends on that line", PASS,
     "<!-- a -->\n\n~~~\n" + LONG.strip() + ".\n~~~\n"),
    ("a blank line inside a comment ends a unit", PASS,
     "<!--\nOne. Two. Three.\n\nFour. Five. Six. Seven.\n-->\n"),
    ("a long comment still answers to rule 2", FAIL, "<!-- " + SEVEN + " -->\n"),
    # Past a blank line, too: a textarea ends on its closing tag alone.
    ("a fence line inside a textarea opens no fence", FAIL,
     "<textarea>\n\n```\n</textarea>\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a fence line inside a processing instruction opens no fence", FAIL,
     "<?x\n```\n?>\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a fence line inside a declaration opens no fence", FAIL,
     "<!X\n```\n>\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),
    ("a fence line inside a CDATA section opens no fence", FAIL,
     "<![CDATA[\n```\n]]>\n\n" + LONG.strip() + ".\n\n```\nx\n```\n"),

    # One case for each rule a review found unguarded.
    # A lazy line holds no marker: the span opened above it closes in it.
    ("a lazy marker line stays in its paragraph", PASS,
     "> A `x " + LONG.strip() + "\n    - B` y.\n"),
    ("an item that counts from 1 interrupts a paragraph", FAIL,
     "alpha `x\n1. " + LONG.strip() + " beta` y\n"),
    ("an item counting from 01 interrupts a paragraph", FAIL,
     "alpha `x\n01. " + LONG.strip() + " beta` gamma\n"),
    # A lone `-` under a paragraph is no empty item: it underlines a
    # heading, so the span opened above it pairs with nothing below.
    ("a lone dash under a paragraph is an underline, not an item", FAIL,
     "alpha `x\n-\n" + LONG.strip() + " beta` y\n"),
    ("a quote opened in an item is not the quote after it", FAIL,
     "1) > a `x\n> " + LONG.strip() + " b` c\n"),
    # A `1)` item is an item: its entries are not a paragraph's sentences.
    ("seven items marked 1) pass", PASS,
     "1) " + " ".join(f"Point {n} holds." for n in range(7)) + "\n"),
    # Two paragraphs of six sentences are not one paragraph of twelve.
    ("blank line separates paragraphs", PASS,
     " ".join(f"Line {n} is short." for n in range(6)) + "\n\n"
     + " ".join(f"Line {n} is short." for n in range(6)) + "\n"),
    ("heading is its own unit", PASS,
     "# Title\n" + " ".join(f"Line {n} is short." for n in range(6)) + "\n"),
    # Rule 1 measures a sentence, and every document here wraps near 80
    # columns. Measured line by line, a wrapped sentence is two short
    # fragments and the rule enforces nothing.
    ("a sentence wrapped across lines is one sentence", FAIL,
     "word " * 12 + "\n" + "word " * 13 + "end.\n"),
    ("a wrapped sentence under the limit still passes", PASS,
     "word " * 8 + "\n" + "word " * 8 + "end.\n"),
    # A unit is a paragraph, a list item or a table cell. Lines join inside
    # one and never across one, so neither case below may be merged.
    ("a wrapped list item is one sentence", FAIL,
     "- " + "word " * 12 + "\n  " + "word " * 13 + "end.\n"),
    ("two short list items are not one sentence", PASS,
     "- " + "word " * 14 + "end.\n- " + "word " * 14 + "end.\n"),
    ("two short table cells are not one sentence", PASS,
     "| A | B |\n|---|---|\n| " + "word " * 14 + "end. | " + "word " * 14 + "end. |\n"),
    ("two short table rows are not one sentence", PASS,
     "| A |\n|---|\n| " + "word " * 14 + "end. |\n| " + "word " * 14 + "end. |\n"),
    # Without the full stops. A cell rarely ends in one, and a merge of two
    # cells that each end in one still splits into two sentences — so the two
    # cases above passed against a version that merged a whole table block.
    ("unterminated cells are not one sentence", PASS,
     "| A | B |\n|---|---|\n| " + ("word " * 12).strip() + " | " + ("word " * 12).strip() + " |\n"),
    ("unterminated list items are not one sentence", PASS,
     "- " + ("word " * 12).strip() + "\n- " + ("word " * 12).strip() + "\n"),
    # A full stop inside a bold lead-in ends a sentence. The period sits
    # before the closing marker and not before the space, so the split saw no
    # boundary and merged the lead-in with the sentence after it.
    ("a bold lead-in ends a sentence", PASS,
     "**" + ("word " * 12).strip() + ".** " + ("word " * 12).strip() + ".\n"),
    ("a bold lead-in that is itself too long still breaks rule 1", FAIL,
     "**" + ("word " * 21).strip() + ".** Short tail.\n"),
    # No boundary without the space. An emphasised word mid-sentence must not
    # end one, or a 30-word sentence reads as two short ones.
    ("emphasis inside a sentence is not a boundary", FAIL,
     ("word " * 10).strip() + " **" + ("word " * 5).strip() + "** " + ("word " * 8).strip() + ".\n"),
    # Rule 2 reads the prose that opens a block. `is_list` is true for the
    # whole block, so a paragraph of any length passed as long as a bullet
    # followed it with no blank line between them.
    ("seven sentences break rule 2 even when a list follows", FAIL,
     SEVEN + "\n- One bullet.\n- Another bullet.\n"),
    ("a list with a short lead-in still passes", PASS,
     "Two rules apply here. Both are short.\n"
     + "\n".join(f"- Point {n} holds." for n in range(1, 8)) + "\n"),
    # Three markers, not two. `***bold-italic.***` and `**_bold-italic._**`
    # are ordinary Markdown, and a cap of two merged both with the sentence
    # after them. The suite could not tell a cap of two from no cap at all.
    ("a bold-italic lead-in ends a sentence", PASS,
     "***" + ("word " * 12).strip() + ".*** " + ("word " * 12).strip() + ".\n"),
    ("a nested-emphasis lead-in ends a sentence", PASS,
     "**_" + ("word " * 12).strip() + "._** " + ("word " * 12).strip() + ".\n"),
    # A closing quote or bracket sits between the stop and the space.
    ("a quoted sentence ends a sentence", PASS,
     "He wrote \"" + ("word " * 11).strip() + ".\" " + ("word " * 12).strip() + ".\n"),
    # An abbreviation is not a sentence end. Splitting there reads one long
    # sentence as two short ones and rule 1 enforces nothing.
    ("an abbreviation does not end a sentence", FAIL,
     "The relay retries a delivery the adapter never confirmed, e.g. a timeout, "
     "and the operator reviews every one of these before it escalates.\n"),
    # A row, not a cell. The two terminated row cases above pass against a
    # mutation that joins a whole table, because the full stops re-split the
    # merged text. These do not.
    ("unterminated table rows are not one sentence", PASS,
     "| A |\n|---|\n| " + ("word " * 12).strip() + " |\n| " + ("word " * 12).strip() + " |\n"),
    # An escaped pipe is content. Splitting on it turned one long cell into
    # two short fragments, and the cell shipped clean.
    ("an escaped pipe does not divide a cell", FAIL,
     "| A |\n|---|\n| " + ("word " * 12).strip() + " \\| " + ("word " * 12).strip() + ". |\n"),
    ("a sentence that is only the word No still ends", PASS,
     "Does the relay retry a delivery whose state it cannot read? No. "
     "It escalates instead.\n"),
    # A blank line still ends a unit, and a heading is still its own.
    ("two wrapped paragraphs stay apart", PASS,
     "word " * 8 + "\n" + "word " * 8 + "end.\n\n"
     + "word " * 8 + "\n" + "word " * 8 + "end.\n"),
    # A design record's declaration is a list, not a sentence. Twenty-two
    # decisions are twenty-three words, and no rewriting shortens a list of
    # identifiers. `check-docs.py` reads this line; a reader reads a list.
    ("a declaration line is not measured", PASS,
     "Affects: " + ", ".join(f"DEC-{n:02d}" for n in range(1, 23)) + "\n"),
    ("a one-decision declaration passes", PASS, "Affects: DEC-44\n"),
    # The exemption is the declaration shape alone. Identifiers and commas,
    # nothing else. The three cases below close the ways a sentence could ride
    # on the prefix.
    ("prose behind the declaration prefix is prose", FAIL,
     "Affects: " + LONG.strip() + ".\n"),
    ("a declaration written as a sentence is prose", FAIL,
     "Affects: DEC-44 is the row this change ships, and this sentence keeps "
     "running well past the twenty-word limit before it finally ends.\n"),
    ("the prose under a declaration is still measured", FAIL,
     "Affects: DEC-44\n\n" + LONG.strip() + ".\n"),
]


def check_bytes(name, want, payload):
    """One case that writes bytes rather than text."""
    with tempfile.NamedTemporaryFile("wb", suffix=".md", delete=False) as handle:
        handle.write(payload)
        path = handle.name
    try:
        got = subprocess.run([sys.executable, CHECKER, path],
                             capture_output=True, text=True)
        if got.returncode != want:
            print(f"FAIL {name}: want exit {want}, got {got.returncode}")
            return 1
        if "not UTF-8" not in got.stdout:
            print(f"FAIL {name}: wanted the finding to name the encoding")
            return 1
        print(f"pass {name}")
        return 0
    finally:
        os.unlink(path)


def load_checker():
    """Imports ste-check.py as a module, despite the hyphen in its name."""
    import importlib.util

    spec = importlib.util.spec_from_file_location("ste_check", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def check_default_set() -> int:
    """The no-argument form must check the shipped set, and must not pass empty.

    `pnpm run check:ste` and the Guardrails workflow both call the checker
    with no arguments, so the default set is the only definition of what
    ships. Two ways that can go wrong silently, and both are closed here. A
    glob that matches nothing would print "STE clean: 0 file(s)" and exit 0,
    retiring the check without saying so. And a default set that quietly lost
    README.md or AGENTS.md would still look healthy.
    """
    failures = 0
    module = load_checker()

    proc = subprocess.run([sys.executable, CHECKER], capture_output=True, text=True)
    if proc.returncode != PASS:
        failures += 1
        print(f"FAIL the shipped set passes with no arguments: exit {proc.returncode}")
        print(f"     {(proc.stdout or proc.stderr).strip()}")
    else:
        print("pass the shipped set passes with no arguments")

    # The documents the convention exists for must be in the set. A default
    # that silently lost one would still look healthy.
    #
    # Repository-relative paths, not basenames: fixtures/README.md collapses
    # onto the root README.md in a basename set, so a basename sentinel could
    # not see the fixtures glob disappear.
    root = os.path.dirname(os.path.dirname(os.path.realpath(CHECKER)))
    paths = {os.path.relpath(p, root) for p in module.shipped_files()}
    if len(paths) < 10:
        failures += 1
        print(f"FAIL the shipped set is not vacuous: only {len(paths)} file(s)")
    for required in ("README.md", "AGENTS.md", "CONTRIBUTING.md", "REVIEW.md",
                     "fixtures/README.md", "docs/v1-architecture.md"):
        if required not in paths:
            failures += 1
            print(f"FAIL the shipped set names {required}")
    # Every glob must contribute, so retiring one directory cannot pass.
    if module.empty_globs():
        failures += 1
        print(f"FAIL these globs match nothing: {module.empty_globs()}")
    if not failures:
        print(f"pass the shipped set names the shipped documents ({len(paths)} files)")

    # An expansion that matches nothing must fail rather than report clean.
    empty = load_checker()
    # One retired pattern beside two live ones: the case a total-emptiness
    # check cannot see.
    empty.SHIPPED_GLOBS = ("README.md", "AGENTS.md", "no-such-directory/*.md")
    argv = sys.argv
    try:
        sys.argv = ["ste-check"]
        code = empty.main()
    finally:
        sys.argv = argv
    if code == PASS:
        failures += 1
        print("FAIL a retired glob must not report clean")
    else:
        print("pass a retired glob is a fault, not a pass")
    return failures


def main() -> int:
    label = {PASS: "pass", FAIL: "fail"}
    failures = 0
    with tempfile.TemporaryDirectory() as tmp:
        for index, (name, want, body) in enumerate(CASES):
            path = os.path.join(tmp, f"case{index}.md")
            with open(path, "w") as handle:
                handle.write(body)
            proc = subprocess.run(
                [sys.executable, CHECKER, path], capture_output=True, text=True
            )
            if proc.returncode == want:
                print(f"pass {name}")
            else:
                failures += 1
                print(
                    f"FAIL {name}: want {label[want]}, got "
                    f"{label.get(proc.returncode, proc.returncode)}"
                )
                if proc.stdout.strip():
                    print(f"     {proc.stdout.strip().splitlines()[0]}")
    # A file this checker cannot decode must be a finding, not a traceback.
    failures += check_bytes("a file that is not UTF-8 is a finding", FAIL,
                            b"\xff\xfe# not utf-8\n")

    failures += check_default_set()

    if failures:
        print(f"\n{failures} failure(s)")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
