#!/usr/bin/env python3
"""Check every link in the repository's own Markdown (docs audit B12).

Local mode (default, run by `bun run validate` and CI): every relative link and
heading anchor in every tracked Markdown file must resolve. Corpus content is
skipped because its wiki-style slugs are benchmark inputs, not doc links:
eval/data/** and docs/benchmarks/**/artifacts/**.

External mode (`--external`, run weekly by .github/workflows/links.yml): also
fetch every http(s) link once. Some hosts refuse automated clients; a 401, 403
or 429 is reported as a warning, not a dead link.
"""
import concurrent.futures
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from importlib import import_module

anchors = import_module("verify-documentation-refresh").anchors

ROOT = Path(__file__).resolve().parent.parent
SKIP = (re.compile(r"^eval/data/"), re.compile(r"^docs/benchmarks/.*/artifacts/"))
LINK = re.compile(r"!?\[[^\]]*\]\(([^\n]+?)\)")
BLOCKED = {401, 403, 429}


def markdown_files():
    out = subprocess.run(["git", "ls-files", "*.md"], cwd=ROOT, check=True, capture_output=True, text=True).stdout
    return [f for f in out.split("\n") if f and not any(p.search(f) for p in SKIP)]


def links(path):
    text = re.sub(r"```.*?```", "", path.read_text(), flags=re.S)
    text = re.sub(r"`[^`\n]*`", "", text)
    for raw in LINK.findall(text):
        yield raw.strip().split(' "')[0].strip("<>")


def check_local(files):
    errors, external = [], set()
    for file in files:
        path = ROOT / file
        for link in links(path):
            if re.match(r"^https?://", link):
                external.add(link)
                continue
            if re.match(r"^[a-zA-Z][a-zA-Z0-9+.-]*:", link):
                continue
            target, _, anchor = urllib.parse.unquote(link).partition("#")
            destination = (path.parent / target).resolve() if target else path
            if not destination.exists():
                errors.append(f"{file}: {link}: missing local target")
            elif anchor and destination.suffix.lower() == ".md" and anchor not in anchors(destination.read_text()):
                errors.append(f"{file}: {link}: missing heading anchor")
    return errors, sorted(external)


def fetch(url):
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "gbrain-evals-link-check/1"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return url, response.status
    except urllib.error.HTTPError as error:
        return url, error.code
    except Exception as error:
        return url, f"{type(error).__name__}: {error}"


def main():
    files = markdown_files()
    errors, external = check_local(files)
    warnings = []
    if "--external" in sys.argv:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for url, status in pool.map(fetch, external):
                if status in BLOCKED:
                    warnings.append(f"{url}: HTTP {status} (automated client refused)")
                elif not (isinstance(status, int) and status < 400):
                    errors.append(f"{url}: {status}")
    for warning in warnings:
        print(f"warning: {warning}")
    for error in errors:
        print(f"error: {error}")
    print(f"check-links: {len(files)} Markdown files, {len(external)} external links{' fetched' if '--external' in sys.argv else ' not fetched'}, {len(errors)} errors")
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
