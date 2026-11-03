# PingRoom network capacity starter

Collect usable link capacities from a named operator through PingRoom, then calculate the maximum transferable quantity from a fixed source to a fixed sink. Export a feasible flow and matching minimum-cut certificate with reported capacities and attributed answers.

Use it to model a small transfer network. The example moves practice cards between desks. The application performs no transfers, dispatches, infrastructure changes or purchases.

## Try it offline

Choose **Use this template**, clone your repository, and use Node.js 22 or newer:

```sh
npm ci
npm test
npm run demo
```

The demo covers split paths, zero capacity and planning blocked by an Unknown answer. Tests and demos use pinned `@pingroom/sdk` 0.7.1 with local mock transports; they need no credentials and do not test live phone delivery. Dependencies have a lockfile and a 14-day minimum release-age setting. GitHub Actions checks Node 22 and 24.

## Define the network

```sh
cp examples/network.json network.json
cp config.example.json config.json
npm run validate
```

Edit `network.json` before collecting capacities. It contains:

- `networkId`, `title`, a shared `unit`, and `period` describing one operating window or snapshot.
- `nodes`: two to eight `{id,label}` records.
- `source` and `sink`: distinct declared node IDs.
- `links`: one to eight `{id,from,to,label}` records, each describing a directed link.

All capacities must use the same unit and period and describe links that can operate together. A reverse direction is a separate link with its own capacity. Links in both directions, cycles, links entering the source and links leaving the sink are supported. Self-links, duplicate IDs, duplicate directed endpoint pairs and unknown endpoints are rejected. Disconnected nodes and links are allowed.

Node and link IDs have 1–16 lowercase ASCII characters, starting with a letter and followed by letters, digits, `_` or `-`; prototype-related names are excluded. The network ID allows 40 characters with the same syntax. Text must be trimmed, well-formed single-line Unicode without control or formatting characters. UTF-16 limits are title 40, unit 24, period 60, node label 30 and link label 40. Node/link arrays are sorted by ID; equivalent reorderings preserve the session.

## Connect the operator

Install [PingRoom](https://pingroom.io/i), then:

```sh
npm run connect
npm run inspect
```

Open the pairing link, approve the connection and grant a standard private room containing the operator. Verify the person in the app, then copy their exact member UUID from `inspect` into `config.json`. Names alone do not establish identity. The connection needs the room grant and room/Question access. Keep the original asking registration for later reads.

Pairing saves private credentials under `.pingroom/` and resumes its pending request. For an **existing connection only**, copy `.env.example` to `.env` and set both `PINGROOM_TOKEN` and `PINGROOM_ROOM`. A complete pair overrides saved credentials. If either shell variable is present, both must be valid; blank or partial pairs cannot borrow from `.env` or saved credentials.

## Collect and export

```sh
npm start
# Answer in PingRoom, then run again to record the answer:
npm start
npm run status
npm run report
npm run export
```

Each `npm start` creates one Question or reads the active one once. After an answer is recorded, a later invocation asks the next link in ID order. Questions show endpoint IDs and labels to identify direction. At most eight Questions target the configured operator, each expiring after 900 seconds. No scheduler or background polling is installed.

Enter `0`–`999999` as digits without leading zeros, or exactly `Unknown`. Zero is known capacity. Every link requires a known answer, including disconnected links. Unknown, invalid, missing, expired or cancelled answers withhold the entire certificate and export. Later links may be collected, but code never guesses a quantity or reissues a terminal Question.

`status`, `report` and `export` are offline. `report` saves `.network/report.json`, including partial evidence. Complete-only `export` writes `.network/proposal.json` with the canonical manifest, hashes, room, participant, attributed capacities, Question IDs, timestamps and certificate. Repeated exports produce identical bytes. Failure preserves any prior file; require successful export for the expected source hash.

## Interpret the certificate

`certificate.value` is maximum net flow from source to sink in the declared unit. `links` contains each original link's capacity, flow and remaining capacity. `balances` records incoming, outgoing and net quantities at each node. Intermediate nodes conserve flow; source and sink have equal opposite net balances.

`cut.sourceSide` is the set reachable from the source through remaining forward capacity or reversible existing flow. `sinkSide` contains the other nodes. `crossingLinkIds` lists original links directed from source side to sink side; their total capacity equals the flow value. Zero or disconnected networks can therefore have a valid complete zero-throughput certificate.

Code uses deterministic breadth-first augmenting paths, keeping original reverse-direction links separate from residual reverse edges. A separate validator checks capacities, conservation, endpoint balances, residual reachability and cut equality before export. All totals remain bounded by eight times 999999. Ties return one deterministic flow and cut, without claiming uniqueness. See the [MIT network-flow notes](https://courses.csail.mit.edu/6.854/19/Scribe/s6-maxflow/s6-maxflow.html) for the max-flow/min-cut result.

The model assumes one conserved commodity and independent declared link capacities. It omits losses, travel time, latency, storage, lower bounds, shared equipment constraints and competing commodities. The cut certifies the supplied model; it does not measure a real-world bottleneck or verify the operator's reports.

## Recover and adapt

Keep the original manifest, config, connection and `.network/` directory. Changed content or identities cannot reuse existing answers. Creation intent is saved before POST. If creation is uncertain, preserve state and recover the original Question:

```sh
npm run find-id
npm run recover -- EXACT_QUESTION_UUID
```

An empty recent-list search does not prove creation failed. Recovery verifies the original request, target, room, asker and lifetime without another POST. For uncertain or expired pairing, inspect Connected Agents and resolve or revoke any created robot before intentionally archiving its pairing record.

Files use private atomic writes and locks. Inputs/config are limited to 16 KiB each, state/reports to 1 MiB and HTTP responses to 512 KiB. Credentials and local inputs/state are ignored by Git. Use persistent storage on one machine; restore corrupt state from backup. Remove a stale lock only after confirming its owning process stopped. Local evidence is historical and not tamper-proof.

Collection exits `0` when complete, `1` on error, `2` for incomplete or newly failed outcomes, `3` while ready/pending/interrupted, and `4` for uncertain creation. Successful local status/report commands return `0`; inspect their JSON status. Refused exports return `1`.

Adapt `src/model.js` or consume its exported certificate after review; keep deterministic validation and calculation in code. Tests include reverse-residual rerouting, antiparallel links, 6,561 independent exhaustive-cut comparisons, malformed evidence, interrupted saves, pairing and real CLI subprocesses. [MIT license](LICENSE).
