- Vorflux's bot now hears about our replies on its pull requests right away instead of on its hourly check. A new
  workflow, `.github/workflows/vorflux-hook.yml`, posts a small JSON notice to the webhook in the Actions secret
  `VORFLUX_HOOK_URL` when capy-ai[bot] comments, reviews or leaves a review comment on a pull request labelled
  `vorflux` (reviews and review comments only on branches in this repository, because GitHub gives fork runs of those
  events no secrets), and when such a pull request is merged or closed. It checks out nothing, has no token
  permissions and never sends the comment's text. Until the secret is set, each matching event fails its run with a
  message that says so. `test/eval/vorflux-hook-workflow.test.ts` covers which events ring and what is sent.
