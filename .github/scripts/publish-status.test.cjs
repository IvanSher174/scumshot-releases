'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');
const { collect, publish } = require('./publish-status.cjs');

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
