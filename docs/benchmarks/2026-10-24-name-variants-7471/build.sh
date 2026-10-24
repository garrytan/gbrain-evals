#!/bin/bash
# TREE=<gbrain checkout> build.sh <dir> [embed]: builds the eval brain (gen.py corpus; person pages and rare-word notes created last)
set -e
export PATH=$PATH
D=$1; rm -rf $D; mkdir -p $D
python3 $(dirname "$0")/gen.py $D
export GBRAIN_HOME=$D/home
CLI="bun ${TREE:?set TREE to the gbrain checkout that builds the brain}/src/cli.ts"
cd $D
if [ "$2" = embed ]; then
  $CLI init --pglite --embedding-model openai:text-embedding-3-small --search-mode balanced --non-interactive > init.log 2>&1
  $CLI import $D/brain --no-embed > import.log 2>&1
else
  $CLI init --pglite --no-embedding > init.log 2>&1
  $CLI import $D/brain --no-embed > import.log 2>&1
fi
for f in $D/late/*.md; do b=$(basename $f .md); case $b in quokka|pangolin|narwhal|axolotl) s=notes/$b;; *) s=people/$b;; esac; $CLI put $s < $f > /dev/null; done
if [ "$2" = embed ]; then $CLI embed --stale --yes > embed.log 2>&1; fi
$CLI stats | head -3
