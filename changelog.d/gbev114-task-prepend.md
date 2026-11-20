- The Cat 40 runner takes `--task-prepend-file <json>`, a JSON object of Hard task id to text placed before that task's
  question, so a prompt A/B can run on the same gbrain build, world and models. Each text's SHA-256 goes in the Hard
  manifest (`experiment.json` and the receipt), so a resume, or an arm reuse checked by
  [eval/runner/cat40/reuse-check.ts](eval/runner/cat40/reuse-check.ts), is refused when the text differs even if the file
  path is the same. The multi-evidence dev loop passes it through as `--cat40-task-prepend-file`.
