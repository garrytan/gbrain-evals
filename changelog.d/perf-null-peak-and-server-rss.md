- **The engine-bench speed runner no longer turns a missing memory reading into a measured one.** In
  `eval/runner/engine-bench/perf.ts`, an arm whose only memory reading was the baseline taken before the engine opened
  now records a null peak, where before the baseline stood in for the peak and the engine's share read as 0. A Postgres
  arm whose server memory could not be read (a container whose cgroup files are not readable on the host, every
  cgroup read failing or unparseable, or an external server) now records null server memory and a method saying why, so its engine
  RSS is null and its peak-RSS comparison is reported as missing instead of counting the server as 0. Counted runs read
  the container's cgroup on Linux, so no published number changes.
