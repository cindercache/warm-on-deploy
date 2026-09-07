// Node test for the CinderCache GitHub Action. Runs index.js as a subprocess against a
// local mock of the deploy webhook, asserting the three-bucket exit policy and the HTTP
// flow. No external dependencies.
// Run with: node --test integrations/github-action/test.mjs
// ⚠ Name the FILE, not the directory: on Node 24 the directory form also discovers index.js
// and runs it as a test, which fails because no token is set.
import { test } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const indexJs = join(dirname(fileURLToPath(import.meta.url)), 'index.js');

// startMock answers POST /hooks/deploy (202 + job id) and GET .../jobs/j1 with the given
// results. triggerStatus lets a test force the trigger to fail (e.g. 404 unknown token).
// trigger429 makes the trigger answer 429 before succeeding: { code, times } where times is the
// number of 429s to send first (Infinity to never succeed). The code decides retryability, which
// is the contract the action must follow -- only rate_limited is retryable.
// startMock answers POST /hooks/deploy (202 + job id) and GET .../jobs/j1 with the given results.
// jobId overrides the id the trigger returns, which is how the id-validation test feeds it a hostile
// value. server.captured holds the parsed POST body: before it existed the body was accumulated and
// thrown away, so a regression that stopped forwarding urls/locations passed the whole suite green.
function startMock({ results = [], summary, status = 'done', triggerStatus = 202, pollStatus = 200, destroyPolls = false, trigger429 = null, jobId = 'j1' } = {}) {
  let sent429 = 0;
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/hooks/deploy') {
        try {
          server.captured = JSON.parse(b || '{}');
        } catch {
          server.captured = { unparseable: b };
        }
        if (trigger429 && sent429 < trigger429.times) {
          sent429++;
          const h = { 'content-type': 'application/json' };
          // Only rate_limited carries Retry-After, matching docs/rate-limits.md.
          if (trigger429.code === 'rate_limited') h['retry-after'] = '1';
          res.writeHead(429, h);
          return res.end(JSON.stringify({ error: trigger429.code, message: trigger429.message || '' }));
        }
        if (triggerStatus !== 202) {
          res.writeHead(triggerStatus);
          return res.end('{}');
        }
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ job_id: jobId, poll_path: '/hooks/deploy/jobs/j1' }));
      } else if (req.method === 'GET' && req.url === '/hooks/deploy/jobs/j1') {
        if (destroyPolls) return req.socket.destroy();
        if (pollStatus !== 200) {
          res.writeHead(pollStatus, { 'retry-after': '1' });
          return res.end('{}');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'j1', status, source: 'github_action', locations: ['IAD', 'LAX'], summary, results }));
      } else {
        res.writeHead(404);
        res.end('{}');
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

// parseOutputs reads a GITHUB_OUTPUT file the way the runner does, handling BOTH the bare `k=v` form
// and the `k<<DELIM ... DELIM` heredoc form, and returns the KEY SET. Asserting on the key set is what
// makes the injection test meaningful: a value carrying a newline shows up as extra top-level keys
// under the bare form and as no extra keys under the heredoc form.
function parseOutputs(text) {
  const keys = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const here = line.match(/^([^=<]+)<<(.+)$/);
    if (here) {
      keys.push(here[1]);
      while (i + 1 < lines.length && lines[i + 1] !== here[2]) i++;
      i++;
      continue;
    }
    const bare = line.match(/^([^=]+)=/);
    if (bare) keys.push(bare[1]);
  }
  return keys;
}

// ⚠ `...process.env` is spread into the child so node itself is found on PATH. The explicit entries
// come AFTER it and therefore win, but a contributor with a stray INPUT_* exported in their shell will
// see different behavior than CI. Deliberate, and cheap to remember.
function run(apiBase, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-action-'));
  const outFile = join(dir, 'out');
  writeFileSync(outFile, '');
  return new Promise((resolve) => {
    execFile(
      'node',
      [indexJs],
      // The child timeout is a test-hang guard only: a regression that loops forever gets
      // killed and fails its assertion instead of wedging the suite.
      { env: { ...process.env, INPUT_TOKEN: 'cc_hook_test', 'INPUT_API-BASE': apiBase, 'INPUT_TIMEOUT-SECONDS': '5', ...extraEnv, GITHUB_OUTPUT: outFile }, timeout: 15000 },
      (err, stdout, stderr) => {
        // Read the outputs BEFORE removing the directory. Previously this mkdtemp was never cleaned
        // up and roughly eight directories accumulated per suite run.
        let outputs = '';
        try {
          outputs = readFileSync(outFile, 'utf8');
        } catch {}
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {}
        resolve({ code: err ? err.code : 0, out: stdout + stderr, outputs });
      },
    );
  });
}

test('all proven -> pass (exit 0)', async () => {
  const srv = await startMock({
    summary: { total: 2, proven: 2, blocked: 0, failed: 0, inconclusive: 0, unknown: 0, unserved: 0 },
    results: [
      { location: 'IAD', state: 'verified', url: 'https://x/', outcome: 'proven', colo: 'IAD', age: 5 },
      { location: 'LAX', state: 'verified', url: 'https://x/', outcome: 'proven', colo: 'LAX', age: 3 },
    ],
  });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 0, out);
  assert.match(out, /warm verified/);
});

test('blocked -> fail (exit 1)', async () => {
  const srv = await startMock({
    summary: { total: 2, proven: 1, blocked: 1, failed: 0, inconclusive: 0, unknown: 0, unserved: 0 },
    results: [
      { location: 'IAD', state: 'verified', url: 'https://x/', outcome: 'proven', colo: 'IAD', age: 5 },
      { location: 'LAX', state: 'blocked', url: 'https://x/', outcome: 'blocked', colo: 'LAX', age: null, reason: 'zone blocks our warmer' },
    ],
  });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 1, out);
  assert.match(out, /::error::/);
});

test('inconclusive + uncovered location -> warn, pass (exit 0)', async () => {
  // LAX is requested but no node served it, so the control plane reports it as an unserved
  // cell rather than omitting the row. IAD is inconclusive.
  const srv = await startMock({
    summary: { total: 2, proven: 0, blocked: 0, failed: 0, inconclusive: 1, unknown: 0, unserved: 1 },
    results: [
      { location: 'IAD', state: 'inconclusive', url: 'https://x/', outcome: 'inconclusive', colo: 'IAD', age: 5 },
      { location: 'LAX', state: 'unserved', url: 'https://x/' },
    ],
  });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 0, out);
  assert.match(out, /::warning::/);
  assert.match(out, /no CinderCache coverage at LAX/);
});

test('failed job with no result rows -> fail (exit 1)', async () => {
  // Tasks that exhaust their retries roll up to a failed job with no results.
  const srv = await startMock({ status: 'failed', results: [] });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 1, out);
  assert.match(out, /job failed/);
});

test('unknown token (trigger 404) -> fail (exit 1)', async () => {
  const srv = await startMock({ triggerStatus: 404 });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 1, out);
  assert.match(out, /not recognized/);
});

test('job still running at the timeout -> warns, does not fail the build', async () => {
  // The control plane sends no summary until a job is terminal, because mid-flight its counters
  // would report unreached cells as coverage gaps. A poll that times out on a still-running job
  // must therefore warn and pass, never trip the missing-summary guard and break the build.
  const srv = await startMock({
    status: 'running',
    results: [
      { location: 'IAD', state: 'pending', url: 'https://x/' },
      { location: 'LAX', state: 'pending', url: 'https://x/' },
    ],
  });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`, { 'INPUT_TIMEOUT-SECONDS': '2' });
  srv.close();
  assert.equal(code, 0, out);
  assert.match(out, /did not finish before the timeout \(status: running\)/);
  assert.doesNotMatch(out, /older than this action/);
});

test('rate limited on every poll -> times out, warns, does not fail the build', async () => {
  const srv = await startMock({ pollStatus: 429 });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`, { 'INPUT_TIMEOUT-SECONDS': '2' });
  srv.close();
  assert.equal(code, 0);
  assert.match(out, /timed out after 2s waiting for the warm \(rate limited while polling\)/);
  assert.match(out, /no proof was read before the timeout/);
});

test('server unreachable on every poll -> times out, warns, does not fail the build', async () => {
  const srv = await startMock({ destroyPolls: true });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`, { 'INPUT_TIMEOUT-SECONDS': '2' });
  srv.close();
  assert.equal(code, 0);
  assert.match(out, /timed out after 2s waiting for the warm \(no response from the server\)/);
  assert.match(out, /no proof was read before the timeout/);
});

test('rate_limited on the trigger, then accepted -> retries and passes (exit 0)', async () => {
  // The trigger is rate limited once and then succeeds. Before the retry existed this exited 1
  // and broke the customer's build over a limit that clears in a second.
  const srv = await startMock({
    trigger429: { code: 'rate_limited', times: 1, message: 'too many requests for this account' },
    summary: { total: 1, proven: 1, blocked: 0, failed: 0, inconclusive: 0, unknown: 0, unserved: 0 },
    results: [{ location: 'EWR', state: 'verified', url: 'https://x/', outcome: 'proven', colo: 'EWR', age: 4 }],
  });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 0, out);
  assert.match(out, /warm verified/);
});

test('rate_limited on every trigger -> gives up inside the budget and fails (exit 1)', async () => {
  // Bounded: the trigger budget is min(timeout-seconds, 30), so 2 here keeps the suite fast and
  // proves the loop terminates rather than spinning until the runner kills the job.
  const srv = await startMock({ trigger429: { code: 'rate_limited', times: Infinity } });
  const started = Date.now();
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`, { 'INPUT_TIMEOUT-SECONDS': '2' });
  srv.close();
  assert.strictEqual(code, 1, out);
  assert.match(out, /still rate limited after 2s/);
  assert.ok(Date.now() - started < 12000, `took too long: ${Date.now() - started}ms`);
});

test('monthly_quota_exceeded on the trigger -> fails fast, no retry, surfaces the reason', async () => {
  // The case that pins the CONTRACT discrimination: docs/rate-limits.md says only rate_limited is
  // retryable. An implementation keyed on the 429 status alone would retry this until the budget
  // ran out and then blame a rate limit, hiding a refusal that cannot clear until the month rolls.
  const srv = await startMock({
    trigger429: {
      code: 'monthly_quota_exceeded',
      times: Infinity,
      message: "this warm would exceed your plan's monthly limit of 1000 URLs, which resets on 2026-10-01",
    },
  });
  const started = Date.now();
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`, { 'INPUT_TIMEOUT-SECONDS': '30' });
  srv.close();
  const elapsed = Date.now() - started;
  assert.strictEqual(code, 1, out);
  assert.match(out, /monthly_quota_exceeded/);
  assert.match(out, /resets on 2026-10-01/);
  // No retry at all: a retrying implementation would burn the full 30s budget first.
  assert.ok(elapsed < 5000, `should fail fast without retrying, took ${elapsed}ms`);
});

// --- Hostile-server cases. The API is ours, but this action runs on the CUSTOMER'S runner and writes
// --- into GitHub's control channels, so it defends itself rather than trusting the response.

test('a job status carrying a newline cannot inject extra GITHUB_OUTPUT entries', async () => {
  // setOutput writes a heredoc with a random delimiter. Under the old bare `k=v` form this status
  // would have appended a second, forged top-level output that later workflow steps would read as
  // ours. The assertion is on the KEY SET, because that is the property that actually matters.
  const srv = await startMock({ status: 'done\nFORGED_OUTPUT=owned' });
  const { outputs } = await run(`http://127.0.0.1:${srv.address().port}`, { 'INPUT_TIMEOUT-SECONDS': '2' });
  srv.close();
  const keys = parseOutputs(outputs);
  assert.deepStrictEqual(keys.sort(), ['job-id', 'status'], `unexpected output keys in:\n${outputs}`);
  assert.ok(!keys.includes('FORGED_OUTPUT'), `injected key present in:\n${outputs}`);
});

test('a server-supplied reason cannot forge a workflow command', async () => {
  // Both encodings in ONE payload on purpose. A literal newline puts ::error:: at the start of a line,
  // which is what makes it a command; %0A is the same attack through GitHub's url-decoding of the
  // message portion. Stripping only one leaves a guard that looks present and is half absent.
  const srv = await startMock({
    summary: { total: 1, proven: 0, blocked: 1, failed: 0, inconclusive: 0, unknown: 0, unserved: 0 },
    results: [
      {
        location: 'IAD',
        state: 'blocked',
        url: 'https://x/',
        outcome: 'blocked',
        reason: 'boom\n::error::forged-literal and %0A::error::forged-encoded',
      },
    ],
  });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 1, out);
  // A forged command only executes if it STARTS a line, so the multiline anchor is the real test.
  assert.doesNotMatch(out, /^::error::forged-literal/m, `literal newline survived:\n${out}`);
  // And the encoded form must not reach the log at all, since GitHub would decode it there.
  assert.doesNotMatch(out, /%0[aA]/, `encoded newline survived:\n${out}`);
});

test('an unusable job id is rejected before it is used', async () => {
  // Previously an unexpected 202 body yielded `undefined`, which flowed into the poll URL as
  // /hooks/deploy/jobs/undefined and surfaced as "job undefined" several steps from its cause.
  const srv = await startMock({ jobId: 'j1\nFORGED=1' });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`);
  srv.close();
  assert.strictEqual(code, 1, out);
  assert.match(out, /no usable job id/);
});

test('wait:false -> exits 0 without polling, sets job-id and not status', async () => {
  const srv = await startMock({});
  const { code, out, outputs } = await run(`http://127.0.0.1:${srv.address().port}`, { INPUT_WAIT: 'false' });
  srv.close();
  assert.strictEqual(code, 0, out);
  assert.match(out, /not polling for proof/);
  assert.deepStrictEqual(parseOutputs(outputs), ['job-id'], `expected job-id only, got:\n${outputs}`);
});

test('custom fail-on and the request body actually carries urls and locations', async () => {
  // Two properties in one case. fail-on: `inconclusive` is a PASS by default, so failing on it proves
  // the input is read rather than the default being hardcoded. And the mock now records the POST body:
  // before it did, a regression that stopped sending urls/locations passed every test green.
  const srv = await startMock({
    summary: { total: 1, proven: 0, blocked: 0, failed: 0, inconclusive: 1, unknown: 0, unserved: 0 },
    results: [{ location: 'EWR', state: 'inconclusive', url: 'https://example.com/a', outcome: 'inconclusive' }],
  });
  const { code, out } = await run(`http://127.0.0.1:${srv.address().port}`, {
    'INPUT_FAIL-ON': 'inconclusive',
    INPUT_URLS: 'https://example.com/a?ids=1,2,3\nhttps://example.com/b',
    INPUT_LOCATIONS: 'EWR,ORD',
  });
  srv.close();
  assert.strictEqual(code, 1, out);
  assert.match(out, /inconclusive at EWR/);
  // urls split on WHITESPACE only, so the comma inside the query string must survive intact.
  assert.deepStrictEqual(srv.captured.urls, ['https://example.com/a?ids=1,2,3', 'https://example.com/b']);
  // locations are documented comma-separated and still split on the comma.
  assert.deepStrictEqual(srv.captured.locations, ['EWR', 'ORD']);
});
