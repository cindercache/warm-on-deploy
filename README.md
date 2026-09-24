# CinderCache: Warm on Deploy

Warm your CDN edge cache on every deploy and verify it per PoP, directly from your GitHub workflow. This action triggers a CinderCache warm through your account's deploy webhook, waits for it to finish, prints a per-cell proof table, and passes or fails the job by outcome.

Documentation: https://cindercache.com/docs/

## Quick start

1. Create a deploy webhook for a verified domain (`POST /v1/webhooks`) and copy the returned token (`cc_hook_...`).
2. Add it to your repository as a secret named `CINDERCACHE_TOKEN`.
3. Add a step to your deploy workflow:

```yaml
- name: Warm CinderCache
  uses: cindercache/warm-on-deploy@v1
  with:
    token: ${{ secrets.CINDERCACHE_TOKEN }}
```

With no other inputs, this warms the domain's standing sets and API targets at the service's default set of locations. The token is sent as an `Authorization: Bearer` header, so it never appears in a URL or a log.

On a pull request from a fork, `secrets.*` is empty by design, so the action exits with "token is required" rather than running unauthenticated. That is expected, not a fault.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `token` | yes | | Deploy-webhook token (`cc_hook_...`). Store it as a secret. |
| `api-base` | no | `https://api.cindercache.com` | CinderCache API base URL. Must use `https`, since the token travels as a Bearer header. |
| `urls` | no | (standing sets + API targets) | Newline- or space-separated URLs to warm. Each host must be this webhook's verified domain. |
| `locations` | no | (service default set) | Comma-separated locations to warm. |
| `wait` | no | `true` | Wait for completion and read the proof. Set `false` to fire and forget. |
| `fail-on` | no | `blocked,failed` | Comma-separated outcomes that fail the job. |
| `timeout-seconds` | no | `120` | Maximum seconds to wait for completion. |

## Outputs

| Output | Description |
| --- | --- |
| `job-id` | The warm job id. |
| `status` | The final job status. Set only when `wait` is `true`. |

## Pass, warn, or fail

A cell is one URL at one location, so a job warming several URLs reports several cells per location. The action sorts each cell into one of three buckets:

- `proven`: the cache was verified warm at that cell. The job passes.
- `blocked` or `failed`: the zone blocked the warmer, or the warm errored. These fail the job by default (configurable with `fail-on`).
- `inconclusive`, or a cell no CinderCache node served (a coverage gap on our side): a warning, not a failure. The action will not break your build over an ambiguity or a gap on our side.

If the warm job fails overall, the action fails regardless of `fail-on`. The `fail-on` input matches served result outcomes, so it does not act on uncovered cells. If the warm does not finish before `timeout-seconds`, the action warns and passes.

## Notes

The token is scoped to a single verified domain and can only trigger warming of that domain. Revoke it at any time with `DELETE /v1/webhooks/{id}`. The action has no dependencies. It runs on the Node.js 24 runtime built into GitHub-hosted runners.

Three kinds of limit return HTTP 429 and the action treats them differently, following the `error` code rather than the status. A `rate_limited` response is temporary, so the action waits for the period in the `Retry-After` header and retries, both when triggering the warm and while polling for proof. A `quota_exceeded` or `monthly_quota_exceeded` response cannot succeed on retry, so the action stops immediately and prints the server's explanation, which names the limit and, for the monthly allowance, the date it resets. Only the trigger can return those two, because reading the proof consumes no quota.

See `examples/warm-on-deploy.yml` for a complete workflow.
