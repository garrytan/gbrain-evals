### BEAM-10M results on gbrain v0.60.748.0

- README's two BEAM-10M rows now show gbrain v0.60.748.0, measured on 2026-11-20 with Opus 5.5, GPT-6.2 Sol and
  particle-1 reading. The 8,000-token row scores 55.8% and is level with v0.60.493.0 on Opus 5.5 (−0.1 points, 95%
  interval −3.2 to +3.1). gbrain's whole system scores 50.6%, and with Opus 5.5 reading both it is 12.2 points behind
  the file agent's stored row (95% interval 6.4 to 18.4).
  [docs/benchmarks/2026-11-19-beam10m-newest/results/README.md](docs/benchmarks/2026-11-19-beam10m-newest/results/README.md)
  has the full results, and its `report.json` has the aggregates.
- The custody pairing tool keys Q1's re-judged file-agent answers by the ids the re-judge gave them.
