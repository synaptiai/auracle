#!/usr/bin/env python3
"""Cases for the DEC-citation guard.
Run: python3 .claude/hooks/test_commit_dec_citation.py

The guard requires a commit that changes the design register to name a DEC
the register defines. The commit-msg hook and the pull-request range mode
must agree on where a citation may appear and on what counts as one.
"""
import os
import subprocess
import sys
import tempfile

HOOK = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                    "commit_dec_citation.py")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(HOOK))))
ALLOW, BLOCK = 0, 2

# (name, expected, message) — each runs against a staged register change.
CASES = [
    ("citation in the subject", ALLOW, "docs: adjust the register (DEC-07)"),
    # The body is where a citation normally lives. Range mode read the
    # subject alone, so this passed locally and failed on the pull request.
    ("citation in the body", ALLOW, "docs: adjust the register\n\nThis obeys DEC-07.\n"),
    ("no citation at all", BLOCK, "docs: adjust the register"),
    # A bare pattern match accepted an id the register does not define.
    ("citation the register does not define", BLOCK,
     "docs: adjust the register\n\nThis obeys DEC-99.\n"),
    ("unknown id alongside a real one", ALLOW,
     "docs: adjust the register\n\nObeys DEC-07; proposes DEC-99.\n"),
]

failures = 0


def run_commit_msg(message):
    """Stage a register change in a scratch worktree, then check the message."""
    import tempfile
    with tempfile.NamedTemporaryFile("w", suffix=".msg", delete=False) as handle:
        handle.write(message)
        path = handle.name
    try:
        return subprocess.run(
            [sys.executable, HOOK, "--commit-msg", path],
            capture_output=True, text=True, cwd=ROOT,
        ).returncode
    finally:
        os.unlink(path)


def staged_register_change():
    out = subprocess.run(["git", "diff", "--cached", "--name-only"],
                         capture_output=True, text=True, cwd=ROOT).stdout
    return "docs/v1-architecture.md" in out.split()


if not staged_register_change():
    # commit_msg_mode exits 0 when the register is not staged, so the cases
    # would all pass vacuously. Check the citation predicate directly.
    sys.path.insert(0, os.path.dirname(HOOK))
    import importlib.util
    spec = importlib.util.spec_from_file_location("guard", HOOK)
    guard = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(guard)
    os.chdir(ROOT)
    for name, expected, message in CASES:
        got = ALLOW if guard.cites_a_real_dec(message) else BLOCK
        if got == expected:
            print(f"pass {name}")
        else:
            print(f"FAIL {name}: want {expected} got {got}")
            failures += 1
else:
    for name, expected, message in CASES:
        got = run_commit_msg(message)
        if got == expected:
            print(f"pass {name}")
        else:
            print(f"FAIL {name}: want {expected} got {got}")
            failures += 1


# --- Range mode -------------------------------------------------------------
#
# Range mode is what runs on a pull request, and it had no case here. The
# merge handling was therefore free to regress, and it did: reporting a merge
# against its first parent makes it look like it made every change on the
# branch, so GitHub's synthetic merge commit failed on a citation its
# generated message can never carry. These cases pin both directions.

REGISTER = "docs/v1-architecture.md"


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, text=True)


def build_repo(repo, *, feature_edits_register, citation, evil_merge):
    """A base commit, a feature branch, and a merge. Returns the range."""
    os.makedirs(os.path.join(repo, "docs"), exist_ok=True)
    git(repo, "init", "-q", "-b", "main")
    git(repo, "config", "user.email", "guard@example.test")
    git(repo, "config", "user.name", "guard")

    register = os.path.join(repo, REGISTER)
    with open(register, "w") as handle:
        handle.write("| DEC-01 | base |\n| DEC-07 | evidence |\n")
    with open(os.path.join(repo, "other.txt"), "w") as handle:
        handle.write("base\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "base")
    base = git(repo, "rev-parse", "HEAD").stdout.strip()

    git(repo, "checkout", "-qb", "feature")
    if feature_edits_register:
        with open(register, "a") as handle:
            handle.write("| DEC-08 | added |\n")
    with open(os.path.join(repo, "other.txt"), "w") as handle:
        handle.write("feature\n")
    git(repo, "add", "-A")
    message = "feat: work\n\nObeys DEC-07.\n" if citation else "feat: work"
    git(repo, "commit", "-qm", message)

    git(repo, "checkout", "-q", "main")
    git(repo, "merge", "--no-commit", "--no-ff", "-q", "feature")
    if evil_merge:
        with open(register, "a") as handle:
            handle.write("| DEC-09 | smuggled in the merge |\n")
        git(repo, "add", "-A")
    git(repo, "commit", "-qm", "Merge feature into main")
    head = git(repo, "rev-parse", "HEAD").stdout.strip()
    return f"{base}...{head}"


def run_range(**kwargs):
    with tempfile.TemporaryDirectory() as repo:
        rng = build_repo(repo, **kwargs)
        return subprocess.run(
            [sys.executable, HOOK, f"--range={rng}"],
            capture_output=True, text=True, cwd=repo,
        ).returncode


RANGE_CASES = [
    # The regression that reached CI: a clean merge of a branch that edited
    # the register with a proper citation. The merge's own message cites
    # nothing, and it must not have to.
    ("clean merge of a cited register change", ALLOW,
     dict(feature_edits_register=True, citation=True, evil_merge=False)),
    # The rule itself still has to bite on the commit that made the change.
    ("clean merge of an uncited register change", BLOCK,
     dict(feature_edits_register=True, citation=False, evil_merge=False)),
    # A merge that edits the register on its own belongs to no other commit,
    # so the merge itself must carry the citation.
    ("evil merge edits the register", BLOCK,
     dict(feature_edits_register=False, citation=True, evil_merge=True)),
    ("clean merge touching no register", ALLOW,
     dict(feature_edits_register=False, citation=False, evil_merge=False)),
]

for name, expected, kwargs in RANGE_CASES:
    got = run_range(**kwargs)
    if got == expected:
        print(f"pass range: {name}")
    else:
        print(f"FAIL range: {name}: want {expected} got {got}")
        failures += 1

# A range the guard cannot read is a range it has not checked. An empty base
# is what a push event gives a step that reads the pull request's base, and an
# unknown one is a shallow checkout. Both must fail, never pass unread.
#
# The fixture cites its change, so a guard that read the history anyway would
# pass it: only a refusal of the range itself blocks here.
def run_unreadable_range(make_range):
    with tempfile.TemporaryDirectory() as repo:
        rng = build_repo(repo, feature_edits_register=True, citation=True, evil_merge=False)
        head = rng.split("...")[1]
        done = subprocess.run(
            [sys.executable, HOOK, f"--range={make_range(head)}"],
            capture_output=True, text=True, cwd=repo,
        )
        return done.returncode if "cannot read the range" in done.stdout else f"{done.returncode}, unnamed"


# A commit in a readable range whose files git cannot list has not been read
# either. Removing the tree object of the feature commit leaves the range
# listable and the commit's files unreadable.
def run_unreadable_commit():
    with tempfile.TemporaryDirectory() as repo:
        rng = build_repo(repo, feature_edits_register=False, citation=True, evil_merge=False)
        tree = git(repo, "rev-parse", "feature^{tree}").stdout.strip()
        os.remove(os.path.join(repo, ".git", "objects", tree[:2], tree[2:]))
        done = subprocess.run(
            [sys.executable, HOOK, f"--range={rng}"],
            capture_output=True, text=True, cwd=repo,
        )
        return done.returncode if "cannot read" in done.stdout else f"{done.returncode}, unnamed"


UNREADABLE_CASES = [
    ("a range with an empty base", lambda head: f"...{head}"),
    ("a range whose base is not a commit", lambda head: "0" * 40 + "..." + head),
]

for name, make_range in UNREADABLE_CASES:
    got = run_unreadable_range(make_range)
    if got == BLOCK:
        print(f"pass range: {name}")
    else:
        print(f"FAIL range: {name}: want {BLOCK} got {got}")
        failures += 1

got = run_unreadable_commit()
if got == BLOCK:
    print("pass range: a commit whose files git cannot list")
else:
    print(f"FAIL range: a commit whose files git cannot list: want {BLOCK} got {got}")
    failures += 1

print()
if failures:
    print(f"{failures} failure(s)")
    sys.exit(1)
print("all checks passed")
