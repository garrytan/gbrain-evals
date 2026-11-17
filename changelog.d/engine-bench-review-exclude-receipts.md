### Reviewers leave out engine-bench's bulkiest raw receipts

- Code review before merge now leaves out each engine-bench correctness runner's raw
  `correctness/work/*/receipt.json` and the 10,000-page speed receipt (`speed/*speed-*-10000.json`), in any dated
  `docs/benchmarks/*-engine-bench/` folder. They hold every probe and paired query and are too large for a reviewer to
  read. The results page, the correctness summary, the LongMemEval rows, the 100,000-page speed receipt and every log
  stay in review, and the check of each published number against its raw data still reads the excluded files.
