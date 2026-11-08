#!/usr/bin/env python3
"""Print the skill-listing budget code bundled in a Claude Code binary.

Claude Code is not open source, so its skill-listing rule cannot be cited by
file and line. The npm package ships the bundled JavaScript inside
bin/claude.exe. This prints the region that computes the listing budget
(skillListingBudgetFraction, skillListingMaxDescChars) and renders the
listing ("Skill listing over budget").

Usage: python3 claude-code-rule.py <path to claude.exe>
"""
import sys

data = open(sys.argv[1], "rb").read()
anchor = b"Skill listing over budget: ${"
end_anchor = b"tengu_skill_descriptions_truncated"
i = data.find(anchor)
if i < 0:
    sys.exit("anchor not found: is this Claude Code 2.1.312?")
start = data.rfind(b"skillListingMaxDescChars", 0, i) - 400
stop = data.find(end_anchor, i) + 500
print(f"offset {start}..{stop} of {sys.argv[1]}")
print(data[start:stop].decode("utf-8", "replace"))
