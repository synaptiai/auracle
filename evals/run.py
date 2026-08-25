#!/usr/bin/env python3
"""Run the agent eval suite non-interactively.

Two layers:

1. Structural checks. Always run. No model needed.
2. Behaviour checks. Each case runs through a configurable agent CLI.
   Set EVAL_AGENT_CMD to an argv template. The literal token {prompt}
   receives the case prompt. Default: claude -p {prompt} --output-format text
"""
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_AGENT_CMD = "claude -p {prompt} --output-format text"
EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}")
PHONE = re.compile(r"(?<![\w.\-])(?:\+\d{1,3}[\s.\-])?(?:\(\d{2,4}\)[\s.\-]?|\d{2,4}[\s.\-])\d{3,4}[\s.\-]?\d{3,4}(?![\w.\-])")

failures = 0


def die(msg):
    global failures
    failures += 1
    print(f"FAIL {msg}")


def structural_checks(manifest):
    seen = set()
    for entry in manifest["cases"]:
        cid = entry["id"]
        if cid in seen:
            die(f"{cid}: duplicate case id")
        seen.add(cid)
        path = os.path.join(ROOT, entry["case_file"])
        if not os.path.exists(path):
            die(f"{cid}: missing case file {entry['case_file']}")
            continue
        case = json.load(open(path))
        if case.get("id") != cid:
            die(f"{cid}: case file id mismatch")
        if not case.get("prompt"):
            die(f"{cid}: empty prompt")
        if not case.get("checks"):
            die(f"{cid}: no checks")
        text = json.dumps(case)
        if EMAIL.search(text) or PHONE.search(text):
            die(f"{cid}: prompt or check contains PII-like data (DEC-18)")
    reg = open(os.path.join(ROOT, "docs/v1-architecture.md")).read()
    valid = set(re.findall(r"DEC-\d{2}", reg))
    cited = set()
    for entry in manifest["cases"]:
        cited.update(entry.get("decs", []))
    unknown = cited - valid
    if unknown:
        die(f"manifest cites DECs absent from the register: {sorted(unknown)}")


def run_behaviour_case(case, cmd):
    proc = subprocess.run(
        cmd, capture_output=True, text=True, cwd=ROOT, timeout=900,
    )
    out = proc.stdout
    for chk in case["checks"]:
        found = re.search(chk["pattern"], out, re.S)
        ok = not found if chk["type"] == "not_contains" else bool(found)
        if ok:
            print(f"pass {case['id']}:{chk['name']}")
        else:
            die(f"{case['id']}:{chk['name']}")


def main():
    manifest_path = os.path.join(ROOT, "evals/manifest.json")
    manifest = json.load(open(manifest_path))
    structural_checks(manifest)

    template = os.environ.get("EVAL_AGENT_CMD") or DEFAULT_AGENT_CMD
    argv = shlex.split(template)
    if shutil.which(argv[0]) is None:
        print(f"SKIP behaviour layer: runner binary {argv[0]!r} not on PATH")
    else:
        for entry in manifest["cases"]:
            case = json.load(open(os.path.join(ROOT, entry["case_file"])))
            cmd = [part.replace("{prompt}", case["prompt"]) for part in argv]
            run_behaviour_case(case, cmd)

    if failures:
        print(f"\n{failures} failure(s)")
        sys.exit(1)
    print("\nall checks passed")


if __name__ == "__main__":
    main()
