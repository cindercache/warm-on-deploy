// CinderCache "warm on deploy" GitHub Action.
//
// Triggers a warm through the account's deploy webhook (the token is sent as a Bearer
// header, never in a URL), optionally waits for completion, prints a per-PoP proof table,
// and decides pass/warn/fail by outcome. It has NO external dependencies: it uses only
// Node built-ins (global fetch, fs, process), so there is no build step.
//
// Exit policy (three buckets):
//   proven                  -> pass
//   blocked / failed        -> fail the build (these are in fail-on by default)
//   inconclusive / no-cover -> warn, do not fail (an ambiguity or a CinderCache coverage
//                              gap is not the customer's build to break)
'use strict';

const fs = require('node:fs');

function input(name, def = '') {
  const v = process.env['INPUT_' + name.toUpperCase().replace(/ /g, '_')];
  return v === undefined || v === '' ? def : v;
}
// setOutput writes through a heredoc with a RANDOM delimiter. A bare `name=value` line lets a value
// containing a newline append further entries to GITHUB_OUTPUT, which downstream workflow steps then
// read as though this action had set them. Both values written here (job-id, status) come from the
// API, so neither is ours to trust. The delimiter is random per call so a value cannot close its
// own block and resume injecting.
function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) return;
  const d = 'ghadelim_' + crypto.randomUUID().replace(/-/g, '');
  fs.appendFileSync(f, `${name}<<${d}\n${value}\n${d}\n`);
}

// oneLine flattens anything interpolated into a ::workflow:: command. A newline lets a
// server-controlled string emit commands of its own, and GitHub's parser ALSO url-decodes the message
// portion, so %0A and %0D are the same injection in a different encoding and must go too. Stripping
// only the literal forms would leave a guard that looks present and is half absent.
const oneLine = (m) => String(m).replace(/%0[aAdD]/g, ' ').replace(/[\r\n]+/g, ' ');
const notice = (m) => console.log(`::notice::${oneLine(m)}`);
const warn = (m) => console.log(`::warning::${oneLine(m)}`);
const fail = (m) => console.log(`::error::${oneLine(m)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Two splitters, because the inputs document two different delimiters. urls are "newline- or
// space-separated", so they split on WHITESPACE ONLY: a comma is legal inside a query string, and
// splitting on it tore https://example.com/api?ids=1,2,3 into three junk URLs that were then warmed
// as if the customer had asked for them. locations and fail-on ARE documented comma-separated.
const parseWords = (s) => (s || '').split(/\s+/).map((x) => x.trim()).filter(Boolean);
const parseList = (s) => (s || '').split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

// retryAfterMs reads the Retry-After header in seconds, defaulting to 2 when it is absent or
// unparseable (an HTTP-date form yields NaN and takes the default). The result is CLAMPED to the
// budget left: without the clamp a server answering Retry-After: 3600 would hold the job an hour
// past timeout-seconds, because the deadline is checked before the sleep, not during it.
const retryAfterMs = (res, deadline) => {
  // Floored at 1 second. The `|| 2` catches NaN and 0 but NOT a negative: Retry-After: -5 survived it,
  // then clamped to sleep(0) and busy-looped against the 429 until the deadline. A literal 0 still
  // becomes 2s through the `|| 2`, which is deliberate -- retrying instantly against a limiter that
  // just refused us helps nobody.
  const secs = Math.max(1, parseInt(res.headers.get('retry-after') || '2', 10) || 2);
  return Math.max(0, Math.min(secs * 1000, deadline - Date.now()));
};

// errorBody reads the API's {error, message} envelope without throwing on a non-JSON payload.
// Returns empty strings for code and message when the body is not that envelope, with the raw
// text alongside so a caller can still show something useful.
async function errorBody(res) {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return { code: String(j.error || ''), message: String(j.message || ''), text };
    } catch {
      return { code: '', message: '', text };
    }
  } catch {
    // Never return an empty text here: the callers fall back to it, so an empty string would
    // print a bare "HTTP 500" with nothing after it and leave a customer with no way to debug.
    return { code: '', message: '', text: '(body unreadable)' };
  }
}

// detail renders a server error for a PUBLIC build log. The API's own {error, message} envelope is the
// good case and prints as-is. Anything else is an edge or proxy interstitial (a Cloudflare 502 page,
// say), where the useful signal is the STATUS, not the markup -- so the bound here is on SHAPE, not
// length: first line only, with the fuller body available to whoever sets RUNNER_DEBUG.
const detail = ({ message, text }) =>
  message ||
  (process.env.RUNNER_DEBUG === '1'
    ? String(text).slice(0, 500)
    : String(text).split('\n')[0].slice(0, 200));

async function main() {
  const token = input('token');
  if (!token) {
    fail('token is required (your CinderCache deploy-webhook token, stored as a secret).');
    process.exit(1);
  }
  // Mask FIRST, before the token can reach any other code path. GitHub masks anything passed through
  // secrets.*, but a token handed over as a plain input is not masked by default, so registering it
  // here means an accidental echo is redacted either way.
  // The shape check is part of the same guard: ::add-mask:: is itself a workflow command, so a token
  // containing a newline would terminate the command early and print its own tail in clear.
  if (!/^[A-Za-z0-9_]+$/.test(token)) {
    fail('the token is not in the expected format (letters, digits and underscores only).');
    process.exit(1);
  }
  console.log(`::add-mask::${token}`);

  // new URL() throws on anything that is not a URL, which is free validation: before this, a typo'd
  // api-base surfaced as an opaque fetch error much later. The https requirement stops a plain http://
  // base sending `Authorization: Bearer <token>` in cleartext -- one typo was enough. The loopback
  // carve-out is load-bearing: the test suite drives a mock over http://127.0.0.1.
  const rawBase = input('api-base', 'https://api.cindercache.com').replace(/\/+$/, '');
  let parsedBase;
  try {
    parsedBase = new URL(rawBase);
  } catch {
    fail(`api-base is not a valid URL: ${rawBase}`);
    process.exit(1);
  }
  if (parsedBase.protocol !== 'https:' && !['127.0.0.1', 'localhost', '::1'].includes(parsedBase.hostname)) {
    fail(`api-base must use https (got ${parsedBase.protocol}//). The token is sent as a Bearer header and must not travel in cleartext.`);
    process.exit(1);
  }
  const apiBase = rawBase;
  const urls = parseWords(input('urls'));
  const locations = parseList(input('locations'));
  const wait = input('wait', 'true') !== 'false';
  const failOn = new Set(parseList(input('fail-on', 'blocked,failed')).map((s) => s.toLowerCase()));
  // Floored at 1: the || guards NaN and 0 but not a negative, and a negative would put both
  // deadlines in the past and report "still rate limited after -5s".
  const timeoutSec = Math.max(1, parseInt(input('timeout-seconds', '120'), 10) || 120);
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };

  // 1. Trigger the warm.
  const body = {};
  if (urls.length) body.urls = urls;
  if (locations.length) body.locations = locations;

  // The trigger gets its OWN retry budget, deliberately not the poll deadline: the poll budget
  // exists to wait for proof, and a trigger that never landed has no proof to wait for.
  const triggerDeadline = Date.now() + Math.min(timeoutSec, 30) * 1000;
  let res;
  for (;;) {
    try {
      res = await fetch(`${apiBase}/hooks/deploy`, { method: 'POST', headers, body: JSON.stringify(body) });
    } catch (e) {
      fail(`could not reach CinderCache at ${apiBase}: ${e.message}`);
      process.exit(1);
    }
    if (res.status !== 429) break;

    // Three different limits answer 429 and they need different handling, so discriminate on the
    // error CODE, never on the status alone. This mirrors docs/rate-limits.md: "Read the error code
    // before deciding what to do. Only rate_limited is retryable." A quota refusal cannot clear by
    // retrying (quota_exceeded never, monthly_quota_exceeded not until the month rolls over), so
    // retrying one would burn the budget and then report a rate limit as the cause, which is false.
    const eb = await errorBody(res);
    if (eb.code !== 'rate_limited') {
      fail(`warm trigger refused (${eb.code || `HTTP ${res.status}`}): ${detail(eb)}`);
      process.exit(1);
    }
    // Retrying a rate_limited trigger is safe without an Idempotency-Key: the account limiter
    // refuses before the payload is resolved, so nothing was enqueued and no warm can be doubled.
    // ⚠ That reasoning is specific to a 429 and does NOT generalise. Retrying a NETWORK error
    // would not be safe this way, because the request may well have landed and enqueued a job
    // before the connection broke; that path would need an Idempotency-Key to stay idempotent.
    // This is why the catch above fails rather than retrying.
    if (Date.now() >= triggerDeadline) {
      fail(`the warm could not be triggered: still rate limited after ${Math.min(timeoutSec, 30)}s.`);
      process.exit(1);
    }
    await sleep(retryAfterMs(res, triggerDeadline));
  }
  if (res.status === 404) {
    // Names BOTH causes deliberately. api-base is customer-settable, so a wrong base URL reaches a
    // valid host with no such route and 404s exactly like an unknown token. Blaming only the secret
    // sent the customer digging through their credentials over what was a typo in a URL.
    fail(`the warm endpoint returned 404: either the deploy token was not recognized, or api-base is wrong (using ${apiBase}).`);
    process.exit(1);
  }
  if (res.status !== 202) {
    const eb = await errorBody(res);
    fail(`warm trigger failed: HTTP ${res.status} ${eb.message || eb.code || detail(eb)}`);
    process.exit(1);
  }
  // Validate before use. An unexpected 202 body yields undefined here, which then went straight into
  // the poll URL as /hooks/deploy/jobs/undefined and printed "job undefined" -- a confusing failure
  // several steps away from its cause. The charset also keeps the id safe to interpolate.
  let accepted;
  try {
    accepted = await res.json();
  } catch {
    fail('the warm was accepted but the response could not be read as JSON. Please report it.');
    process.exit(1);
  }
  const jobId = accepted && accepted.job_id;
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9._-]+$/.test(jobId)) {
    fail('the warm was accepted but the response carried no usable job id. Please report it.');
    process.exit(1);
  }
  setOutput('job-id', jobId);
  notice(`CinderCache warm triggered: job ${jobId}`);
  if (!wait) {
    console.log('wait is false; not polling for proof.');
    process.exit(0);
  }

  // 2. Poll for completion.
  const deadline = Date.now() + timeoutSec * 1000;
  let job;
  for (;;) {
    let pr;
    try {
      pr = await fetch(`${apiBase}/hooks/deploy/jobs/${jobId}`, { headers });
    } catch (e) {
      // The same deadline rule as the 429 branch below: an unreachable server must not
      // hold the loop open past the timeout.
      if (Date.now() >= deadline) {
        warn(`timed out after ${timeoutSec}s waiting for the warm (no response from the server).`);
        break;
      }
      warn(`proof poll error (retrying): ${e.message}`);
      await sleep(3000);
      continue;
    }
    if (pr.status === 429) {
      // A rate-limited poll must still respect the deadline, or a server that keeps
      // answering 429 would hold the loop open forever.
      if (Date.now() >= deadline) {
        warn(`timed out after ${timeoutSec}s waiting for the warm (rate limited while polling).`);
        break;
      }
      await sleep(retryAfterMs(pr, deadline));
      continue;
    }
    if (!pr.ok) {
      fail(`proof read failed: HTTP ${pr.status}`);
      process.exit(1);
    }
    job = await pr.json();
    if (['done', 'failed', 'partial'].includes(job.status)) break;
    if (Date.now() >= deadline) {
      warn(`timed out after ${timeoutSec}s waiting for the warm (status: ${job.status}).`);
      break;
    }
    await sleep(3000);
  }
  // Reachable only via the timeout breaks above: no poll ever returned a readable job.
  // Same philosophy as a coverage gap: not the customer's build to break.
  if (!job) {
    setOutput('status', 'unknown');
    warn('no proof was read before the timeout. Not failing the build.');
    process.exit(0);
  }
  setOutput('status', job.status);

  // 3. Per-cell proof table.
  // A row is one (URL x location) cell, not one location: a multi-URL job reports several rows
  // per location, and a cell no node served is reported with a state of unserved.
  const results = job.results || [];
  console.log('');
  console.log(`CinderCache proof for job ${jobId} (status: ${job.status})`);
  console.log('  LOCATION        STATE         COLO     AGE   URL');
  for (const r of results) {
    console.log(
      `  ${String(r.location || '?').padEnd(14)}  ${String(r.state || '?').padEnd(12)}  ` +
        `${String(r.colo || '-').padEnd(6)}  ${String(r.age ?? '-').padEnd(4)}  ${r.url || '-'}`,
    );
  }

  // 4. Verdict.
  // Check the job status FIRST: a job whose tasks exhausted their retries without ever
  // reporting rolls up to 'failed' with NO result rows, which the per-result check below
  // cannot see. A 'partial' job is left to the per-result and coverage-gap handling.
  if (job.status === 'failed') {
    fail('the warm job failed (status: failed); no location was proven warm.');
    process.exit(1);
  }
  // The control plane sends the coverage summary and one row per requested cell, both derived
  // server-side. Never recount them here: a second implementation of the result model is exactly
  // what drifted before, when this file counted per result row and called the total "locations".
  // A job that never reached a terminal status (the poll timed out) carries no summary by
  // design, because its counts would report unreached cells as coverage gaps. Warn and pass:
  // the same philosophy as a coverage gap, it is not the customer's build to break.
  if (!['done', 'partial', 'failed'].includes(job.status)) {
    warn(`the warm did not finish before the timeout (status: ${job.status}). Not failing the build.`);
    process.exit(0);
  }

  const summary = job.summary;
  if (!summary) {
    fail(
      'the proof carried no summary, which means the CinderCache control plane is older than this action. ' +
        'Nothing is wrong with your build. Please report it.',
    );
    process.exit(1);
  }

  // A cell no node served is a coverage gap, not a failure. It is reported, never inferred.
  const uncovered = results.filter((r) => r.state === 'unserved');
  const lc = (r) => String(r.outcome || '').toLowerCase();
  const failing = results.filter((r) => failOn.has(lc(r)));

  console.log('');
  if (summary.proven) notice(`proven warm at ${summary.proven} of ${summary.total} cell(s).`);
  for (const r of results.filter((r) => lc(r) === 'inconclusive')) {
    warn(`inconclusive at ${r.location} (could not classify; not a failure).`);
  }
  // Collapse to distinct locations: a multi-URL job produces one unserved cell per URL, and
  // repeating the same location once per URL would read as several separate outages.
  for (const l of new Set(uncovered.map((r) => r.location))) {
    warn(`no CinderCache coverage at ${l} yet (not a failure).`);
  }

  if (failing.length) {
    for (const r of failing) fail(`${r.outcome} at ${r.location}${r.reason ? ': ' + r.reason : ''}`);
    fail(`warm failed at ${failing.length} cell(s) (fail-on: ${[...failOn].join(',')}).`);
    process.exit(1);
  }
  if (summary.proven) notice('CinderCache: warm verified.');
  else warn('CinderCache: nothing was proven warm (coverage gaps or inconclusive); not failing the build.');
  process.exit(0);
}

main().catch((e) => {
  // Message only by default. A stack trace here goes into a PUBLIC build log and carries absolute
  // runner paths, which is noise to the customer and detail we have no reason to publish. Anyone
  // actually debugging can re-run with debug logging on and get the whole thing.
  fail(`unexpected error: ${(e && e.message) || e}`);
  if (process.env.RUNNER_DEBUG === '1' && e && e.stack) console.log(e.stack);
  process.exit(1);
});
