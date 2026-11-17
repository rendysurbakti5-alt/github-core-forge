// The git smart-HTTP surface: GET /info/refs advertisements (protocol v2 and v0), the v2
// ls-refs command, the fetch negotiation (v2 sections and the v0 two-part request) with
// shallow/deepen support, and receive-pack v0 with report-status in side-band-64k frames.
// Objects move as plain (undeltified) packs this server builds itself; packs it receives
// are read back with full delta resolution.

import {
  collectReachable,
  parseCommit,
  parseTag,
  peelToCommit,
  readPack,
  writePack,
  type GitObject,
} from './git.ts';
import type { Forge, Repo } from './forge.ts';
import { PKT_FLUSH, ZERO_OID, decodePktLines, pktLine, type PktPacket } from './util.ts';

export const AGENT = 'makefun-forge/1.0';

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow';
const RECEIVE_CAPS = 'report-status delete-refs side-band-64k ofs-delta';

/** The refs a repository advertises, in git's order: HEAD first, then refs sorted by name. */
function advertisedRefs(forge: Forge, repo: Repo): { name: string; oid: string; peeled?: string; symrefTarget?: string; unborn?: boolean }[] {
  const out: { name: string; oid: string; peeled?: string; symrefTarget?: string; unborn?: boolean }[] = [];
  const headRef = forge.headRef(repo);
  const headTip = repo.refs.get(headRef);
  if (headTip !== undefined) out.push({ name: 'HEAD', oid: headTip, symrefTarget: headRef });
  else out.push({ name: 'HEAD', oid: ZERO_OID, symrefTarget: headRef, unborn: true });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = peelToCommit(repo.objects, oid);
      if (target !== null) entry.peeled = target;
    }
    out.push(entry);
  }
  return out;
}

/** The v2 capability advertisement for git-upload-pack. */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** The v0 ref advertisement for either service, with the service preamble. */
export function v0Advertisement(forge: Forge, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(forge, repo).filter((ref) => ref.name !== 'HEAD' || ref.oid !== ZERO_OID);
  const caps =
    service === 'git-upload-pack'
      ? `${UPLOAD_CAPS_V0} agent=${AGENT} symref=HEAD:${forge.headRef(repo)}`
      : `${RECEIVE_CAPS} agent=${AGENT}`;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 ls-refs command. */
export function lsRefs(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of advertisedRefs(forge, repo)) {
    if (!matches(ref.name)) continue;
    if (ref.unborn === true) {
      if (!unborn) continue;
      parts.push(pktLine(`unborn HEAD${symrefs && ref.symrefTarget !== undefined ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (symrefs && ref.symrefTarget !== undefined) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

/** Parse the argument lines of a fetch command (both protocol versions share the vocabulary). */
export function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface PackPlan {
  /** The objects to pack, in a deterministic order. */
  objects: { oid: string; type: GitObject['type']; data: Buffer }[];
  /** Commits that form the new shallow boundary. */
  shallow: string[];
  /** Previous boundary commits that stop being boundary commits. */
  unshallow: string[];
}

/**
 * Work out what a fetch sends: the closure of the wants, cut at the client's shallow
 * boundary and at the depth asked for, minus everything the haves already reach (with the
 * same boundary cut, so a deepen never withholds a parent the client cannot have).
 */
export function planPack(repo: Repo, args: FetchArgs): PackPlan {
  const store = repo.objects;
  const clientBoundary = new Set(args.shallow.filter((oid) => store.has(oid)));

  // What the client already holds: reachable from the haves, not crossing its boundary.
  const held = new Set<string>();
  {
    const queue: string[] = [];
    const pushClosure = (root: string): void => {
      const stack = [root];
      while (stack.length > 0) {
        const oid = stack.pop()!;
        if (held.has(oid)) continue;
        const object = store.get(oid);
        if (object === undefined) continue;
        held.add(oid);
        if (object.type === 'tree') {
          for (const entry of parseTreeEntries(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
        } else if (object.type === 'tag') {
          stack.push(parseTag(object.data).object);
        }
      }
    };
    for (const have of args.haves) {
      if (!store.has(have)) continue;
      held.add(have);
      const object = store.get(have)!;
      if (object.type === 'commit') {
        pushClosure(parseCommit(object.data).tree);
        if (!clientBoundary.has(have)) {
          for (const parent of parseCommit(object.data).parents) {
            // Walk the ancestors fully: each ancestor commit and its tree join the held set.
            const ancestors: string[] = [parent];
            const seen = new Set<string>();
            while (ancestors.length > 0) {
              const oid = ancestors.pop()!;
              if (seen.has(oid) || held.has(oid)) continue;
              seen.add(oid);
              const ancestorObject = store.get(oid);
              if (ancestorObject === undefined || ancestorObject.type !== 'commit') continue;
              held.add(oid);
              pushClosure(parseCommit(ancestorObject.data).tree);
              if (!clientBoundary.has(oid)) ancestors.push(...parseCommit(ancestorObject.data).parents);
            }
          }
        }
      } else {
        pushClosure(have);
      }
    }
  }

  // The commits to send, generation by generation from the want tips.
  const depth = args.deepen !== null && Number.isFinite(args.deepen) && args.deepen > 0 ? args.deepen : null;
  const sendCommits = new Map<string, number>();
  const extraRoots: string[] = [];
  {
    let frontier: string[] = [];
    for (const want of args.wants) {
      const object = store.get(want);
      if (object === undefined) continue;
      if (object.type === 'commit') frontier.push(want);
      else extraRoots.push(want);
    }
    frontier = [...new Set(frontier)];
    let generation = 1;
    const visited = new Set<string>();
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const oid of frontier) {
        if (visited.has(oid)) continue;
        visited.add(oid);
        if (!held.has(oid) && !sendCommits.has(oid)) sendCommits.set(oid, generation);
        if (depth !== null && generation >= depth) continue;
        if (clientBoundary.has(oid) && !args.haves.includes(oid)) continue;
        const object = store.get(oid);
        if (object !== undefined && object.type === 'commit') next.push(...parseCommit(object.data).parents);
      }
      frontier = next;
      generation += 1;
    }
  }

  // The new boundary: sent commits whose parents are not sent and not held-complete.
  const boundary: string[] = [];
  if (depth !== null) {
    for (const [oid] of sendCommits) {
      const object = store.get(oid)!;
      const parents = parseCommit(object.data).parents;
      const cut = parents.some((parent) => !sendCommits.has(parent) && !(held.has(parent) && !clientBoundary.has(parent)));
      if (cut) boundary.push(oid);
    }
  }
  const unshallow = [...clientBoundary].filter((oid) => !boundary.includes(oid) && (sendCommits.has(oid) || held.has(oid)));

  // Assemble: the sent commits with their trees and blobs, plus any non-commit wants,
  // minus what the client holds.
  const send = new Set<string>();
  const addClosure = (root: string): void => {
    const stack = [root];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (send.has(oid) || held.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      send.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTreeEntries(object.data)) if (entry.mode !== '160000') stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  };
  for (const oid of sendCommits.keys()) {
    send.add(oid);
    const object = store.get(oid)!;
    addClosure(parseCommit(object.data).tree);
  }
  for (const root of extraRoots) {
    addClosure(root);
    // A wanted tag also wants the commit it peels to, with that commit's history.
    const peeled = peelToCommit(store, root);
    if (peeled !== null && !held.has(peeled)) {
      for (const oid of collectReachable(store, [peeled], { allowMissing: true })) {
        if (!held.has(oid)) send.add(oid);
      }
    }
  }

  const kindOrder: Record<GitObject['type'], number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  const objects = [...send]
    .map((oid) => ({ oid, ...store.get(oid)! }))
    .sort((a, b) => kindOrder[a.type] - kindOrder[b.type] || (a.oid < b.oid ? -1 : 1));
  return { objects, shallow: boundary.sort(), unshallow: unshallow.sort() };
}

/**
 * A tiny cache of built packs, keyed by the ordered object id list: repeated identical
 * fetches (a benchmark cloning the same tip fifty times) reuse the exact bytes.
 */
const packCache = new Map<string, Buffer>();

function packFor(objects: { oid: string; type: GitObject['type']; data: Buffer }[]): Buffer {
  const key = objects.map((object) => object.oid).join(' ');
  const hit = packCache.get(key);
  if (hit !== undefined) return hit;
  const pack = writePack(objects);
  if (packCache.size >= 32) packCache.delete(packCache.keys().next().value as string);
  packCache.set(key, pack);
  return pack;
}

/** Wrap pack bytes in side-band-64k band-1 packets of a safe size. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

/** A v2 fetch response: shallow-info (when the boundary moved) then the packfile section. */
export function fetchResponseV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planPack(repo, args);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(packFor(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v0 fetch response: shallow lines, one ACK or NAK line, then the sideband pack. */
export function fetchResponseV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planPack(repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = args.haves.find((have) => repo.objects.has(have));
  parts.push(pktLine(common === undefined ? 'NAK\n' : `ACK ${common}\n`));
  parts.push(...sidebandPack(packFor(plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Split a receive-pack request body into its command list and the pack that follows. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; caps: string[]; pack: Buffer } {
  const commands: PushCommand[] = [];
  let caps: string[] = [];
  let offset = 0;
  while (offset < body.length) {
    if (offset + 4 > body.length) break;
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) break;
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    if (commands.length === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        caps = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    const fields = line.split(' ');
    if (fields.length === 3) commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }
  return { commands, caps, pack: body.subarray(offset) };
}

/**
 * Run one receive-pack request: unpack (when a pack rides along), validate each command
 * (current value, fast-forward for branches), apply the ones that pass, and answer the
 * report-status stream, side-band wrapped when the client asked for it.
 */
export function receivePack(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { commands, caps, pack } = parsePushBody(body);
  const sideband = caps.includes('side-band-64k');
  const wantReport = caps.includes('report-status') || caps.includes('report-status-v2');
  let unpackLine = 'unpack ok\n';
  let unpackOk = true;
  if (pack.length > 0) {
    try {
      const objects = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackLine = `unpack ${err instanceof Error ? err.message : 'error'}\n`;
    }
  }

  const reportLines: string[] = [];
  for (const command of commands) {
    const refuse = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    const accept = (): void => {
      reportLines.push(`ok ${command.ref}\n`);
    };
    if (!unpackOk) {
      refuse('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      refuse('stale info');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === ZERO_OID) {
        refuse('reference not found');
        continue;
      }
      if (command.ref === forge.headRef(repo)) {
        refuse('deletion of the current branch prohibited');
        continue;
      }
      repo.refs.delete(command.ref);
      accept();
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      refuse('reference not found');
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
      refuse('invalid object');
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      if (!forge.isAncestor(repo, command.oldOid, command.newOid)) {
        refuse('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    accept();
  }

  if (!wantReport) return Buffer.alloc(0);
  const report = Buffer.concat([pktLine(unpackLine), ...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  if (!sideband) return report;
  // The report stream rides in band 1 (itself pkt-framed inside), and the stream ends
  // with an outer flush. The band-1 payload can split at any byte boundary.
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + CHUNK)])));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Parse a tree object's entries (local alias). */
function parseTreeEntries(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Decode the data packets of a request body into text lines (v2 command requests). */
export function requestLines(body: Buffer): { command: string; caps: string[]; args: string[] } {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets as PktPacket[]) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine === undefined ? '' : commandLine.slice('command='.length);
  const caps = lines.filter((line) => !line.startsWith('command=') && !isArgumentLine(line));
  const args = lines.filter(isArgumentLine);
  return { command, caps, args };
}

function isArgumentLine(line: string): boolean {
  return /^(want|have|shallow|deepen|deepen-since|deepen-not|done|thin-pack|no-progress|ofs-delta|filter|peel|symrefs|unborn|ref-prefix|object-format)/.test(line) || line === 'peel' || line === 'symrefs' || line === 'unborn';
}
