- **Guards in the cost-and-speed harness.**
  - The gbrain shim no longer scores a read as fixed evidence when gbrain's starter surface made it drop `limit` or `autocut`. Such a read is classified as not scored, and refused when the caller asks for errors ([eval/systems/gbrain-defaults/shim.py](eval/systems/gbrain-defaults/shim.py)). The readiness probe and Q1's write sampler still check that a session landed on that surface. They accept a read degraded only by the dropped settings and count any other degraded read as a miss ([eval/runner/memory-qa/run-systems.ts](eval/runner/memory-qa/run-systems.ts)).
  - cs1-load refuses a hosted system with no usable hosting sample, instead of pricing it with no server. A sample that saw none of the system's own containers is not usable ([eval/runner/cs1-load.ts](eval/runner/cs1-load.ts)).
  - A scheduled job's trigger that exits nonzero is recorded as failed, and the loader refuses to price that world's idle cost without it, including a trigger an older cell recorded with only its exit code ([eval/runner/q1/cell.ts](eval/runner/q1/cell.ts)).

  Each has a keyless test. The published cost-and-speed results rebuild unchanged.
- **Release notes:** a duplicate changelog fragment for the v0.60.771.0 pin, already released, is removed.
