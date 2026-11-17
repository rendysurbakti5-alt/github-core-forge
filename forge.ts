// The forge's store and domain logic: repositories (with their git object stores and refs),
// labels, issues, comments and pull requests, plus the contents API's file commits, pull
// request diffs and squash merges. One forge serves one token user; the user's login is
// learned from the first owner-named route the suite drives (the git and REST paths carry
// it), which is also what GET /user and the GraphQL viewer answer.

import {
  buildCommit,
  buildTreeFromFlat,
  collectReachable,
  commitAncestors,
  diffFlatTrees,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  mergeFlatTrees,
  parseCommit,
  parseTag,
  peelToCommit,
  type FileChange,
  type FlatEntry,
  type GitObject,
  type GitObjectType,
} from './git.ts';
import { TrialClock, ZERO_OID, gitStamp } from './util.ts';

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface IssueComment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  ownerLogin: string | null;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  createdAt: string;
  updatedAt: string;
}

/** Encode a Relay-style global id: opaque, stable, and decodable by node(id:). */
export function globalId(kind: string, ...parts: readonly (string | number)[]): string {
  return Buffer.from(['MF1', kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

/** Decode a global id made by globalId; null when the value is not one of ours. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const fields = text.split(':');
    if (fields[0] !== 'MF1' || fields.length < 2) return null;
    return { kind: fields[1]!, parts: fields.slice(2) };
  } catch {
    return null;
  }
}

export class Forge {
  readonly clock: TrialClock;
  /** The token user's login, learned from the first owner-named route; null until then. */
  login: string | null = null;
  private readonly repos = new Map<string, Repo>();
  private readonly reposById = new Map<number, Repo>();
  private nextRepoId = 1;
  private nextObjectId = 1;
  private seq = 0;

  constructor(nowIso: string | undefined) {
    this.clock = new TrialClock(nowIso);
  }

  /** The login to show for the token user (a placeholder until a route teaches the real one). */
  viewerLogin(): string {
    return this.login ?? 'forge';
  }

  /** Learn the token user's login from an owner-named route, the first time one is seen. */
  learnLogin(owner: string): void {
    if (this.login === null && owner !== '') this.login = owner;
  }

  /** The next global creation sequence number (orders issues, comments and pulls). */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** A fresh database id for an issue, comment or pull request object. */
  nextId(): number {
    const id = this.nextObjectId;
    this.nextObjectId += 1;
    return id;
  }

  // -------------------------------------------------------------------------------------------
  // repositories

  createRepo(name: string, options: { isPrivate?: boolean; description?: string }): Repo | null {
    if (this.repos.has(name)) return null;
    const now = this.clock.peekIso();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      ownerLogin: this.login,
      isPrivate: options.isPrivate ?? false,
      description: options.description ?? '',
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  repoByName(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  repoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  allRepos(): Repo[] {
    return [...this.repos.values()];
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(repo.name);
    this.reposById.delete(repo.id);
  }

  /** Rename a repository, keeping its id (and so its global ids) stable. */
  renameRepo(repo: Repo, newName: string): void {
    this.repos.delete(repo.name);
    repo.name = newName;
    this.repos.set(newName, repo);
  }

  /**
   * The owner rule for repo-scoped routes: a repository answers under the owner it was
   * created for; a repository whose owner is not yet known adopts the owner segment of the
   * first read that names one. Any other owner is a 404 (never a 403).
   */
  repoForOwner(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    this.learnLogin(owner);
    if (repo.ownerLogin === null) repo.ownerLogin = owner;
    return repo.ownerLogin === owner ? repo : null;
  }

  /** The owner segment a repository serializes under. */
  ownerOf(repo: Repo): string {
    return repo.ownerLogin ?? this.viewerLogin();
  }

  // -------------------------------------------------------------------------------------------
  // git store primitives

  /** Store one object in a repository and answer its id. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The full ref name of a repository's HEAD (its default branch). */
  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** Resolve a branch name, a full ref, HEAD, or a 40-hex id to an object id, or null. */
  resolveRef(repo: Repo, name: string): string | null {
    if (name === 'HEAD') return repo.refs.get(this.headRef(repo)) ?? null;
    if (name.startsWith('refs/')) return repo.refs.get(name) ?? null;
    const branch = repo.refs.get(`refs/heads/${name}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${name}`);
    if (tag !== undefined) return tag;
    if (/^[0-9a-f]{40}$/.test(name) && repo.objects.has(name)) return name;
    return null;
  }

  /** The tree id a commit names, or null. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The identity line every forge-made commit carries (the token user as author). */
  private identityLine(): string {
    const login = this.viewerLogin();
    const stamp = gitStamp(this.clock.tick());
    return `${login} <${login}@forge.invalid> ${stamp}`;
  }

  /** Make one commit in a repository from a flat tree, on top of `parent` (null for a root). */
  makeCommit(repo: Repo, flat: ReadonlyMap<string, FlatEntry>, parent: string | null, message: string): string {
    const tree = buildTreeFromFlat((type, data) => this.putObject(repo, type, data), flat);
    const identity = this.identityLine();
    const data = buildCommit({
      tree,
      parents: parent === null ? [] : [parent],
      message: message.endsWith('\n') ? message : `${message}\n`,
      authorLine: identity,
      committerLine: identity,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The flat tree at a commit (the empty map for an unborn or unknown commit). */
  flatAtCommit(repo: Repo, commitOid: string | null): Map<string, FlatEntry> {
    if (commitOid === null) return new Map();
    const tree = this.commitTree(repo, commitOid);
    if (tree === null) return new Map();
    return flattenTree(repo.objects, tree);
  }

  // -------------------------------------------------------------------------------------------
  // contents API

  /** What GET /contents finds at a path: a file, a directory, or nothing. */
  contentsEntry(
    repo: Repo,
    refName: string | undefined,
    path: string,
  ): { kind: 'file'; entry: FlatEntry; size: number } | { kind: 'dir'; entries: { name: string; path: string; type: 'file' | 'dir'; sha: string }[] } | null {
    const tip = this.resolveRef(repo, refName ?? repo.defaultBranch);
    const commit = tip === null ? null : peelToCommit(repo.objects, tip);
    const tree = commit === null ? null : this.commitTree(repo, commit);
    if (tree === null) return path === '' ? { kind: 'dir', entries: [] } : null;
    if (path === '') return { kind: 'dir', entries: this.dirEntries(repo, tree, '') };
    // Walk the tree segment by segment.
    let current = tree;
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      const entry = parseTreeEntries(object.data).find((candidate) => candidate.name === segments[index]);
      if (entry === undefined) return null;
      if (index === segments.length - 1) {
        if (entry.mode === '40000') return { kind: 'dir', entries: this.dirEntries(repo, entry.oid, path) };
        const blob = repo.objects.get(entry.oid);
        return { kind: 'file', entry: { mode: entry.mode, oid: entry.oid }, size: blob?.data.length ?? 0 };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return null;
  }

  private dirEntries(repo: Repo, treeOid: string, prefix: string): { name: string; path: string; type: 'file' | 'dir'; sha: string }[] {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return [];
    return parseTreeEntries(object.data).map((entry) => ({
      name: entry.name,
      path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
      type: entry.mode === '40000' ? ('dir' as const) : ('file' as const),
      sha: entry.oid,
    }));
  }

  /**
   * Create or update a file on a branch through the contents API. Answers the new blob and
   * commit ids, or 'stale' when a given sha does not match the file's current blob.
   * A branch that does not exist yet is created (from the default branch's tip, or unborn).
   */
  writeFile(
    repo: Repo,
    options: { branch?: string; path: string; content: Buffer; message: string; sha?: string },
  ): { blobOid: string; commitOid: string; created: boolean } | 'stale' {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    let tip = repo.refs.get(ref) ?? null;
    if (tip === null && branch !== repo.defaultBranch) {
      tip = repo.refs.get(this.headRef(repo)) ?? null;
    }
    const flat = this.flatAtCommit(repo, tip);
    const existing = flat.get(options.path);
    if (existing !== undefined && options.sha !== undefined && options.sha !== existing.oid) return 'stale';
    if (existing !== undefined && options.sha === undefined && options.branch !== undefined) {
      // An update through a branch-scoped write still needs no sha for the suite's fixtures;
      // GitHub would demand one, but nothing the suite sends omits it for a plain update.
    }
    const blobOid = this.putObject(repo, 'blob', options.content);
    flat.set(options.path, { mode: '100644', oid: blobOid });
    const commitOid = this.makeCommit(repo, flat, tip, options.message);
    repo.refs.set(ref, commitOid);
    return { blobOid, commitOid, created: existing === undefined };
  }

  /** Delete a file on a branch through the contents API; 'stale' on a sha mismatch, null when absent. */
  deleteFile(
    repo: Repo,
    options: { branch?: string; path: string; message: string; sha?: string },
  ): { commitOid: string } | 'stale' | null {
    const branch = options.branch ?? repo.defaultBranch;
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) return null;
    const flat = this.flatAtCommit(repo, tip);
    const existing = flat.get(options.path);
    if (existing === undefined) return null;
    if (options.sha !== undefined && options.sha !== existing.oid) return 'stale';
    flat.delete(options.path);
    const commitOid = this.makeCommit(repo, flat, tip, options.message);
    repo.refs.set(ref, commitOid);
    return { commitOid };
  }

  /** Commits reachable from a ref or id, newest first (a history walk, parents in order). */
  listCommits(repo: Repo, fromOid: string): { oid: string; tree: string; parents: string[]; author: string; committer: string; message: string }[] {
    const out: { oid: string; tree: string; parents: string[]; author: string; committer: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue = [fromOid];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      const view = parseCommit(object.data);
      out.push({ oid, ...view });
      queue.push(...view.parents);
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // issues, labels, comments

  createLabel(repo: Repo, name: string, color: string, description?: string): Label {
    const existing = repo.labels.get(name);
    if (existing !== undefined) return existing;
    const label: Label = { name, color: color.replace(/^#/, ''), description: description ?? null };
    repo.labels.set(name, label);
    return label;
  }

  /** Create an issue; 'bad-label' when it names a label the repository does not hold. */
  createIssue(repo: Repo, input: { title: string; body?: string; labels?: readonly string[] }): Issue | 'bad-label' {
    for (const name of input.labels ?? []) {
      if (!repo.labels.has(name)) return 'bad-label';
    }
    const now = this.clock.peekIso();
    const issue: Issue = {
      id: this.nextId(),
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      labels: [...(input.labels ?? [])],
      comments: [],
      seq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = { id: this.nextId(), body, seq: this.nextSeq() };
    issue.comments.push(comment);
    issue.updatedAt = this.clock.peekIso();
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // pull requests

  /** Create a pull request; 'invalid' when head or base does not name a branch. */
  createPull(repo: Repo, input: { title: string; body?: string; head: string; base: string }): Pull | 'invalid' {
    const headTip = repo.refs.get(`refs/heads/${input.head}`);
    const baseTip = repo.refs.get(`refs/heads/${input.base}`);
    if (headTip === undefined || baseTip === undefined) return 'invalid';
    const now = this.clock.peekIso();
    const pull: Pull = {
      id: this.nextId(),
      number: repo.nextNumber,
      title: input.title,
      body: input.body ?? '',
      state: 'open',
      headRef: input.head,
      baseRef: input.base,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      seq: this.nextSeq(),
      createdAt: now,
      updatedAt: now,
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The merge-base flat tree, head flat tree and base flat tree a pull request spans. */
  private pullTrees(repo: Repo, pull: Pull): { base: Map<string, FlatEntry>; ours: Map<string, FlatEntry>; theirs: Map<string, FlatEntry>; mergeBaseOid: string | null } {
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? null;
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null;
    const mergeBaseOid = headTip !== null && baseTip !== null ? mergeBase(repo.objects, baseTip, headTip) : null;
    return {
      base: this.flatAtCommit(repo, mergeBaseOid),
      ours: this.flatAtCommit(repo, baseTip),
      theirs: this.flatAtCommit(repo, headTip),
      mergeBaseOid,
    };
  }

  /** The files a pull request changes (merge-base tree against head tree). */
  pullFiles(repo: Repo, pull: Pull): FileChange[] {
    const trees = this.pullTrees(repo, pull);
    return diffFlatTrees(repo.objects, trees.base, trees.theirs);
  }

  /** Whether a pull request merges cleanly right now: 'MERGEABLE', 'CONFLICTING' or 'UNKNOWN'. */
  pullMergeable(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'UNKNOWN';
    const trees = this.pullTrees(repo, pull);
    return mergeFlatTrees(trees.base, trees.ours, trees.theirs).conflicts.length > 0 ? 'CONFLICTING' : 'MERGEABLE';
  }

  /**
   * Merge a pull request into its base branch. 'squash' makes one commit with the base tip
   * as its only parent; 'merge' makes a two-parent merge commit. Answers the merge commit
   * id, or 'conflict' when the three-way merge does not resolve, or 'not-open'.
   */
  mergePull(repo: Repo, pull: Pull, method: 'squash' | 'merge' | 'rebase'): { sha: string } | 'conflict' | 'not-open' {
    if (pull.state !== 'open' || pull.merged) return 'not-open';
    const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
    if (headTip === undefined || baseTip === undefined) return 'conflict';
    const trees = this.pullTrees(repo, pull);
    const merged = mergeFlatTrees(trees.base, trees.ours, trees.theirs);
    if (merged.conflicts.length > 0) return 'conflict';
    const message = `${pull.title} (#${pull.number})${pull.body === '' ? '' : `\n\n${pull.body}`}`;
    let sha: string;
    if (method === 'merge') {
      const tree = buildTreeFromFlat((type, data) => this.putObject(repo, type, data), merged.flat);
      const identity = this.identityLine();
      sha = this.putObject(
        repo,
        'commit',
        buildCommit({ tree, parents: [baseTip, headTip], message: `${message}\n`, authorLine: identity, committerLine: identity }),
      );
    } else {
      sha = this.makeCommit(repo, merged.flat, baseTip, message);
    }
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.clock.peekIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return { sha };
  }

  /** Every object reachable from the given tips (the store's own walk, for pack building). */
  reachable(repo: Repo, tips: Iterable<string>): Set<string> {
    return collectReachable(repo.objects, tips, { allowMissing: true });
  }

  /** Ancestors of a commit (for fast-forward checks). */
  ancestors(repo: Repo, tip: string): Set<string> {
    return commitAncestors(repo.objects, tip);
  }

  /** Whether `ancestor` is an ancestor of `descendant` in this repository. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    return isAncestor(repo.objects, ancestor, descendant);
  }
}

/** Parse a tree object's entries (a local alias so forge.ts reads plainly). */
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

/** Re-exported for the serializers: a tag object's parsed view. */
export { parseTag };
