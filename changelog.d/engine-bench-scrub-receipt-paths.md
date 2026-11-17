### Engine-bench receipts are written without machine paths

- Engine-bench's four runners (`correctness`, `surface-parity`, `lme-recall` and `perf`) now write their published JSON
  with checkout, home and temp paths rewritten, and with Capy scratch paths written as `<work>/`, as other runners'
  receipts already are. Before this, their receipts carried paths such as `/home/<user>/...`, which the committed-receipt
  check refuses, so they had to be cleaned by hand before publication.
