- The credential check before a push no longer flags the duplicate-finder head-to-head's generated page keys (such as
  `home:yara-mabry`) in the key fields of its counted `subjects.json` and `hand-check-sample.json` files. The rule
  covers only those two file names in that run's counted folder and only values shaped like a page key, so any other
  value there is still checked.
