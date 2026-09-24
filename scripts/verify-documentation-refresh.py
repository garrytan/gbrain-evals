#!/usr/bin/env python3
"""Check protected documentation bytes, tested prompt fences, local links and anchors."""
import hashlib
import json
from pathlib import Path
import re
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
    pin = json.loads((root / "package.json").read_text())["dependencies"]["gbrain"]
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
    lock = re.search(r'"gbrain"\s*:\s*"([^\"]+)"', (root / "bun.lock").read_text())
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


def verify():
    manifest = json.loads(MANIFEST.read_text())
    errors = candidate_references()
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
