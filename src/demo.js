import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { step, exportProposal } from './engine.js';
import { readJson } from './storage.js';
import { mockApi, CONFIG, ROOM_CODE } from './mock.js';

const input = await readJson(new URL('../examples/network.json', import.meta.url));
for (const scenario of [
  { title: 'Two transfer paths share the source and sink', capacities: ['5','4','3','6'], status: 'complete', expected: 7 },
  { title: 'Known zero capacity yields complete zero throughput', capacities: ['0','0','0','0'], status: 'complete', expected: 0 },
  { title: 'Unknown capacity withholds the entire certificate', capacities: ['Unknown','4','3','6'], status: 'incomplete' },
]) {
  const directory = await mkdtemp(join(tmpdir(), 'pingroom-network-demo-'));
  try {
    const now = () => '2026-01-01T09:00:00.000Z', api = mockApi(now);
    const options = { client: api.client, directory, input, config: CONFIG, token: 'offline-fixture-token', room: ROOM_CODE, now };
    let result;
    for (const capacity of scenario.capacities) {
      result = await step(options); api.answer(result.answers.find(answer => answer.status === 'pending').questionId, capacity); result = await step(options);
    }
    assert.equal(result.status, scenario.status);
    if (result.status === 'complete') { assert.equal(result.certificate.value, scenario.expected); assert.deepEqual(await exportProposal(directory, input), result.proposal); }
    else { assert.equal(result.proposal, null); await assert.rejects(exportProposal(directory, input)); }
    console.log(JSON.stringify({ scenario: scenario.title, status: result.status, unit: input.unit, certificate: result.certificate }, null, 2));
  } finally { await rm(directory, { recursive: true, force: true }); }
}
console.log('Offline demo used the pinned SDK with a local mock transport. No live delivery, transfers or infrastructure changes.');
