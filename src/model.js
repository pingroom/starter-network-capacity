import { createHash } from 'node:crypto';

export const TTL = 900;
export const CLOCK_SKEW_MS = 60000;
export const ROOM = /^[A-Z0-9]{12}(?![\s\S])/;
export const isId = (value) => typeof value === 'string' && value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value, expected) => {
  if (!record(value)) return false;
  const actual = Object.keys(value).sort(), wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const word = (value) => typeof value === 'string' && value.trim() === value && /^[a-z][a-z0-9_-]{0,39}$/.test(value);
const line = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.isWellFormed() && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && value.trim() === value;
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : record(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const hash = (value) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export function iso(raw) {
  if (typeof raw !== 'string' || raw.trim() !== raw || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(raw)) throw new Error('Expected a UTC timestamp.');
  const time = Date.parse(raw);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 19) !== raw.slice(0, 19)) throw new Error('Invalid UTC timestamp.');
  return new Date(time).toISOString();
}


export const MAX_CAPACITY = 999999;
export const MAX_TOTAL = 8 * MAX_CAPACITY;
const safeId = value => word(value) && value.length <= 16 && !['constructor', 'prototype', '__proto__'].includes(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max && !Object.is(value, -0);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function validateInput(input) {
  if (!keys(input, ['networkId', 'title', 'unit', 'period', 'nodes', 'source', 'sink', 'links']) || !word(input.networkId)
    || !line(input.title, 40) || !line(input.unit, 24) || !line(input.period, 60)
    || !Array.isArray(input.nodes) || input.nodes.length < 2 || input.nodes.length > 8
    || !Array.isArray(input.links) || input.links.length < 1 || input.links.length > 8) throw new Error('Provide a network ID, title, shared capacity unit/period, two to eight nodes and one to eight links.');
  const ids = new Set();
  for (const node of input.nodes) {
    if (!keys(node, ['id', 'label']) || !safeId(node.id) || ids.has(node.id) || !line(node.label, 30)) throw new Error('Nodes require unique safe IDs and labels.');
    ids.add(node.id);
  }
  if (!ids.has(input.source) || !ids.has(input.sink) || input.source === input.sink) throw new Error('Choose distinct declared source and sink nodes.');
  const linkIds = new Set(), endpoints = new Set();
  for (const link of input.links) {
    if (!keys(link, ['id', 'from', 'to', 'label']) || !safeId(link.id) || linkIds.has(link.id) || !line(link.label, 40)
      || !ids.has(link.from) || !ids.has(link.to) || link.from === link.to) throw new Error('Links require unique IDs, labels and distinct declared endpoints.');
    const pair = `${link.from}:${link.to}`;
    if (endpoints.has(pair)) throw new Error('Duplicate directed endpoint pair.');
    endpoints.add(pair); linkIds.add(link.id);
  }
  return { ...structuredClone(input), nodes: structuredClone(input.nodes).sort((a, b) => compare(a.id, b.id)),
    links: structuredClone(input.links).sort((a, b) => compare(a.id, b.id)) };
}

export function validateConfig(config) {
  if (!keys(config, ['participant']) || !keys(config.participant, ['id', 'label'])
    || !isId(config.participant.id) || !line(config.participant.label, 60)) throw new Error('Config requires an exact capacity operator UUID and label.');
  return structuredClone(config);
}
export const tasksFor = input => validateInput(input).links;
export function parseCapacity(text) {
  if (text === 'Unknown') return { kind: 'unknown', capacity: null };
  if (typeof text !== 'string' || !/^(?:0|[1-9][0-9]{0,5})(?![\s\S])/.test(text)) throw new Error('Reply with an integer from 0 to 999999 without spaces or leading zeros, or exactly Unknown.');
  return { kind: 'quantity', capacity: Number(text) };
}
export function requestFor(rawInput, config, taskId, attemptId) {
  const input = validateInput(rawInput), link = input.links.find(row => row.id === taskId); validateConfig(config);
  if (!link || !isId(attemptId)) throw new Error('Invalid link or attempt.');
  const from = input.nodes.find(node => node.id === link.from), to = input.nodes.find(node => node.id === link.to);
  const prompt = `${input.title}\nPeriod: ${input.period}\nLink ${link.id}: ${link.label}\n${from.label} [${link.from}] -> ${to.label} [${link.to}]\nUnit: ${input.unit}\nReport usable capacity in this direction, assuming all links operate together. Reply 0 to 999999 (digits only, no leading zeros), or Unknown. Planning only; no transfers.`;
  if (prompt.length > 500) throw new Error('Capacity prompt exceeds 500 characters.');
  const key = `capacity-${attemptId}`;
  return { prompt, context: `To ${config.participant.id}`, text_input: { placeholder: '0 to 999999 or Unknown', max_length: 60 },
    responder_scope: 'direct', target_user_id: config.participant.id, ttl: TTL, correlation_id: key,
    data: { input_hash: hash(input), link_hash: hash(link), task_id: taskId, attempt_id: attemptId }, idempotencyKey: key };
}

function knownCapacities(input, capacities) {
  if (!keys(capacities, input.links.map(link => link.id)) || Object.values(capacities).some(value => !integer(value, 0, MAX_CAPACITY))) throw new Error('Every link requires one bounded integer capacity.');
  return capacities;
}
function sum(values) {
  const value = values.reduce((a, b) => a + b, 0);
  if (!integer(value, 0, MAX_TOTAL)) throw new Error('Capacity sum exceeds the bounded network total.');
  return value;
}
function residualReachable(input, capacities, flows) {
  const reached = new Set([input.source]), queue = [input.source];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const node = queue[cursor];
    for (const link of input.links) {
      const target = link.from === node && flows[link.id] < capacities[link.id] ? link.to
        : link.to === node && flows[link.id] > 0 ? link.from : null;
      if (target !== null && !reached.has(target)) { reached.add(target); queue.push(target); }
    }
  }
  return [...reached].sort(compare);
}

/** Independently verify a feasible original-link flow and matching residual cut. */
export function verifyCertificate(rawInput, rawCapacities, certificate) {
  const input = validateInput(rawInput), capacities = knownCapacities(input, rawCapacities);
  if (!keys(certificate, ['value', 'links', 'balances', 'cut']) || !integer(certificate.value, 0, MAX_TOTAL)
    || !Array.isArray(certificate.links) || certificate.links.length !== input.links.length
    || !Array.isArray(certificate.balances) || certificate.balances.length !== input.nodes.length) throw new Error('Invalid flow certificate shape.');
  const flows = {};
  for (const [index, row] of certificate.links.entries()) {
    const link = input.links[index];
    if (!keys(row, ['id', 'from', 'to', 'capacity', 'flow', 'remaining']) || row.id !== link.id || row.from !== link.from || row.to !== link.to
      || row.capacity !== capacities[link.id] || !integer(row.flow, 0, row.capacity) || row.remaining !== row.capacity - row.flow) throw new Error('Certificate violates an original link capacity.');
    flows[link.id] = row.flow;
  }
  for (const [index, node] of input.nodes.entries()) {
    const incoming = sum(input.links.filter(link => link.to === node.id).map(link => flows[link.id]));
    const outgoing = sum(input.links.filter(link => link.from === node.id).map(link => flows[link.id]));
    const net = outgoing - incoming, expected = node.id === input.source ? certificate.value : node.id === input.sink ? -certificate.value : 0;
    if (net !== expected || hash(certificate.balances[index]) !== hash({ nodeId: node.id, incoming, outgoing, net })) throw new Error('Certificate violates flow conservation or endpoint balance.');
  }
  const sourceSide = residualReachable(input, capacities, flows), sourceSet = new Set(sourceSide);
  if (sourceSet.has(input.sink)) throw new Error('Certificate still has an augmenting path.');
  const sinkSide = input.nodes.map(node => node.id).filter(id => !sourceSet.has(id));
  const crossingLinkIds = input.links.filter(link => sourceSet.has(link.from) && !sourceSet.has(link.to)).map(link => link.id);
  const capacity = sum(crossingLinkIds.map(id => capacities[id]));
  if (capacity !== certificate.value || hash(certificate.cut) !== hash({ sourceSide, sinkSide, crossingLinkIds, capacity })) throw new Error('Cut certificate does not match the maximum flow value.');
  return certificate;
}

/** Edmonds-Karp with distinct reverse objects, including for antiparallel originals. */
export function maximumFlow(rawInput, rawCapacities) {
  const input = validateInput(rawInput), capacities = knownCapacities(input, rawCapacities);
  const adjacency = new Map(input.nodes.map(node => [node.id, []])), originals = new Map();
  for (const link of input.links) {
    const forward = { to: link.to, remaining: capacities[link.id], linkId: link.id, direction: 1 };
    const reverse = { to: link.from, remaining: 0, linkId: link.id, direction: -1 };
    forward.reverse = reverse; reverse.reverse = forward;
    adjacency.get(link.from).push(forward); adjacency.get(link.to).push(reverse); originals.set(link.id, forward);
  }
  for (const edges of adjacency.values()) edges.sort((a, b) => compare(a.to, b.to) || compare(a.linkId, b.linkId) || b.direction - a.direction);
  let value = 0, augmentations = 0;
  while (true) {
    const predecessor = new Map([[input.source, null]]), queue = [input.source];
    for (let cursor = 0; cursor < queue.length && !predecessor.has(input.sink); cursor++) {
      const node = queue[cursor];
      for (const edge of adjacency.get(node)) if (edge.remaining > 0 && !predecessor.has(edge.to)) {
        predecessor.set(edge.to, { from: node, edge }); queue.push(edge.to);
      }
    }
    if (!predecessor.has(input.sink)) break;
    const path = []; let node = input.sink;
    while (node !== input.source) { const step = predecessor.get(node); path.push(step.edge); node = step.from; }
    const amount = Math.min(...path.map(edge => edge.remaining));
    for (const edge of path) { edge.remaining -= amount; edge.reverse.remaining += amount; }
    value = sum([value, amount]);
    if (++augmentations > 512) throw new Error('Unexpected augmenting-path bound exceeded.');
  }
  const flows = Object.fromEntries(input.links.map(link => [link.id, capacities[link.id] - originals.get(link.id).remaining]));
  const sourceSide = residualReachable(input, capacities, flows), sourceSet = new Set(sourceSide);
  const crossingLinkIds = input.links.filter(link => sourceSet.has(link.from) && !sourceSet.has(link.to)).map(link => link.id);
  const certificate = {
    value,
    links: input.links.map(link => ({ id: link.id, from: link.from, to: link.to, capacity: capacities[link.id], flow: flows[link.id], remaining: capacities[link.id] - flows[link.id] })),
    balances: input.nodes.map(node => {
      const incoming = sum(input.links.filter(link => link.to === node.id).map(link => flows[link.id]));
      const outgoing = sum(input.links.filter(link => link.from === node.id).map(link => flows[link.id]));
      return { nodeId: node.id, incoming, outgoing, net: outgoing - incoming };
    }),
    cut: { sourceSide, sinkSide: input.nodes.map(node => node.id).filter(id => !sourceSet.has(id)), crossingLinkIds, capacity: sum(crossingLinkIds.map(id => capacities[id])) },
  };
  return verifyCertificate(input, capacities, certificate);
}

export function networkCapacity(rawInput, answers) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!Array.isArray(answers) || answers.length !== tasks.length
    || answers.some((row, index) => !keys(row, ['linkId', 'text']) || row.linkId !== tasks[index].id
      || row.text !== null && typeof row.text !== 'string')) throw new Error('Provide one ordered answer or missing outcome for every link.');
  const outcomes = answers.map(row => row.text === null ? { kind: 'missing', capacity: null } : parseCapacity(row.text));
  if (outcomes.some(row => row.kind !== 'quantity')) return { status: 'incomplete', certificate: null };
  const capacities = Object.fromEntries(tasks.map((link, index) => [link.id, outcomes[index].capacity]));
  return { status: 'complete', certificate: maximumFlow(input, capacities) };
}

export function validateState(state, rawInput) {
  const input = validateInput(rawInput), tasks = tasksFor(input);
  if (!keys(state, ['version', 'inputHash', 'config', 'room', 'credentialHash', 'startedAt', 'attempts']) || state.version !== 1
    || state.inputHash !== hash(input) || typeof state.room !== 'string' || !ROOM.test(state.room)
    || typeof state.credentialHash !== 'string' || state.credentialHash.length !== 64 || !/^[0-9a-f]{64}$/.test(state.credentialHash)
    || !Array.isArray(state.attempts) || state.attempts.length > tasks.length || iso(state.startedAt) !== state.startedAt) {
    throw new Error('Invalid state or changed capacity network. Restore the original inputs.');
  }
  validateConfig(state.config);
  const ids = new Set(), questionIds = new Set();
  let previous = state.startedAt, askerId;
  for (const [index, attempt] of state.attempts.entries()) {
    if (!keys(attempt, ['id', 'taskId', 'createdAt', 'request', 'questionId', 'status', 'observation'])
      || !isId(attempt.id) || ids.has(attempt.id) || attempt.taskId !== tasks[index].id
      || iso(attempt.createdAt) !== attempt.createdAt || attempt.createdAt < previous
      || hash(attempt.request) !== hash(requestFor(input, state.config, attempt.taskId, attempt.id))
      || !['creating', 'pending', 'answered', 'expired', 'cancelled', 'invalid_answer'].includes(attempt.status)) {
      throw new Error('Invalid saved capacity request.');
    }
    ids.add(attempt.id);
    previous = attempt.createdAt;
    if (attempt.status === 'creating') {
      if (attempt.questionId !== null || attempt.observation !== null) throw new Error('Invalid uncertain creation state.');
    } else {
      if (!isId(attempt.questionId) || questionIds.has(attempt.questionId)) throw new Error('Invalid or repeated Question ID.');
      questionIds.add(attempt.questionId);
      validateObservation(attempt.observation, attempt.status, attempt.request);
      if (Date.parse(attempt.observation.createdAt) < Date.parse(attempt.createdAt) - CLOCK_SKEW_MS
        || attempt.observation.checkedAt < attempt.createdAt) throw new Error('Observation predates creation intent.');
      previous = attempt.observation.checkedAt;
      if (askerId !== undefined && attempt.observation.askerId !== askerId) throw new Error('Questions belong to different asking registrations.');
      askerId = attempt.observation.askerId;
    }
    if (['creating', 'pending'].includes(attempt.status) && index !== state.attempts.length - 1) {
      throw new Error('Only the last task may have an active Question.');
    }
  }
  return state;
}

export function report(state, rawInput) {
  const input = validateInput(rawInput); validateState(state, input);
  const answers = tasksFor(input).map(link => {
    const attempt = state.attempts.find(row => row.taskId === link.id), answer = attempt?.observation?.answer;
    return { linkId: link.id, linkHash: hash(link), status: attempt?.status === 'creating' ? 'create_unknown' : attempt?.status ?? 'unasked',
      text: answer?.text ?? null, kind: answer?.kind ?? null, capacity: answer?.capacity ?? null,
      questionId: attempt?.questionId ?? null, attemptId: attempt?.id ?? null,
      responderId: answer?.responderId ?? null, answeredAt: answer?.answeredAt ?? null,
      askerId: attempt?.observation?.askerId ?? null, observedAt: attempt?.observation?.checkedAt ?? null };
  });
  const calculation = networkCapacity(input, answers.map(({ linkId, text }) => ({ linkId, text })));
  const active = answers.find(row => ['create_unknown', 'pending'].includes(row.status));
  const status = active?.status ?? (answers.some(row => row.status === 'unasked') ? 'ready' : calculation.status);
  const evidence = { networkId: input.networkId, source: input, sourceHash: hash(input), configHash: hash(state.config),
    participant: state.config.participant, room: state.room, answers, certificate: calculation.certificate,
    transfersExecuted: false, infrastructureChanged: false };
  return { ...evidence, status, proposal: calculation.status === 'complete' ? { ...evidence, status: 'complete' } : null };
}
function validateObservation(observation, status, request) {
  if (!keys(observation, ['createdAt', 'expiresAt', 'checkedAt', 'askerId', 'resolvedAt', 'answer']) || !isId(observation.askerId)) throw new Error('Invalid saved observation.');
  for (const key of ['createdAt', 'expiresAt', 'checkedAt']) if (iso(observation[key]) !== observation[key]) throw new Error('Invalid saved timestamp.');
  const duration = Date.parse(observation.expiresAt) - Date.parse(observation.createdAt);
  if (duration < TTL * 1000 - 1000 || duration > TTL * 1000 + 1000) throw new Error('Question lifetime differs from the saved request.');
  const latest = Date.parse(observation.checkedAt) + CLOCK_SKEW_MS;
  if (Date.parse(observation.createdAt) > latest) throw new Error('Question creation is implausibly in the future. Check the local clock.');
  if (status === 'pending') {
    if (observation.resolvedAt !== null) throw new Error('Pending Question has a resolution timestamp.');
  } else if (iso(observation.resolvedAt) !== observation.resolvedAt || observation.resolvedAt < observation.createdAt
    || Date.parse(observation.resolvedAt) > latest
    || (status === 'expired' ? observation.resolvedAt < observation.expiresAt : observation.resolvedAt > observation.expiresAt)) throw new Error('Invalid Question resolution time.');
  if (status === 'answered') {
    const answer = observation.answer;
    if (!keys(answer, ['text', 'kind', 'capacity', 'responderId', 'answeredAt']) || answer.responderId !== request.target_user_id
      || hash(parseCapacity(answer.text)) !== hash({ kind: answer.kind, capacity: answer.capacity })
      || iso(answer.answeredAt) !== answer.answeredAt || answer.answeredAt !== observation.resolvedAt
      || answer.answeredAt < observation.createdAt || answer.answeredAt > observation.expiresAt) throw new Error('Invalid saved capacity evidence.');
  } else if (observation.answer !== null) throw new Error('Unanswered tasks must not contain capacity evidence.');
}

export function observeQuestion(q, request, questionId, room, checkedAt) {
  if (!isId(questionId) || q?.id !== questionId || q.kind !== 'question' || q.is_handoff !== false
    || q.asker?.type !== 'agent' || !isId(q.asker?.id) || q.prompt !== request.prompt || q.context !== request.context
    || q.responder_scope !== 'direct' || q.target_user_id !== request.target_user_id || q.resolution_policy !== 'first'
    || q.results !== null || hash(q.text_input) !== hash(request.text_input) || q.correlation_id !== request.correlation_id || q.reply_to !== null || hash(q.data) !== hash(request.data)
    || (q.room_code ?? q.room?.code) !== room || q.room_code !== undefined && q.room_code !== room
    || q.room !== undefined && q.room?.code !== room || !['pending', 'answered', 'expired', 'cancelled'].includes(q.state)
    || !Array.isArray(q.options) || q.options.length !== 0) throw new Error('Question does not match the saved task, room, or capacity operator.');
  const observation = { createdAt: iso(q.created_at), expiresAt: iso(q.expires_at), checkedAt: iso(checkedAt), askerId: q.asker.id,
    resolvedAt: q.resolved_at === null ? null : iso(q.resolved_at), answer: null };
  let status = q.state === 'answered' ? 'invalid_answer' : q.state;
  if (q.state !== 'answered' && q.answer !== null) throw new Error('Unresolved Question includes an unexpected answer.');
  if (q.state === 'answered') {
    const answer = q.answer;
    try {
      if (!answer || answer.value !== null || answer.label !== null || answer.responder?.id !== request.target_user_id || typeof answer.text !== 'string' || answer.text.length > 60) throw new Error('Invalid text answer.');
      observation.answer = { text: answer.text, ...parseCapacity(answer.text), responderId: answer.responder.id, answeredAt: iso(answer.answered_at) };
      validateObservation(observation, 'answered', request); status = 'answered';
    } catch { observation.answer = null; }
  }
  validateObservation(observation, status, request);
  return { status, observation };
}

export function assertParticipantRoom(rooms, room, participantId) {
  if (!Array.isArray(rooms) || rooms.length > 1000) throw new Error('Invalid room inventory.');
  const matches = rooms.filter((item) => item?.invite_code === room), selected = matches[0];
  if (matches.length !== 1 || selected.type !== 'standard' || selected.is_public !== false || !Array.isArray(selected.members)
    || selected.members.length > 1000 || !selected.members.some((member) => member?.user_id === participantId)) throw new Error('Use a granted standard private room containing the named participant.');
}
