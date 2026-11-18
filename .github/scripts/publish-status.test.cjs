'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { collect, publish, credentials, signingKey } = require('./publish-status.cjs');
const { verifyStatus, MAX_AGE } = require('./fixtures/launcher-0.4.61-verify-status.cjs');

test('a copied signing key must match the launcher before it can be used', () => {
 const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
 const pem = privateKey.export({ format: 'pem', type: 'pkcs8' });
 const expected = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
 assert.equal(signingKey(pem, expected).asymmetricKeyType, 'ed25519');
 assert.throws(() => signingKey(pem), /does not match the launcher/);
 assert.throws(() => signingKey('invalid private key', expected));
});

test('the shipped GitHub verifier accepts publisher snapshots and rejects stale or altered ones', async () => {
 const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
 const checkedAt = 1794997931552;
 const server = '185.135.83.35:7002';
 for (const [online, players] of [[true, 0], [true, 42], [false, 0], [false, null]]) {
  const envelope = await collect({
   token: 'wc_live_test_credential', key: privateKey, server, now: () => checkedAt,
   request: async url => Response.json(url.endsWith('/server') ? { online, player_count: players } : { online: players })
  });
  assert.equal(verifyStatus(envelope, publicKey, server, checkedAt + 5 * 60 * 1000).players, players);
  assert.equal(verifyStatus(envelope, publicKey, server, checkedAt + MAX_AGE).checkedAt, checkedAt);
  assert.throws(() => verifyStatus(envelope, publicKey, server, checkedAt + MAX_AGE + 1));
  assert.throws(() => verifyStatus(envelope, publicKey, server, checkedAt - 60001));
  assert.throws(() => verifyStatus(envelope, publicKey, 'wrong.invalid:7002', checkedAt));
  const altered = JSON.parse(Buffer.from(envelope.payload, 'base64'));
  altered.players = 99;
  assert.throws(() => verifyStatus({ ...envelope, payload: Buffer.from(JSON.stringify(altered)).toString('base64') }, publicKey, server, checkedAt));
 }
});

test('GitHub Actions retains its environment credential interface', () => {
 assert.deepEqual(credentials({ WARDEN_API_KEY: 'warden-test', STATUS_SIGNING_KEY: 'key-test', GH_TOKEN: 'github-test' }), {
  token: 'warden-test', key: 'key-test', githubToken: 'github-test'
 });
});

test('systemd credentials take priority and missing files fail closed', t => {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scumshot-credentials-'));
 const values = { 'warden-api-key': 'wc_live_test_credential', 'status-signing-key': 'test-PEM\nsecond-line', 'github-token': 'test-token' };
 t.after(() => {
  for (const name of Object.keys(values)) if (fs.existsSync(path.join(dir, name))) fs.unlinkSync(path.join(dir, name));
  fs.rmdirSync(dir);
 });
 for (const [name, value] of Object.entries(values)) fs.writeFileSync(path.join(dir, name), value + '\n');
 const env = { CREDENTIALS_DIRECTORY: dir, WARDEN_API_KEY: 'wrong', STATUS_SIGNING_KEY: 'wrong', GH_TOKEN: 'wrong' };
 assert.deepEqual(credentials(env), { token: values['warden-api-key'], key: values['status-signing-key'], githubToken: values['github-token'] });
 fs.unlinkSync(path.join(dir, 'github-token'));
 assert.throws(() => credentials(env), { code: 'ENOENT' });
});

test('the existing signed payload works outside Actions without exposing private data', async () => {
 const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
 const requests = [];
 const envelope = await collect({
  token: 'wc_live_test_credential', key: privateKey, server: 'example.invalid:7002',
  now: () => 1794997931552,
  request: async (url, options) => {
   requests.push(url);
   assert.equal(options.headers.Authorization, 'Bearer wc_live_test_credential');
   return Response.json({ online: true, player_count: 0, privatePlayerRecords: ['must stay private'] });
  }
 });
 const payload = Buffer.from(envelope.payload, 'base64');
 assert.equal(payload.toString('utf8'), '{"kind":"scumshot-public-status","version":1,"server":"example.invalid:7002","online":true,"players":0,"checkedAt":1794997931552}');
 assert.deepEqual(JSON.parse(payload), {
  kind: 'scumshot-public-status', version: 1, server: 'example.invalid:7002',
  online: true, players: 0, checkedAt: 1794997931552
 });
 assert.equal(crypto.verify(null, payload, publicKey, Buffer.from(envelope.signature, 'base64')), true);
 assert.deepEqual(requests, ['https://api.wardencore.ru/v1/server']);
});

test('publishing updates only server-status.json on the status branch', async () => {
 const requests = [];
 const envelope = { payload: 'test-payload', signature: 'test-signature' };
 await publish(envelope, {
  repo: 'example/status-test', token: 'test-github-token',
  request: async (url, options) => {
   requests.push({ url, options });
   if (requests.length === 1) return Response.json({ object: { sha: 'head-sha' } });
   if (requests.length === 2) return Response.json({ sha: 'previous-blob-sha' });
   return Response.json({ commit: { sha: 'new-commit-sha' } });
  }
 });
 assert.deepEqual(requests.map(({ url, options }) => [url, options.method]), [
  ['https://api.github.com/repos/example/status-test/git/ref/heads/status', 'GET'],
  ['https://api.github.com/repos/example/status-test/contents/server-status.json?ref=status', 'GET'],
  ['https://api.github.com/repos/example/status-test/contents/server-status.json', 'PUT']
 ]);
 const body = JSON.parse(requests[2].options.body);
 assert.equal(body.branch, 'status');
 assert.equal(body.sha, 'previous-blob-sha');
 assert.deepEqual(JSON.parse(Buffer.from(body.content, 'base64')), envelope);
});

test('a remote failure rejects collection instead of generating a fresh zero count', async () => {
 await assert.rejects(collect({
  token: 'wc_live_test_credential', key: 'unused', server: 'example.invalid:7002',
  request: async () => new Response('unavailable', { status: 503 })
 }), /Remote service rejected/);
});

test('a missing server identity fails before fetching or signing an invalid launcher payload', async () => {
 await assert.rejects(collect({
  token: 'wc_live_test_credential', key: 'unused',
  request: async () => assert.fail('must not fetch without a server identity')
 }), /Status server is not configured/);
});

test('the standalone command fails without leaking credentials when unconfigured', () => {
 const result = spawnSync(process.execPath, [path.join(__dirname, 'publish-status.cjs')], {
  env: { WARDEN_API_KEY: 'invalid-test-secret', GH_TOKEN: 'private-test-token' },
  encoding: 'utf8'
 });
 assert.equal(result.status, 1);
 assert.equal(result.stdout, '');
 assert.match(result.stderr, /Server status publication failed/);
 assert.doesNotMatch(result.stderr, /invalid-test-secret|private-test-token/);
});
