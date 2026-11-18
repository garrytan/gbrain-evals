#!/usr/bin/env bash
# Bootstrap a fresh Ubicloud VM (Ubuntu 24.04) for one entity-dedupe head-to-head memory-system cell: Docker, Bun and
# a frozen-lockfile install through eval/systems/bootstrap.sh setup, plus the system's pinned images. No dataset is
# fetched: the VM writes the world from ENTITY_H2H_SEED itself. scripts/ubicloud/ubi-runner.sh runs it (run --setup), with
# ENTITY_H2H_SYSTEM set by run.sh (--env).
set -euo pipefail
system=${ENTITY_H2H_SYSTEM:?run.sh passes ENTITY_H2H_SYSTEM}
bash eval/systems/bootstrap.sh setup --system "$system" --config entity-h2h
echo "setup: $(bun --version), $(docker --version)"
