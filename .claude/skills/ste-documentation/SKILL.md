---
name: ste-documentation
description: Applies Simplified Technical English to any markdown this repository ships. Triggers when the user asks to write documentation, update a README, draft markdown for adopters, or review docs for style.
---

# STE Documentation

This skill is advisory. The deterministic backstop is the compliance pass in
`REVIEW.md`, which runs the same sentence-length check before a review closes.

Documentation that ships to adopters follows ASD-STE100 Simplified Technical
English. Prompts, scripts and configuration do not.

## Rules

1. Maximum 20 words in a sentence.
2. Maximum 6 sentences in a paragraph.
3. Active voice.
4. Present tense.
5. One technical name has one meaning. Reuse the names in the appendix of
   `docs/v1-architecture.md`. Introduce no synonyms for them.

## Check to run

Run this from the repository root against each changed markdown file:

```sh
python3 - <<'EOF'
import re, sys
fail = False
for path in sys.argv[1:]:
    text = re.sub(r'```.*?```', '', open(path).read(), flags=re.S)
    text = re.sub(r'`[^`]*`', 'x', text)
    for s in re.split(r'(?<=[.!?])\s+', text):
        words = len(re.findall(r"[A-Za-z0-9_-]+", s))
        if words > 20:
            fail = True
            print(f"{path}: {words} words: {s[:90]}")
sys.exit(1 if fail else 0)
EOF
```

A non-zero exit means a sentence is above the limit. Rewrite the sentence. Do
not split it with a semicolon. Use two sentences.
