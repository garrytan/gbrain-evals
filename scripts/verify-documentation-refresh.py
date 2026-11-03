#!/usr/bin/env python3
"""Check protected documentation bytes, tested prompt fences, local links and anchors."""
import hashlib
import json
from pathlib import Path
import re
import sys
import urllib.parse

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "docs/benchmarks/2026-09-09-retrieval-refresh/documentation-integrity.json"


def anchors(text):
    text = re.sub(r"```.*?```", "", text, flags=re.S)
    counts = {}
    found = set(re.findall(r"<a\s+(?:[^>]*?)(?:id|name)=[\"']([^\"']+)", text))
    for title in re.findall(r"^#{1,6}\s+(.+?)\s*#*$", text, re.M):
        title = re.sub(r"\[([^]]+)\]\([^)]+\)", r"\1", title)
        title = re.sub(r"<[^>]*>", "", title).lower()
        slug = re.sub(r"[^\w\-\s]", "", title).replace(" ", "-")
        count = counts.get(slug, 0)
        counts[slug] = count + 1
        found.add(slug + ("-" + str(count) if count else ""))
    return found


def candidate_references(root=ROOT):
    # The situation-recall candidate is the memory-cue build, installed as
    # the gbrain-cues alias since 2026-09-29; `gbrain` is the product pin,
    # checked by product_pin_references.
    pin = json.loads((root / "package.json").read_text())["dependencies"]["gbrain-cues"]
    match = re.fullmatch(r"github:garrytan/gbrain#([a-f0-9]{40})", pin)
    if not match:
        return [["package.json", "Current candidate must have an exact 40-character Git pin"]]
    sha = match.group(1)
    errors = []
    markers = {
        "CHANGELOG.md": [r"Pin the candidate product to `([^`]+)`"],
        "eval/RUNBOOK.md": [r"The declared candidate is `([^`]+)`"],
        "docs/benchmarks/2026-09-23-situation-recall-protocol.md": [
            r"The declared dependency now pins candidate `([^`]+)`",
            r"\| Declared candidate C0/C1 \| `([^`]+)`",
        ],
    }
    for file, patterns in markers.items():
        text = (root / file).read_text()
        for pattern in patterns:
            reference = re.search(pattern, text)
            if not reference or reference.group(1) != sha:
                errors.append([file, "Current candidate reference differs from package.json pin"])
    lock = re.search(r'"gbrain-cues"\s*:\s*"([^\"]+)"', (root / "bun.lock").read_text())
    if not lock or lock.group(1) != pin:
        errors.append(["bun.lock", "Declared candidate differs from package.json pin"])
    files = [root / file for file in ["package.json", "bun.lock", *markers]]
    files += list((root / "eval/runner").rglob("*.ts"))
    files += list((root / "test/eval").rglob("*.ts"))
    for path in files:
        for reference in re.findall(r"\b" + re.escape(sha[:7]) + r"[a-f0-9]*\b", path.read_text(), re.I):
            if not sha.startswith(reference):
                errors.append([str(path.relative_to(root)), reference, "Malformed current-candidate reference"])
    return errors


# Hub pages that name the product pin, one pattern per sentence (CLAUDE.md, "Shape of a top-level document").
PRODUCT_PIN_SENTENCES = {
    "README.md": [
        r"\| Pinned product \| gbrain \[`(?P<sha>[a-f0-9]{7,40})`\]\(https://github\.com/garrytan/gbrain/tree/(?P<full>[a-f0-9]{40})\), release v(?P<version>[\d.]+),",
        r"This repository installs gbrain v(?P<version>[\d.]+) \(`(?P<sha>[a-f0-9]{7,40})`\)",
    ],
    "docs/README.md": [r"with gbrain master `(?P<sha>[a-f0-9]{7,40})` \(v(?P<version>[\d.]+)\) as the product under test"],
    "docs/settings.md": [r"This page describes the gbrain this repository installs, master `(?P<sha>[a-f0-9]{7,40})` \(v(?P<version>[\d.]+),"],
    "docs/comparison-systems.md": [
        r"as this repository pins it \(master `(?P<sha>[a-f0-9]{7,40})`, v(?P<version>[\d.]+)\)",
        r"This repository now installs a different commit, gbrain master `(?P<sha>[a-f0-9]{7,40})` \(v(?P<version>[\d.]+)\)",
    ],
    "docs/retrieval-lessons.md": [r"as this repository pins it \(master `(?P<sha>[a-f0-9]{7,40})`, v(?P<version>[\d.]+)\)"],
    "eval/README.md": [r"Every runner loads the gbrain declared in `package.json`: master `(?P<sha>[a-f0-9]{7,40})` \(v(?P<version>[\d.]+)\)"],
    "eval/CONTRIBUTING.md": [r"The gbrain under test is the one `package.json` declares, master `(?P<sha>[a-f0-9]{7,40})` \(v(?P<version>[\d.]+)\)"],
    "eval/CREDITS.md": [r"is current as of the gbrain this repository pins, master `(?P<sha>[a-f0-9]{7,40})` \(v(?P<version>[\d.]+)\)"],
}


def product_pin_references(root=ROOT):
    """The `gbrain` product pin: bun.lock and every hub sentence naming it agree with package.json, and the hubs name one release."""
    pin = json.loads((root / "package.json").read_text())["dependencies"]["gbrain"]
    match = re.fullmatch(r"github:garrytan/gbrain#([a-f0-9]{40})", pin)
    if not match:
        return [["package.json", "Product pin must have an exact 40-character Git pin"]]
    sha = match.group(1)
    errors = []
    lock = re.search(r'"gbrain"\s*:\s*"([^"]+)"', (root / "bun.lock").read_text())
    if not lock or lock.group(1) != pin:
        errors.append(["bun.lock", "Declared product pin differs from package.json pin"])
    versions = {}
    for file, patterns in PRODUCT_PIN_SENTENCES.items():
        text = re.sub(r"\s+", " ", (root / file).read_text())
        for pattern in patterns:
            reference = re.search(pattern, text)
            if not reference:
                errors.append([file, "Product pin sentence missing: " + pattern])
            elif not sha.startswith(reference.group("sha")) or reference.groupdict().get("full", sha) != sha:
                errors.append([file, reference.group(0), "Product pin reference differs from package.json pin"])
            else:
                versions.setdefault(reference.group("version"), []).append(file)
    installed = root / "node_modules" / "gbrain" / "package.json"
    if installed.exists():
        version = json.loads(installed.read_text())["version"]
        stale = sorted(f for v, files in versions.items() if v != version for f in files)
        if stale:
            errors.append([", ".join(stale), "Product pin sentences name a release other than the installed gbrain v" + version + " (run bun install if package.json moved)"])
    if len(versions) > 1:
        errors.append([", ".join(sorted({f for files in versions.values() for f in files})),
                       "Product pin sentences name different releases: " + ", ".join(sorted(versions))])
    return errors


SCOREBOARD_PUBLICATION = "docs/benchmarks/2026-10-06-scoreboard/publication.json"
SCOREBOARD_RENDER = "docs/benchmarks/2026-10-06-scoreboard/scoreboard.md"
SCOREBOARD_BEGIN = "<!-- scoreboard:headline:begin -->"
SCOREBOARD_END = "<!-- scoreboard:headline:end -->"


def scoreboard_publication_reference(root=ROOT):
    """README's text between its last heading and the scoreboard block explains one published render: every commit it
    names after `check --commit` is the one publication.json records, and every decimal figure it quotes appears in the
    block or in scoreboard.md, the render's other file. Between a custody render and its publication the commit is null,
    and there is nothing to compare yet."""
    published = json.loads((root / SCOREBOARD_PUBLICATION).read_text()).get("published")
    if not isinstance(published, dict):
        return [[SCOREBOARD_PUBLICATION, "published is not an object, so the publication commit cannot be read"]]
    if "commit" not in published:
        return [[SCOREBOARD_PUBLICATION, "published has no commit; a publication pending its commit records null"]]
    commit = published["commit"]
    if commit is None:
        return []
    if not isinstance(commit, str):
        return [[SCOREBOARD_PUBLICATION, "published.commit is " + json.dumps(commit) + ", not a commit or null"]]
    above, begin, rest = (root / "README.md").read_text().partition(SCOREBOARD_BEGIN)
    if not begin:
        return [["README.md", "README.md has no " + SCOREBOARD_BEGIN + " line, so the paragraph above the scoreboard block cannot be found"]]
    block, end, _ = rest.partition(SCOREBOARD_END)
    if not end:
        return [["README.md", "README.md has no " + SCOREBOARD_END + " line, so the scoreboard block cannot be told from the rest of README"]]
    explanation = above.rsplit("\n## ", 1)[-1]
    named = [c.strip("`'\"()[],.;:") for c in re.findall(r"check --commit\s+(\S+)", explanation)]
    if not named:
        return [["README.md", "The paragraph above the scoreboard block names no publication commit"]]
    stale = [["README.md", c, "The paragraph above the scoreboard block describes a publication other than " + SCOREBOARD_PUBLICATION + " records (" + commit + "); update it with the new render"] for c in named if c != commit]
    if stale:
        return stale
    render = block + (root / SCOREBOARD_RENDER).read_text()
    figures = re.findall(r"(?<![\w.])\d+\.\d+(?!\w|\.\d)", explanation)
    return [["README.md", f, "The paragraph above the scoreboard block quotes a figure that neither the block nor " + SCOREBOARD_RENDER + " shows; update it with the new render"]
            for f in figures if not re.search(r"(?<![\w.])" + re.escape(f) + r"(?!\d)", render)]


def verify():
    manifest = json.loads(MANIFEST.read_text())
    errors = candidate_references() + product_pin_references() + scoreboard_publication_reference()
    if not (ROOT / "node_modules" / "gbrain" / "package.json").exists():
        print("verify-documentation-refresh: node_modules/gbrain is not installed, so the hubs' release was not checked against it", file=sys.stderr)
    for file, expected in manifest["protected_sha256"].items():
        path = ROOT / file
        if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            errors.append([file, "Protected bytes changed"])
    for file, expected in manifest["protected_prompt_blocks"].items():
        fences = re.findall(r"```[^\n]*\n.*?```", (ROOT / file).read_text(), re.S)
        actual = [hashlib.sha256(f.encode()).hexdigest() for f in fences]
        if actual != expected:
            errors.append([file, "Tested prompt fence changed"])
    files = manifest["authored_documents"] + manifest["new_documents"]
    files += ["docs/benchmarks/2026-09-09-retrieval-refresh/tables.md"]
    for file in files:
        path = ROOT / file
        if not path.exists():
            errors.append([file, "Missing document"])
            continue
        text = re.sub(r"```.*?```", "", path.read_text(), flags=re.S)
        for raw in re.findall(r"!?\[[^\]]*\]\(([^\n]+?)\)", text):
            link = raw.strip().split(' "')[0].strip("<>")
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", link):
                continue
            target, _, anchor = urllib.parse.unquote(link).partition("#")
            destination = (path.parent / target).resolve() if target else path
            if not destination.exists():
                errors.append([file, link, "Missing local target"])
            elif anchor and destination.suffix.lower() == ".md" and anchor not in anchors(destination.read_text()):
                errors.append([file, link, "Missing heading anchor"])
    return dict(authored_original=len(manifest["authored_documents"]), documents_checked=len(files),
                protected_inputs=len(manifest["protected_benchmark_inputs"]),
                protected_generated=len(manifest["protected_generated_evidence"]),
                tested_prompts=sum(map(len, manifest["protected_prompt_blocks"].values())), errors=errors)


if __name__ == "__main__":
    result = verify()
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result["errors"]))
