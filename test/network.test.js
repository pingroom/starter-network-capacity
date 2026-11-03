import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, localReport, exportProposal } from '../src/engine.js';
import { readJson, atomicJson, acquireLock, atomicText } from '../src/storage.js';
import { validateInput, validateState, tasksFor, parseCapacity, networkCapacity, maximumFlow, verifyCertificate, MAX_CAPACITY, MAX_TOTAL, requestFor, validateConfig, hash, iso, isId, ROOM } from '../src/model.js';
import { loadConnection, loadEnvironment, validateConnection } from '../src/config.js';
import { makeClient } from '../src/client.js';
import { mockApi, CONFIG, ROOM_CODE, OTHER, ASKER, id } from '../src/mock.js';

const example = await readJson(new URL('../examples/network.json', import.meta.url), 65536);
const simple = () => structuredClone(example);
const twoItems = () => structuredClone(example);
async function setup(t, input = simple()) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-network-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = { value: '2026-01-01T09:00:00.000Z' }, now = () => clock.value;
  const api = mockApi(now);
  const options = { client: api.client, directory, input, config: structuredClone(CONFIG), token: 'offline-fixture-token', room: ROOM_CODE, now };
  return { directory, clock, api, options, run: (extra = {}) => step({ ...options, ...extra }), saved: () => readJson(join(directory, 'state.json')) };
}
const sends = (api) => api.calls.filter((call) => call.method === 'POST').length;
async function decide(s, decisions) {
  let result;
  for (const value of decisions) {
    result = await s.run();
    const pending = result.answers.find(item => item.status === 'pending');
    s.api.answer(pending.questionId, value); result = await s.run();
  }
  return result;
}

test('lost response blocks later capacities; exact-ID recovery reads the original request without resend', async (t) => {
  const s = await setup(t, twoItems()); s.api.controls.loseNext = true;
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal((await s.run()).status, 'create_unknown');
  assert.deepEqual((await s.run({ command: 'find' })).candidates, [{ id: id(1), state: 'pending' }]);
  s.api.answer(id(1), '5'); assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'ready');
  assert.equal(sends(s.api), 1);
});

test('malformed create response and empty search never authorize a new POST', async (t) => {
  const s = await setup(t); s.api.controls.malformedNext = true; await assert.rejects(s.run());
  assert.equal((await s.saved()).attempts[0].status, 'creating'); s.api.questions.clear();
  assert.deepEqual((await s.run({ command: 'find' })).candidates, []);
  assert.equal((await s.run()).status, 'create_unknown'); assert.equal(sends(s.api), 1);
});

test('recovery validates exact target, room, request, options, data and ncapacityoff provenance', async (t) => {
  for (const mutate of [
    (q) => { q.target_user_id = OTHER; }, (q) => { q.room.code = 'WRONG1234567'; }, (q) => { q.prompt = 'Other prompt'; },
    (q) => { q.options = [{value:'yes',label:'Yes'}]; }, (q) => { q.text_input.max_length = 30; }, (q) => { q.text_input = null; },
    (q) => { q.data.task_id = 'other'; }, (q) => { q.data.input_hash = 'changed'; }, (q) => { delete q.is_handoff; },
    (q) => { q.is_handoff = true; }, (q) => { q.asker.type = 'user'; }, (q) => { q.resolution_policy = 'all'; },
  ]) {
    const s = await setup(t); s.api.controls.loseNext = true; await s.run(); mutate(s.api.questions.get(id(1)));
    await assert.rejects(s.run({ command: 'recover', attachId: id(1) })); assert.equal((await s.saved()).attempts[0].status, 'creating');
    assert.equal(sends(s.api), 1);
  }
});

test('misattributed, malformed or non-text answers never resolve a count', async (t) => {
  for (const mutate of [
    (q) => { q.answer.responder.id = OTHER; }, (q) => { q.answer.responder = null; },
    (q) => { q.answer.text = '1e2'; }, (q) => { q.answer.value = 'unsupported'; }, (q) => { q.answer.label = 'Wrong'; },
  ]) {
    const s = await setup(t); await s.run(); s.api.answer(id(1), '5'); mutate(s.api.questions.get(id(1)));
    const result = await s.run(); assert.equal(result.observedStatus, 'invalid_answer'); assert.equal(result.proposal, null);
    assert.equal(sends(s.api), 1);
  }
});

test('original asker, lifetime and intent remain bound across reads and across capacities', async (t) => {
  for (const mutate of [
    (q) => { q.asker.id = OTHER; },
    (q) => { q.created_at = '2026-01-01T09:00:01.000Z'; q.expires_at = '2026-01-01T09:15:01.000Z'; },
  ]) {
    const s = await setup(t); await s.run(); mutate(s.api.questions.get(id(1))); await assert.rejects(s.run(), /identity or lifetime/);
  }
  const s = await setup(t, twoItems()); await s.run(); s.api.answer(id(1), '5'); await s.run();
  s.api.controls.loseNext = true; await s.run(); s.api.questions.get(id(2)).asker.id = OTHER;
  await assert.rejects(s.run({ command: 'recover', attachId: id(2) }), /different asking registrations/);
  const other = await setup(t); other.api.controls.loseNext = true; await other.run();
  const q = other.api.questions.get(id(1)); q.created_at = '2026-01-01T08:58:59.000Z'; q.expires_at = '2026-01-01T09:13:59.000Z';
  await assert.rejects(other.run({ command: 'recover', attachId: id(1) }), /predates/);
});

test('expiry accepts delayed processing but rejects premature and implausibly future resolution on replay', async (t) => {
  const s = await setup(t); await s.run(); s.clock.value = '2026-01-01T09:16:00.000Z';
  s.api.terminal(id(1), 'expired'); s.api.questions.get(id(1)).resolved_at = '2026-01-01T09:15:30.000Z';
  assert.equal((await s.run()).observedStatus, 'expired'); assert.equal((await localReport(s.directory, s.options.input)).proposal, null);
  const original = await s.saved();
  for (const timestamp of ['2026-01-01T09:14:59.999Z', '2026-01-01T09:17:00.001Z']) {
    const saved = structuredClone(original); saved.attempts[0].observation.resolvedAt = timestamp;
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run(), /resolution time/); assert.equal(s.api.calls.length, calls);
    const live = await setup(t); await live.run(); live.clock.value = s.clock.value; live.api.terminal(id(1), 'expired');
    live.api.questions.get(id(1)).resolved_at = timestamp; await assert.rejects(live.run(), /resolution time/);
  }
});

test('answer and resolution times must agree and answer/cancellation cannot occur after expiry', async (t) => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '5');
  s.api.questions.get(id(1)).answer.answered_at = '2026-01-01T09:00:01.000Z';
  assert.equal((await s.run()).observedStatus, 'invalid_answer');
  for (const terminal of ['answered', 'cancelled']) {
    const other = await setup(t); await other.run(); other.clock.value = '2026-01-01T09:16:00.000Z';
    if (terminal === 'answered') other.api.answer(id(1), '5'); else other.api.terminal(id(1), terminal);
    await assert.rejects(other.run(), /resolution time/);
  }
});

test('checked time follows response; future creation, wrong TTL and answer on pending fail', async (t) => {
  const s = await setup(t); await s.run(); const get = s.api.client.questions.get.bind(s.api.client.questions);
  s.api.client.questions.get = async (...args) => { s.clock.value = '2026-01-01T09:02:00.000Z'; s.api.answer(id(1), '5'); return get(...args); };
  await s.run(); assert.equal((await s.saved()).attempts[0].observation.checkedAt, s.clock.value);
  for (const mutate of [
    (q) => { q.created_at = '2027-01-01T09:00:00.000Z'; q.expires_at = '2027-01-01T09:15:00.000Z'; },
    (q) => { q.expires_at = '2026-01-01T10:00:00.000Z'; }, (q) => { q.answer = {}; },
  ]) { const other = await setup(t); await other.run(); mutate(other.api.questions.get(id(1))); await assert.rejects(other.run()); }
  assert.equal(iso('2026-01-01T09:00:00+00:00'), '2026-01-01T09:00:00.000Z'); assert.throws(() => iso('2026-02-30T09:00:00Z'));
});

test('room preflight refuses public/unsupported rooms and missing operator before a POST', async (t) => {
  for (const mutate of [(rooms) => { rooms[0].is_public = true; }, (rooms) => { rooms[0].type = 'dm'; }, (rooms) => { rooms[0].members = [{ user_id: OTHER }]; }]) {
    const s = await setup(t); mutate(s.api.rooms); await assert.rejects(s.run()); assert.equal(sends(s.api), 0);
  }
});

test('reservation write failure sends nothing; answer save failure resumes the original question', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 2) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal(sends(s.api), 0); await s.run(); s.api.answer(id(1), '5');
  await assert.rejects(s.run({ write: async () => { throw new Error('disk full'); } }), /disk full/);
  assert.equal((await s.saved()).attempts[0].status, 'pending'); assert.equal((await s.run()).status, 'ready'); assert.equal(sends(s.api), 1);
});

test('post-create save failure leaves uncertain intent for verified recovery without another POST', async (t) => {
  const s = await setup(t); let writes = 0;
  await assert.rejects(s.run({ write: async (...args) => { if (++writes === 3) throw new Error('disk full'); await atomicJson(...args); } }), /disk full/);
  assert.equal((await s.run()).status, 'create_unknown');
  assert.equal((await s.run({ command: 'recover', attachId: id(1) })).status, 'pending'); assert.equal(sends(s.api), 1);
});

test('failed reads preserve evidence and corrupted request/provenance fail before network', async (t) => {
  const s = await setup(t); await s.run(); const before = await readFile(join(s.directory, 'state.json'), 'utf8');
  s.api.controls.readError = true; await assert.rejects(s.run()); assert.equal(await readFile(join(s.directory, 'state.json'), 'utf8'), before);
  s.api.controls.readError = false; s.api.answer(id(1), '5'); await s.run(); const original = await s.saved();
  for (const mutate of [
    (saved) => { saved.attempts[0].request.ttl = 60; }, (saved) => { saved.attempts.push(saved.attempts[0]); },
    (saved) => { saved.attempts[0].pair = 'other::pair'; }, (saved) => { saved.attempts[0].observation.answer.responderId = OTHER; },
  ]) {
    const saved = structuredClone(original); mutate(saved); assert.throws(() => validateState(saved, s.options.input));
    await atomicJson(s.directory, 'state.json', saved); const calls = s.api.calls.length;
    await assert.rejects(s.run()); assert.equal(s.api.calls.length, calls);
  }
});

test('bounded file reads reject malformed, oversized, invalid UTF-8 and symlink data without revealing contents', async (t) => {
  const s = await setup(t), path = join(s.directory, 'bad.json');
  await writeFile(path, '{"secret":"PRIVATE_TOKEN",bad');
  await assert.rejects(readJson(path), (error) => !error.message.includes('PRIVATE_TOKEN') && error.message.includes('malformed'));
  await writeFile(path, Buffer.from([0xff])); await assert.rejects(readJson(path), /UTF-8/);
  await writeFile(path, 'x'.repeat(100)); await assert.rejects(readJson(path, 50), /size limit/);
  await symlink(path, join(s.directory, 'linked')); await assert.rejects(readJson(join(s.directory, 'linked')));
});

test('private lock excludes other commands; report is offline and private', async (t) => {
  const s = await setup(t); await s.run(); const release = await acquireLock(s.directory);
  await assert.rejects(s.run(), /lock exists/); await assert.rejects(localReport(s.directory, s.options.input), /lock exists/);
  await release(); const before = s.api.calls.length;
  assert.equal((await localReport(s.directory, s.options.input, { save: true })).proposal, null); assert.equal(s.api.calls.length, before);
  assert.equal((await stat(join(s.directory, 'report.json'))).mode & 0o777, 0o600);
});

test('partial or blank environment overrides never combine with saved credentials', async (t) => {
  const s = await setup(t); await atomicJson(s.directory, 'credentials.json', { token: 'saved', room: ROOM_CODE });
  await assert.rejects(loadConnection(s.directory, { PINGROOM_TOKEN: '' })); await assert.rejects(loadConnection(s.directory, { PINGROOM_ROOM: ROOM_CODE }));
  assert.equal((await loadConnection(s.directory, { PINGROOM_TOKEN: 'explicit', PINGROOM_ROOM: ROOM_CODE.toLowerCase() })).token, 'explicit');
});

test('transport rejects unrelated writes, redirects and oversized responses', async () => {
  let count = 0; const client = makeClient({ token: 'fixture', fetchImpl: async () => { count++; return new Response(null, { status: 302 }); } });
  await assert.rejects(client.questions.get(id(1))); assert.equal(count, 1); await assert.rejects(client.questions.cancel(id(1))); assert.equal(count, 1);
  const large = makeClient({ token: 'fixture', fetchImpl: async () => new Response('x'.repeat(512 * 1024 + 1)) }); await assert.rejects(large.questions.get(id(1)));
});

test('transport deadlines bound stalled fetch/body and allow abort through infinite ready empty chunks', async () => {
  const stalled = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: () => new Promise(() => {}) }); await assert.rejects(stalled.questions.get(id(1)));
  const body = makeClient({ token: 'fixture', deadlineMs: 20, fetchImpl: async () => new Response(new ReadableStream({ pull: () => new Promise(() => {}) })) }); await assert.rejects(body.questions.get(id(1)));
  const controller = new AbortController();
  const empty = makeClient({ token: 'fixture', signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({ pull: (out) => out.enqueue(new Uint8Array()) })) });
  const timer = setTimeout(() => controller.abort(), 20); try { await assert.rejects(empty.questions.get(id(1))); } finally { clearTimeout(timer); }
});

test('abort before reservation sends nothing; after reservation it preserves unresolved intent', async (t) => {
  const s = await setup(t), stopped = new AbortController(); stopped.abort(); await assert.rejects(s.run({ signal: stopped.signal })); assert.equal(sends(s.api), 0);
  const controller = new AbortController(); let writes = 0;
  await assert.rejects(s.run({ signal: controller.signal, write: async (...args) => { await atomicJson(...args); if (++writes === 2) controller.abort(); } }));
  assert.equal(sends(s.api), 0); assert.equal((await s.run()).status, 'create_unknown');
});


test('partial external credentials cannot borrow the room from dotenv', async (t) => {
  const s = await setup(t), path = join(s.directory, '.env');
  await writeFile(path, 'PINGROOM_TOKEN=file-token\nPINGROOM_ROOM=DEMO12345678\n');
  const partial = { PINGROOM_TOKEN: 'shell-token' }; await loadEnvironment(partial, path);
  assert.equal(partial.PINGROOM_ROOM, undefined); await assert.rejects(loadConnection(s.directory, partial));
  const env = {}; await loadEnvironment(env, path); assert.deepEqual(await loadConnection(s.directory, env), { token: 'file-token', room: ROOM_CODE });
});



const answerRows = (input, values = {}) => tasksFor(input).map(link => ({ linkId: link.id, text: String(values[link.id] ?? 0) }));
function graph(nodes, edges) {
  return { networkId: 'fixture', title: 'Fixture network', unit: 'cards per hour', period: 'One simultaneous practice hour',
    nodes: nodes.map(id => ({ id, label: id })), source: 's', sink: 't', links: edges.map(([from, to]) => ({ id: from + to, from, to, label: `${from} to ${to}` })) };
}
function minCutOracle(input, capacities) {
  const inner = input.nodes.map(node => node.id).filter(id => ![input.source, input.sink].includes(id));
  let best = Infinity;
  for (let mask = 0; mask < 2 ** inner.length; mask++) {
    const side = new Set([input.source, ...inner.filter((_, index) => mask & (1 << index))]);
    let capacity = 0;
    for (const edge of input.links) if (side.has(edge.from) && !side.has(edge.to)) capacity += capacities[edge.id];
    best = Math.min(best, capacity);
  }
  return best;
}

test('strict capacity grammar accepts zero and Unknown without normalization', () => {
  assert.deepEqual(parseCapacity('0'), { kind: 'quantity', capacity: 0 });
  assert.deepEqual(parseCapacity('999999'), { kind: 'quantity', capacity: 999999 });
  assert.deepEqual(parseCapacity('Unknown'), { kind: 'unknown', capacity: null });
  for (const text of ['', 'unknown', ' Unknown', 'Unknown ', '00', '01', '-1', '-0', '+1', '1.0', '1e2', '1000000',
    '1 2', '1,000', '1\n', '1\r\n', '1\u2028', '1\u2029', '１２', '١', null, 1]) assert.throws(() => parseCapacity(text));
});

test('split paths produce feasible original-link flows and matching minimum cut', async t => {
  const s = await setup(t), result = await decide(s, ['5', '4', '3', '6']);
  assert.equal(result.status, 'complete'); assert.equal(result.certificate.value, 7);
  assert.deepEqual(result.certificate.cut.crossingLinkIds, ['intake-south', 'north-archive']);
  assert.equal(result.certificate.cut.capacity, 7);
  assert.equal(result.certificate.links.find(link => link.id === 'intake-north').flow, 3);
  assert.equal(result.certificate.links.find(link => link.id === 'intake-south').flow, 4);
});

test('reverse residual rerouting cancels an earlier path, including with an antiparallel original', () => {
  const input = graph(['s', 'a', 'b', 'c', 'd', 't'], [['s','a'],['s','b'],['a','c'],['a','d'],['b','c'],['c','t'],['d','t']]);
  const capacities = Object.fromEntries(input.links.map(link => [link.id, 1]));
  const result = maximumFlow(input, capacities);
  assert.equal(result.value, 2); assert.equal(result.links.find(link => link.id === 'ac').flow, 0);
  assert.deepEqual(result.links.filter(link => link.flow).map(link => link.id), ['ad','bc','ct','dt','sa','sb']);
  const parallel = structuredClone(input); parallel.links.push({ id: 'ca', from: 'c', to: 'a', label: 'Original reverse link' });
  const other = maximumFlow(parallel, { ...capacities, ca: 1 });
  assert.equal(other.value, 2); assert.equal(other.links.find(link => link.id === 'ac').flow, 0); assert.equal(other.links.find(link => link.id === 'ca').flow, 0);
});

test('6561 independent cut comparisons include cycles, antiparallel links, source incoming and sink outgoing links', () => {
  const input = graph(['s','a','b','t'], [['s','a'],['s','b'],['a','b'],['b','a'],['a','t'],['b','t'],['t','s'],['t','a']]);
  for (let code = 0; code < 3 ** 8; code++) {
    let digits = code;
    const capacities = Object.fromEntries(input.links.map(link => { const value = digits % 3; digits = Math.floor(digits / 3); return [link.id, value]; }));
    const result = maximumFlow(input, capacities);
    assert.equal(result.value, minCutOracle(input, capacities), `capacity assignment ${code}`); assert.equal(result.cut.capacity, result.value);
    for (const row of result.balances) assert.equal(row.net, row.nodeId === 's' ? result.value : row.nodeId === 't' ? -result.value || 0 : 0);
    for (const row of result.links) assert.ok(row.flow >= 0 && row.flow <= capacities[row.id]);
  }
});

test('zero capacities, disconnected sink and unrelated cycles yield complete zero throughput', async t => {
  const input = graph(['s','a','b','t'], [['s','a'],['a','b'],['b','a'],['t','s']]);
  const result = maximumFlow(input, { sa: 8, ab: 9, ba: 9, ts: 999999 });
  assert.equal(result.value, 0); assert.deepEqual(result.cut.sourceSide, ['a','b','s']); assert.equal(result.cut.capacity, 0);
  assert.deepEqual(result.cut.crossingLinkIds, []); assert.ok(result.links.every(link => link.flow === 0));
  const s = await setup(t); const completed = await decide(s, ['0','0','0','0']);
  assert.equal(completed.status, 'complete'); assert.equal(completed.certificate.value, 0); assert.equal((await exportProposal(s.directory, s.options.input)).certificate.value, 0);
});

test('largest input capacities remain exact and all 64 cuts of an eight-node graph are checked', () => {
  const input = graph(['s','a','b','c','d','e','f','t'], [['s','t'],['s','a'],['a','t'],['s','b'],['b','t'],['c','d'],['d','e'],['e','f']]);
  const capacities = Object.fromEntries(input.links.map(link => [link.id, MAX_CAPACITY]));
  const result = maximumFlow(input, capacities);
  assert.equal(result.value, 3 * MAX_CAPACITY); assert.equal(result.value, minCutOracle(input, capacities)); assert.ok(result.value <= MAX_TOTAL); assert.equal(MAX_TOTAL, 7999992);
  for (const bad of [-1, -0, 1.5, NaN, Infinity, 1000000, Number.MAX_SAFE_INTEGER, '1', null]) assert.throws(() => maximumFlow(input, { ...capacities, st: bad }));
  for (const bad of [{ ...capacities, extra: 1 }, {}]) assert.throws(() => maximumFlow(input, bad));
});

test('certificate validator rejects infeasible, nonmaximal, mismatched and forged output', () => {
  const input = graph(['s','a','t'], [['s','a'],['a','t']]), capacities = { sa: 3, at: 2 }, original = maximumFlow(input, capacities);
  for (const mutate of [v => v.links[0].flow = -1, v => v.links[0].capacity++, v => v.links[0].remaining++, v => v.links[0].to = 's',
    v => v.links.reverse(), v => v.value++, v => v.balances[0].incoming++, v => v.cut.capacity++, v => v.cut.sourceSide = ['s'],
    v => v.cut.crossingLinkIds = [], v => v.cut.sinkSide.push('s'), v => v.links[0].unexpected = true, v => v.balances[0].unexpected = true, v => v.cut.unexpected = true]) {
    const bad = structuredClone(original); mutate(bad); assert.throws(() => verifyCertificate(input, capacities, bad));
  }
  const suboptimal = structuredClone(original); suboptimal.value = 0;
  for (const row of suboptimal.links) { row.flow = 0; row.remaining = row.capacity; }
  for (const row of suboptimal.balances) { row.incoming = 0; row.outgoing = 0; row.net = 0; }
  assert.throws(() => verifyCertificate(input, capacities, suboptimal), /augmenting/); assert.equal(verifyCertificate(input, capacities, original), original);
});

test('canonical node/link ordering preserves session binding and deterministic flow choice', async t => {
  const input = structuredClone(example), permuted = structuredClone(example); permuted.nodes.reverse(); permuted.links.reverse();
  assert.deepEqual(validateInput(input), validateInput(permuted));
  const capacities = Object.fromEntries(tasksFor(input).map((link, index) => [link.id, index + 1]));
  assert.deepEqual(maximumFlow(input, capacities), maximumFlow(permuted, capacities));
  const s = await setup(t); await s.run(); await s.run({ input: permuted }); assert.equal(sends(s.api), 1);
});

test('Unknown on any link, including an irrelevant link, blocks the whole certificate', async t => {
  const input = graph(['s','a','b','t'], [['s','t'],['a','b']]);
  assert.equal(networkCapacity(input, answerRows(input, { st: 5, ab: 'Unknown' })).certificate, null);
  assert.equal(networkCapacity(input, tasksFor(input).map(link => ({ linkId: link.id, text: null }))).status, 'incomplete');
  const s = await setup(t); const result = await decide(s, ['Unknown','0','0','0']);
  assert.equal(result.status, 'incomplete'); assert.equal(result.proposal, null); assert.equal(result.certificate, null); await assert.rejects(exportProposal(s.directory, s.options.input));
});

test('invalid graph schemas and duplicate endpoint pairs fail before API', async t => {
  const mutations = [v => v.nodes = [], v => v.nodes.push(v.nodes[0]), v => v.source = v.sink, v => v.source = 'absent',
    v => v.links = [], v => v.links.push(v.links[0]), v => v.links[0].from = 'absent', v => v.links[0].from = v.links[0].to,
    v => v.links.push({ ...v.links[0], id: 'other' }), v => v.links[0].capacity = 5, v => v.nodes[0].id = 'constructor',
    v => v.unit = '', v => v.period = '', v => v.title += '\n', v => v.links[0].id = 'prototype'];
  const s = await setup(t);
  for (const mutate of mutations) { const input = structuredClone(example); mutate(input); await assert.rejects(s.run({ input })); }
  const extra = structuredClone(example); extra['unit,period'] = 'combined'; delete extra.unit; delete extra.period;
  assert.throws(() => validateInput(extra)); assert.equal(s.api.calls.length, 0); assert.equal(await s.saved(), null);
});

test('maximum Unicode prompts show endpoints and units within API bounds', async t => {
  const input = graph(['s','a','b','c','d','e','f','t'], [['s','t'],['s','a'],['a','t'],['s','b'],['b','t'],['c','d'],['d','e'],['e','f']]);
  const mapping = Object.fromEntries(input.nodes.map(node => [node.id, node.id.repeat(16)]));
  input.source = mapping[input.source]; input.sink = mapping[input.sink];
  input.nodes = input.nodes.map(node => ({ ...node, id: mapping[node.id] }));
  input.links = input.links.map(link => ({ ...link, from: mapping[link.from], to: mapping[link.to] }));
  input.title = '🙂'.repeat(20); input.unit = '🙂'.repeat(12); input.period = '🙂'.repeat(30);
  for (const node of input.nodes) node.label = '🙂'.repeat(15);
  input.links = input.links.map((link, index) => ({ ...link, id: 'a'.repeat(15) + index, label: '🙂'.repeat(20) }));
  const s = await setup(t, input); assert.equal((await s.run()).status, 'pending');
  for (const link of tasksFor(input)) {
    const q = requestFor(input, CONFIG, link.id, id(1)); assert.ok(q.prompt.length <= 500); assert.equal(q.context.length, 39);
    assert.ok(q.prompt.includes(input.period)); assert.ok(q.prompt.includes(input.unit));
    assert.ok(q.prompt.includes(`[${link.from}]`)); assert.ok(q.prompt.includes(`[${link.to}]`)); assert.equal(q.text_input.max_length, 60);
  }
});

test('units, period, source, link identity and operator cannot change within a session', async t => {
  const s = await setup(t); await s.run(); const before = s.api.calls.length;
  for (const mutate of [v => v.period = 'Different hour', v => v.unit = 'Other unit', v => v.title = 'Other',
    v => v.source = 'north', v => v.links[0].label = 'Other direction', v => v.nodes[0].label = 'Other desk']) {
    const input = structuredClone(s.options.input); mutate(input); await assert.rejects(s.run({ input })); await assert.rejects(exportProposal(s.directory, input));
  }
  await assert.rejects(s.run({ config: { participant: { ...CONFIG.participant, id: OTHER } } })); assert.equal(s.api.calls.length, before);
});

test('private export preserves full source, attributed capacities and certificate byte-for-byte', async t => {
  const s = await setup(t), result = await decide(s, ['5','4','3','6']), before = s.api.calls.length;
  const exported = await exportProposal(s.directory, s.options.input);
  assert.deepEqual(exported, result.proposal); assert.deepEqual(exported.source, validateInput(example));
  assert.equal(exported.sourceHash, hash(validateInput(example))); assert.equal(exported.configHash, hash(CONFIG));
  assert.equal(exported.room, ROOM_CODE); assert.equal(exported.transfersExecuted, false); assert.equal(exported.infrastructureChanged, false);
  for (const answer of exported.answers) { assert.equal(answer.responderId, CONFIG.participant.id); assert.equal(answer.askerId, ASKER); assert.ok(answer.questionId && answer.attemptId && answer.answeredAt); assert.equal(answer.capacity, Number(answer.text)); }
  const file = join(s.directory, 'proposal.json'), bytes = await readFile(file, 'utf8');
  await exportProposal(s.directory, s.options.input); assert.equal(await readFile(file, 'utf8'), bytes); assert.equal((await stat(file)).mode & 0o777, 0o600); assert.equal(s.api.calls.length, before);
  const release = await acquireLock(s.directory); await assert.rejects(exportProposal(s.directory, s.options.input), /lock exists/); await release();
});

test('strict boundaries reject line terminators and malformed Unicode before network', async t => {
  const s = await setup(t);
  for (const ending of ['\n','\r\n','\u2028','\u2029']) {
    assert.equal(isId(CONFIG.participant.id + ending), false); assert.equal(ROOM.test(ROOM_CODE + ending), false);
    assert.throws(() => validateConnection({ token: 'token' + ending, room: ROOM_CODE })); assert.throws(() => iso('2026-01-01T09:00:00.000Z' + ending));
    await assert.rejects(s.run({ token: 'token' + ending })); await assert.rejects(s.run({ room: ROOM_CODE + ending }));
    const input = structuredClone(example); input.links[0].id += ending; await assert.rejects(s.run({ input })); await assert.rejects(atomicText(s.directory, 'report.json' + ending, '{}'));
  }
  for (const ending of ['\u0000','\u0085','\u200e','\u2028','\ud800']) { const input = structuredClone(example); input.nodes[0].label += ending; assert.throws(() => validateInput(input)); }
  assert.equal(s.api.calls.length, 0);
});

test('replay binds parsed capacity; regressing clocks preserve previous evidence', async t => {
  const s = await setup(t); await s.run(); s.api.answer(id(1), '5'); await s.run(); const original = await s.saved();
  for (const mutate of [a => a.capacity++, a => a.text = '6', a => a.kind = 'unknown']) {
    const saved = structuredClone(original); mutate(saved.attempts[0].observation.answer); assert.throws(() => validateState(saved, s.options.input));
  }
  s.clock.value = '2026-01-01T09:01:00.000Z'; await s.run(); s.clock.value = '2026-01-01T09:00:30.000Z'; await assert.rejects(s.run(), /predates|regressed/); assert.equal(sends(s.api), 2);
});
