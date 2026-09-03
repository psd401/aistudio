#!/usr/bin/env python3
"""Fingerprint the workspace contract that a mixed-version fleet must agree on.

WHY THIS EXISTS

build-and-push.sh used to demand a full workspace cutover — pause ingress,
drain writers, ordered redeploy — whenever `git diff --name-only` reported any
change to storage-broker.ts, workspace_sync.py, or migration 171. A filename.
So a comment, a log line, or a relaxed validation triggered the same
maintenance window as a generation-format rewrite.

It cried wolf on 2026-09-02 over a change that only ADDED an optional
`journaledReplay` flag to proof verification: no write path touched, no
persisted shape altered, workspace_sync.py and migration 171 untouched. A
guard that fires on every edit is a guard that gets waved through on the one
build where it matters.

WHAT ACTUALLY REQUIRES A CUTOVER

AgentCore keeps a live session on the image its microVM was created with, so a
release can briefly run old and new writers at once. That is only dangerous
when the two disagree about something PERSISTED: the proof string format, the
checkpoint manifest or journal shape, the object-key layout, or the generation
schema. Behaviour that is merely stricter or looser on one side cannot corrupt
an object that both sides still read and write identically.

So this extracts the declarations that define those persisted shapes and
hashes them. Validation logic, comments and log lines do not move the
fingerprint; a version bump, a renamed control prefix, a changed manifest field
or a schema edit all do.

FAIL-CLOSED

If a watched file exists but yields no anchors, the extraction itself is
considered broken and the caller must treat that as "cutover required". That
stops a refactor which renames every constant from silently emptying the
fingerprint and reporting "no change".
"""

import argparse
import hashlib
import json
import re
import subprocess
import sys

BROKER = "lib/agent-workspace/storage-broker.ts"
SYNC = "infra/agent-image/workspace_sync.py"
SCHEMA_GLOB_PREFIX = "infra/database/schema/171"

# A constant belongs to the contract when its name refers to something written
# down and read back by the other side of the fleet.
CONTRACT_NAME = re.compile(
    r"(VERSION|PREFIX|GENERATION|MANIFEST|JOURNAL|PROOF|DOMAIN|CONTENT_TYPE)"
)

# Types whose FIELD NAMES are serialized into the manifest, the journal, or the
# proof. A renamed or retyped field here is a wire-format change.
CONTRACT_TYPE = re.compile(
    r"^(?:type|interface)\s+"
    r"([A-Za-z0-9_]*(?:Manifest|Journal|ProofClaims|CheckpointEntry)"
    r"[A-Za-z0-9_]*)\b"
)

TS_CONST = re.compile(r"^const\s+([A-Z][A-Z0-9_]*)\s*=")
PY_CONST = re.compile(r"^(_?[A-Z][A-Z0-9_]*)\s*=")
TS_COMMENT = "//"
PY_COMMENT = "#"
STRING_LITERAL = re.compile(r"\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`")
REGEX_LITERAL = re.compile(r"/(?:[^/\\\\\\n]|\\\\.)+/[gimsuy]*")


class ContractExtractionError(RuntimeError):
    """A watched file produced no anchors — treat as cutover required."""


def _show(rev, path):
    """File contents at a git revision, or None when absent at that rev."""
    done = subprocess.run(
        ["git", "show", f"{rev}:{path}"],
        capture_output=True, text=True,
    )
    return done.stdout if done.returncode == 0 else None


def _list_schema(rev):
    done = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", rev, "infra/database/schema/"],
        capture_output=True, text=True,
    )
    if done.returncode != 0:
        return []
    return sorted(
        p for p in done.stdout.splitlines()
        if p.startswith(SCHEMA_GLOB_PREFIX)
    )


def _strip_comment(line, marker):
    """Drop a trailing line comment, ignoring markers inside literals.

    Both parts matter and both were wrong once. The first version applied
    Python's `#` rule to TypeScript, so `const CONTENT_TYPE_RE = /^[a-z0-9!#...`
    was cut at the `#` inside the regex character class; the truncated,
    unbalanced remainder then swallowed the following declarations and any
    edit near them looked like a contract change.
    """
    blanked = STRING_LITERAL.sub(lambda m: " " * len(m.group(0)), line)
    blanked = REGEX_LITERAL.sub(lambda m: " " * len(m.group(0)), blanked)
    index = blanked.find(marker)
    return line[:index] if index != -1 else line


def _declaration(lines, start, comment=TS_COMMENT, max_lines=400):
    """The whole declaration beginning at `start`, normalized.

    Consumes until every bracket opened is closed AND the text no longer sits
    on a continuation, so all the real shapes are captured in full:

        const X = "literal"                      one line
        const X = new Map([ ... ])               brackets span lines
        type X =                                 continuation trails
          Y & { version: 1 }
        type X =                                 continuation LEADS
          | A
          | B

    Earlier versions truncated at the first line, then at the first balanced
    line, then at the first union member. A guard that cannot see the thing it
    guards is worse than no guard, because it reports "unchanged".

    Comments are stripped and whitespace collapsed, so prose edits inside a
    declaration do not move the fingerprint.
    """
    CONTINUES = ("=", "&", "|", ",", "(", "[", "{", "+", ":")
    LEADS = ("|", "&", ".", "?", ":")
    collected, depth = [], 0
    for line in lines[start:start + max_lines]:
        code = _strip_comment(line, comment).rstrip()
        if code.strip():
            collected.append(code.strip())
        # Brackets inside a string or regex literal are DATA, not structure.
        depth_src = REGEX_LITERAL.sub("", STRING_LITERAL.sub("", code))
        depth += sum(depth_src.count(c) for c in "{([")
        depth -= sum(depth_src.count(c) for c in "})]")
        if depth > 0 or not collected:
            continue
        if collected[-1].endswith(CONTINUES):
            continue
        nxt = lines[start + len(collected)] if start + len(collected) < len(lines) else ""
        if _strip_comment(nxt, comment).strip().startswith(LEADS):
            continue
        break
    return re.sub(r"\s+", " ", " ".join(collected)).strip().rstrip(",")


def broker_anchors(text):
    anchors, lines = [], text.splitlines()
    for index, line in enumerate(lines):
        const = TS_CONST.match(line)
        if const and CONTRACT_NAME.search(const.group(1)):
            anchors.append(_declaration(lines, index, TS_COMMENT))
        declared = CONTRACT_TYPE.match(line)
        if declared:
            anchors.append(_declaration(lines, index, TS_COMMENT))
    return sorted(set(anchors))


def sync_anchors(text):
    anchors, lines = [], text.splitlines()
    for index, line in enumerate(lines):
        const = PY_CONST.match(line)
        if const and CONTRACT_NAME.search(const.group(1)):
            anchors.append(_declaration(lines, index, PY_COMMENT))
    return sorted(set(anchors))


def fingerprint_from_sources(sources, schema=None):
    """The contract from already-read file contents.

    Split out from `fingerprint` so the fail-closed rule is testable without a
    git tree: extraction returning nothing must raise, never quietly produce
    an empty fingerprint that compares equal to everything forever.
    """
    parts = {}
    extractors = ((BROKER, broker_anchors), (SYNC, sync_anchors))
    for path, extract in extractors:
        text = sources.get(path)
        if text is None:
            continue
        anchors = extract(text)
        if not anchors:
            raise ContractExtractionError(
                f"no contract anchors found in {path} — the extractor is out "
                "of date with the source, so its silence means nothing"
            )
        parts[path] = anchors

    # Any edit to the generation/journal migrations is a real schema change;
    # there is no safe subset to extract, so hash them whole.
    for path, content in sorted((schema or {}).items()):
        parts[path] = [hashlib.sha256(content.encode()).hexdigest()]

    blob = json.dumps(parts, sort_keys=True)
    return {
        "anchors": parts,
        "digest": hashlib.sha256(blob.encode()).hexdigest(),
    }


def fingerprint(rev):
    """The contract at one git revision."""
    sources = {path: _show(rev, path) for path in (BROKER, SYNC)}
    sources = {k: v for k, v in sources.items() if v is not None}
    schema = {path: (_show(rev, path) or "") for path in _list_schema(rev)}
    return fingerprint_from_sources(sources, schema)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--rev", required=True)
    parser.add_argument("--compare-to", help="second revision; exit 1 if the "
                                             "contract differs")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    try:
        current = fingerprint(args.rev)
    except ContractExtractionError as exc:
        print(f"CONTRACT EXTRACTION FAILED: {exc}", file=sys.stderr)
        return 2

    if not args.compare_to:
        print(current["digest"])
        if args.verbose:
            print(json.dumps(current["anchors"], indent=1), file=sys.stderr)
        return 0

    try:
        other = fingerprint(args.compare_to)
    except ContractExtractionError as exc:
        print(f"CONTRACT EXTRACTION FAILED: {exc}", file=sys.stderr)
        return 2

    if current["digest"] == other["digest"]:
        print("contract unchanged")
        return 0

    print("contract CHANGED")
    for path in sorted(set(current["anchors"]) | set(other["anchors"])):
        before = set(other["anchors"].get(path, []))
        after = set(current["anchors"].get(path, []))
        for gone in sorted(before - after):
            print(f"  - {path}: {gone}")
        for added in sorted(after - before):
            print(f"  + {path}: {added}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
