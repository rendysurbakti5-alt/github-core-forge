// The forge's HTTP surface: routing, bearer auth, the REST API under /api/v3, the GraphQL
// endpoint, the MCP endpoint, and the git smart-HTTP routes. Everything except /healthz
// requires the suite's shop token; repositories answer only under their owner's name.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge, type Repo } from './forge.ts';
import { parseCommit } from './git.ts';
import {
  fetchResponseV0,
  fetchResponseV2,
  lsRefs,
  parseFetchArgs,
  receivePack,
  requestLines,
  v0Advertisement,
  v2Advertisement,
  type FetchArgs,
} from './gitserver.ts';
import { executeGraphql } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';
import { commentJson, issueJson, labelJson, pullJson, repoJson, userJson } from './serializers.ts';
import { ZERO_OID, b64decodeBytes, decodePktLines, decodeSegment } from './util.ts';

export interface App {
  server: Server;
  forge: Forge;
}

const JSON_TYPE = 'application/json; charset=utf-8';

export function createApp(): App {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const forge = new Forge(process.env.MAKEFUN_TRIAL_NOW);
  let requestCounter = 0;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        await route(req, res);
      } catch {
        if (!res.headersSent) sendJson(req, res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (header === undefined || token === '') return false;
    return header === `Bearer ${token}` || header === `token ${token}`;
  }

  function sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body) ?? '';
    const headers: Record<string, string> = { 'content-type': JSON_TYPE, 'content-length': String(Buffer.byteLength(text)) };
    const path = new URL(req.url ?? '/', 'http://forge').pathname;
    if (path.startsWith('/api/v3') || path === '/api/graphql') {
      requestCounter += 1;
      headers['x-github-request-id'] = `forge-${requestCounter}`;
      headers['x-oauth-scopes'] = 'repo, read:org';
      headers['x-accepted-oauth-scopes'] = 'repo, read:org';
    }
    res.writeHead(status, headers);
    res.end(text);
  }

  function sendRaw(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
    res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
    res.end(body);
  }

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  /** Parse a JSON request body; answers false (after sending 400) when it is malformed. */
  async function readJson(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
    const raw = await readBody(req);
    if (raw.length === 0) return {};
    try {
      const parsed = JSON.parse(raw.toString('utf8')) as unknown;
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        sendJson(req, res, 400, { message: 'Invalid JSON body' });
        return null;
      }
      return parsed as Record<string, unknown>;
    } catch {
      sendJson(req, res, 400, { message: 'Problems parsing JSON' });
      return null;
    }
  }

  function notFound(req: IncomingMessage, res: ServerResponse): void {
    sendJson(req, res, 404, { message: 'Not Found' });
  }

  /** Slice a list by ?page / ?per_page and set the Link header the REST client follows. */
  function paginate<T>(req: IncomingMessage, res: ServerResponse, items: readonly T[], url: URL): T[] {
    const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '', 10);
    const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
    const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '', 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    if (start + perPage < items.length) {
      const next = new URL(url.pathname, `http://${req.headers.host ?? '127.0.0.1'}`);
      for (const [key, value] of url.searchParams) next.searchParams.set(key, value);
      next.searchParams.set('per_page', String(perPage));
      next.searchParams.set('page', String(page + 1));
      res.setHeader('link', `<${next.toString()}>; rel="next"`);
    }
    return slice;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://forge');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/healthz' && method === 'GET') {
      sendJson(req, res, 200, { ok: true });
      return;
    }

    if (!authorized(req)) {
      sendJson(req, res, 401, { message: 'Requires authentication' });
      return;
    }

    if (path === '/api/graphql') {
      if (method !== 'POST') return notFound(req, res);
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(req, res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
        return;
      }
      const runOne = (entry: unknown): unknown => {
        const operation = (entry ?? {}) as Record<string, unknown>;
        const query = typeof operation.query === 'string' ? operation.query : '';
        const variables = (operation.variables ?? {}) as Record<string, unknown>;
        const operationName = typeof operation.operationName === 'string' ? operation.operationName : undefined;
        return executeGraphql(forge, query, variables, operationName);
      };
      if (Array.isArray(parsed)) sendJson(req, res, 200, parsed.map(runOne));
      else sendJson(req, res, 200, runOne(parsed));
      return;
    }

    if (path === '/mcp') {
      if (method !== 'POST') {
        res.writeHead(405, { 'content-type': JSON_TYPE });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } }));
        return;
      }
      const outcome = handleMcpBody(forge, await readBody(req));
      if (outcome.batch !== undefined) {
        sendJson(req, res, outcome.status, outcome.batch);
      } else if (outcome.body === null) {
        res.writeHead(outcome.status);
        res.end();
      } else {
        sendJson(req, res, outcome.status, outcome.body);
      }
      return;
    }

    if (path.startsWith('/api/v3')) {
      await routeRest(req, res, url, method);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/...
    const gitMatch = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch !== null) {
      await routeGit(req, res, url, method, decodeSegment(gitMatch[1]!), decodeSegment(gitMatch[2]!), gitMatch[3]!);
      return;
    }

    notFound(req, res);
  }

  async function routeGit(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    owner: string,
    repoName: string,
    action: string,
  ): Promise<void> {
    forge.learnLogin(owner);
    const repo = forge.repoByName(repoName);
    if (repo === undefined) {
      sendRaw(res, 404, 'text/plain', Buffer.from('repository not found\n'));
      return;
    }
    if (action === 'info/refs' && method === 'GET') {
      const service = url.searchParams.get('service');
      const protocol = req.headers['git-protocol'] ?? '';
      if (service === 'git-upload-pack') {
        if (protocol.includes('version=2')) {
          sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
        } else {
          sendRaw(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(forge, repo, 'git-upload-pack'));
        }
      } else if (service === 'git-receive-pack') {
        sendRaw(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(forge, repo, 'git-receive-pack'));
      } else {
        sendRaw(res, 400, 'text/plain', Buffer.from('unknown service\n'));
      }
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      const body = await readBody(req);
      const protocol = req.headers['git-protocol'] ?? '';
      try {
        if (protocol.includes('version=2')) {
          const { command, args } = requestLines(body);
          if (command === 'ls-refs') {
            sendRaw(res, 200, 'application/x-git-upload-pack-result', lsRefs(forge, repo, args));
          } else if (command === 'fetch') {
            sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, parseFetchArgs(args)));
          } else {
            sendRaw(res, 400, 'text/plain', Buffer.from('unknown command\n'));
          }
        } else {
          const { packets } = decodePktLines(body);
          const lines: string[] = [];
          for (const packet of packets) {
            if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
          }
          sendRaw(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, parseFetchArgs(lines)));
        }
      } catch {
        sendRaw(res, 400, 'text/plain', Buffer.from('invalid request\n'));
      }
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      const body = await readBody(req);
      try {
        sendRaw(res, 200, 'application/x-git-receive-pack-result', receivePack(forge, repo, body));
      } catch {
        sendRaw(res, 400, 'text/plain', Buffer.from('invalid request\n'));
      }
      return;
    }
    sendRaw(res, 404, 'text/plain', Buffer.from('not found\n'));
  }

  /** Resolve the repository a REST route names, learning/adopting its owner; null → 404. */
  function restRepo(owner: string, name: string): Repo | null {
    return forge.repoForOwner(owner, name);
  }

  async function routeRest(req: IncomingMessage, res: ServerResponse, url: URL, method: string): Promise<void> {
    const segments = url.pathname.split('/').filter(Boolean).map(decodeSegment);
    // segments[0] = 'api', segments[1] = 'v3'
    const rest = segments.slice(2);

    if (rest.length === 0 && method === 'GET') {
      sendJson(req, res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
        emojis_url: '/api/v3/emojis',
      });
      return;
    }
    if (rest[0] === 'meta' && method === 'GET') {
      sendJson(req, res, 200, { installed_version: 'makefun-forge 1.0.0', verifiable_password_authentication: false });
      return;
    }
    if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
      sendJson(req, res, 200, userJson(forge));
      return;
    }
    if (rest[0] === 'user' && rest[1] === 'repos') {
      if (method === 'GET') {
        const mine = forge.allRepos().filter((repo) => repo.ownerLogin === null || repo.ownerLogin === forge.viewerLogin());
        sendJson(req, res, 200, paginate(req, res, mine, url).map((repo) => repoJson(forge, repo)));
        return;
      }
      if (method === 'POST') {
        const body = await readJson(req, res);
        if (body === null) return;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendJson(req, res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
          return;
        }
        if (forge.repoByName(name) !== undefined) {
          sendJson(req, res, 422, { message: `Repository creation failed: a repository named "${name}" already exists on this account` });
          return;
        }
        const repo = forge.createRepo(name, {
          isPrivate: body.private === true,
          description: typeof body.description === 'string' ? body.description : '',
        });
        if (repo === null) {
          sendJson(req, res, 422, { message: 'Repository creation failed: name already exists' });
          return;
        }
        sendJson(req, res, 201, repoJson(forge, repo));
        return;
      }
    }

    if (rest[0] === 'repos' && rest.length >= 3) {
      const owner = rest[1]!;
      const repoName = rest[2]!;
      const tail = rest.slice(3);
      const repo = restRepo(owner, repoName);
      if (repo === null) return notFound(req, res);

      if (tail.length === 0) {
        if (method === 'GET') {
          sendJson(req, res, 200, repoJson(forge, repo));
          return;
        }
        if (method === 'PATCH') {
          const body = await readJson(req, res);
          if (body === null) return;
          if (typeof body.description === 'string') repo.description = body.description;
          if (typeof body.private === 'boolean') repo.isPrivate = body.private;
          if (typeof body.name === 'string' && body.name !== '' && body.name !== repo.name && forge.repoByName(body.name) === undefined) {
            forge.renameRepo(repo, body.name);
          }
          repo.updatedAt = forge.clock.peekIso();
          sendJson(req, res, 200, repoJson(forge, repo));
          return;
        }
        if (method === 'DELETE') {
          forge.deleteRepo(repo);
          res.writeHead(204);
          res.end();
          return;
        }
        return notFound(req, res);
      }

      await routeRepoTail(req, res, url, method, repo, tail);
      return;
    }

    notFound(req, res);
  }

  async function routeRepoTail(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    method: string,
    repo: Repo,
    tail: string[],
  ): Promise<void> {
    const [head, ...rest] = tail;

    if (head === 'branches') {
      if (rest.length === 0 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(req, res, 200, branches);
        return;
      }
      if (rest.length >= 1 && method === 'GET') {
        const branch = rest.join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return notFound(req, res);
        sendJson(req, res, 200, { name: branch, commit: { sha, ...commitSummary(repo, sha) }, protected: false });
        return;
      }
      return notFound(req, res);
    }

    if (head === 'git' && rest[0] === 'refs') {
      if (rest.length === 1 && method === 'POST') {
        const body = await readJson(req, res);
        if (body === null) return;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          sendJson(req, res, 422, { message: 'Validation Failed: ref or sha is invalid' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(req, res, 201, { ref, node_id: `ref:${ref}`, object: { sha, type: repo.objects.get(sha)!.type } });
        return;
      }
      if (rest.length >= 3 && rest[1] === 'heads' && method === 'GET') {
        const branch = rest.slice(2).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) return notFound(req, res);
        sendJson(req, res, 200, { ref: `refs/heads/${branch}`, node_id: `ref:refs/heads/${branch}`, object: { sha, type: 'commit' } });
        return;
      }
      return notFound(req, res);
    }

    if (head === 'commits' && rest.length === 0 && method === 'GET') {
      const from = url.searchParams.get('sha') ?? repo.defaultBranch;
      const tip = forge.resolveRef(repo, from);
      if (tip === null) {
        sendJson(req, res, 200, []);
        return;
      }
      const commits = forge.listCommits(repo, tip).map((view) => ({
        sha: view.oid,
        commit: {
          message: view.message.replace(/\n+$/, ''),
          author: { name: view.author.split(' <')[0] ?? '', date: forge.clock.peekIso() },
          committer: { name: view.committer.split(' <')[0] ?? '', date: forge.clock.peekIso() },
          tree: { sha: view.tree },
        },
        parents: view.parents.map((parent) => ({ sha: parent })),
      }));
      sendJson(req, res, 200, paginate(req, res, commits, url));
      return;
    }

    if (head === 'contents') {
      const contentPath = rest.join('/');
      if (method === 'GET') {
        const found = forge.contentsEntry(repo, url.searchParams.get('ref') ?? undefined, contentPath);
        if (found === null) return notFound(req, res);
        if (found.kind === 'dir') {
          sendJson(
            req,
            res,
            200,
            found.entries.map((entry) => ({ name: entry.name, path: entry.path, sha: entry.sha, size: 0, type: entry.type })),
          );
          return;
        }
        const blob = repo.objects.get(found.entry.oid);
        const content = blob === undefined ? '' : wrapBase64(blob.data.toString('base64'));
        const name = contentPath.split('/').pop() ?? contentPath;
        sendJson(req, res, 200, {
          name,
          path: contentPath,
          sha: found.entry.oid,
          size: found.size,
          type: 'file',
          encoding: 'base64',
          content,
        });
        return;
      }
      if (method === 'PUT') {
        const body = await readJson(req, res);
        if (body === null) return;
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const content = typeof body.content === 'string' ? b64decodeBytes(body.content.replace(/\s+/g, '')) : Buffer.alloc(0);
        const written = forge.writeFile(repo, {
          path: contentPath,
          content,
          message,
          ...(typeof body.branch === 'string' ? { branch: body.branch } : {}),
          ...(typeof body.sha === 'string' ? { sha: body.sha } : {}),
        });
        if (written === 'stale') {
          sendJson(req, res, 409, { message: 'Conflict: the file has changed since the given sha' });
          return;
        }
        const name = contentPath.split('/').pop() ?? contentPath;
        sendJson(req, res, written.created ? 201 : 200, {
          content: { name, path: contentPath, sha: written.blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: written.commitOid, message },
        });
        return;
      }
      if (method === 'DELETE') {
        const body = await readJson(req, res);
        if (body === null) return;
        const deleted = forge.deleteFile(repo, {
          path: contentPath,
          message: typeof body.message === 'string' ? body.message : 'Delete file',
          ...(typeof body.branch === 'string' ? { branch: body.branch } : {}),
          ...(typeof body.sha === 'string' ? { sha: body.sha } : {}),
        });
        if (deleted === null) return notFound(req, res);
        if (deleted === 'stale') {
          sendJson(req, res, 409, { message: 'Conflict: the file has changed since the given sha' });
          return;
        }
        sendJson(req, res, 200, { content: null, commit: { sha: deleted.commitOid } });
        return;
      }
      return notFound(req, res);
    }

    if (head === 'labels') {
      if (rest.length === 0 && method === 'POST') {
        const body = await readJson(req, res);
        if (body === null) return;
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          sendJson(req, res, 422, { message: 'Validation Failed: name is required' });
          return;
        }
        if (repo.labels.has(name)) {
          sendJson(req, res, 422, { message: 'Validation Failed: label already exists' });
          return;
        }
        const label = forge.createLabel(repo, name, typeof body.color === 'string' ? body.color : '000000', typeof body.description === 'string' ? body.description : undefined);
        sendJson(req, res, 201, labelJson(label));
        return;
      }
      if (rest.length === 0 && method === 'GET') {
        sendJson(req, res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      return notFound(req, res);
    }

    if (head === 'issues') {
      if (rest.length === 0) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const direction = url.searchParams.get('direction') ?? 'desc';
          let list = [...repo.issues.values()];
          if (state !== 'all') list = list.filter((issue) => issue.state === state);
          const labelFilter = url.searchParams.get('labels');
          if (labelFilter !== null && labelFilter !== '') {
            const wanted = labelFilter.split(',');
            list = list.filter((issue) => wanted.every((name) => issue.labels.includes(name)));
          }
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          sendJson(req, res, 200, paginate(req, res, list, url).map((issue) => issueJson(forge, repo, issue)));
          return;
        }
        if (method === 'POST') {
          const body = await readJson(req, res);
          if (body === null) return;
          if (typeof body.title !== 'string' || body.title === '') {
            sendJson(req, res, 422, { message: 'Validation Failed: title is required' });
            return;
          }
          const labels = Array.isArray(body.labels) ? body.labels.map((label) => (typeof label === 'string' ? label : String((label as { name?: unknown }).name ?? ''))) : undefined;
          const issue = forge.createIssue(repo, {
            title: body.title,
            body: typeof body.body === 'string' ? body.body : '',
            ...(labels !== undefined ? { labels } : {}),
          });
          if (issue === 'bad-label') {
            sendJson(req, res, 422, { message: 'Validation Failed: one or more labels do not exist' });
            return;
          }
          sendJson(req, res, 201, issueJson(forge, repo, issue));
          return;
        }
        return notFound(req, res);
      }
      const number = Number.parseInt(rest[0]!, 10);
      const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
      if (rest.length === 1) {
        if (issue === undefined) return notFound(req, res);
        if (method === 'GET') {
          sendJson(req, res, 200, issueJson(forge, repo, issue));
          return;
        }
        if (method === 'PATCH') {
          const body = await readJson(req, res);
          if (body === null) return;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (Array.isArray(body.labels)) {
            const names = body.labels.map((label) => (typeof label === 'string' ? label : String((label as { name?: unknown }).name ?? '')));
            if (names.some((name) => !repo.labels.has(name))) {
              sendJson(req, res, 422, { message: 'Validation Failed: one or more labels do not exist' });
              return;
            }
            issue.labels = names;
          }
          issue.updatedAt = forge.clock.peekIso();
          sendJson(req, res, 200, issueJson(forge, repo, issue));
          return;
        }
        return notFound(req, res);
      }
      if (rest.length === 2 && rest[1] === 'comments') {
        if (issue === undefined) return notFound(req, res);
        if (method === 'GET') {
          sendJson(req, res, 200, paginate(req, res, issue.comments, url).map((comment) => commentJson(forge, repo, issue, comment)));
          return;
        }
        if (method === 'POST') {
          const body = await readJson(req, res);
          if (body === null) return;
          const comment = forge.addComment(repo, issue, typeof body.body === 'string' ? body.body : '');
          sendJson(req, res, 201, commentJson(forge, repo, issue, comment));
          return;
        }
        return notFound(req, res);
      }
      return notFound(req, res);
    }

    if (head === 'pulls') {
      if (rest.length === 0) {
        if (method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          let list = [...repo.pulls.values()];
          if (state !== 'all') list = list.filter((pull) => pull.state === state);
          const direction = url.searchParams.get('direction') ?? 'desc';
          list.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          sendJson(req, res, 200, paginate(req, res, list, url).map((pull) => pullJson(forge, repo, pull)));
          return;
        }
        if (method === 'POST') {
          const body = await readJson(req, res);
          if (body === null) return;
          const pull = forge.createPull(repo, {
            title: typeof body.title === 'string' ? body.title : '',
            body: typeof body.body === 'string' ? body.body : '',
            head: typeof body.head === 'string' ? body.head : '',
            base: typeof body.base === 'string' ? body.base : '',
          });
          if (pull === 'invalid') {
            sendJson(req, res, 422, { message: 'Validation Failed: head or base is invalid' });
            return;
          }
          sendJson(req, res, 201, pullJson(forge, repo, pull));
          return;
        }
        return notFound(req, res);
      }
      const number = Number.parseInt(rest[0]!, 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (rest.length === 1 && method === 'GET') {
        if (pull === undefined) return notFound(req, res);
        sendJson(req, res, 200, pullJson(forge, repo, pull));
        return;
      }
      if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
        if (pull === undefined) return notFound(req, res);
        const files = forge.pullFiles(repo, pull).map((change) => ({
          filename: change.filename,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
        }));
        sendJson(req, res, 200, files);
        return;
      }
      if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
        if (pull === undefined) return notFound(req, res);
        const body = await readJson(req, res);
        if (body === null) return;
        const methodName = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
        const merged = forge.mergePull(repo, pull, methodName === 'merge' ? 'merge' : 'squash');
        if (merged === 'conflict' || merged === 'not-open') {
          sendJson(req, res, 405, { message: 'Pull Request is not mergeable' });
          return;
        }
        sendJson(req, res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
      return notFound(req, res);
    }

    notFound(req, res);
  }

  function commitSummary(repo: Repo, sha: string): Record<string, unknown> {
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') return {};
    const view = parseCommit(object.data);
    return { commit: { message: view.message, tree: { sha: view.tree } }, parents: view.parents.map((parent) => ({ sha: parent })) };
  }

  return { server, forge };
}

/** Wrap base64 the way GitHub does (60-column lines). */
function wrapBase64(text: string): string {
  const lines: string[] = [];
  for (let index = 0; index < text.length; index += 60) lines.push(text.slice(index, index + 60));
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

export type { FetchArgs };
export { ZERO_OID };
