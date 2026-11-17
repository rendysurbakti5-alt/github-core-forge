// The MCP surface: JSON-RPC 2.0 over POST /mcp. The modern discovery method is answered
// (so clients stay in the session-free era), initialize is answered for legacy clients,
// and six tools expose the same forge the REST API serves. Tool definitions live in one
// constant so tools/list is byte-identical across calls.

import type { Forge } from './forge.ts';
import { issueJson, pullJson, repoJson } from './serializers.ts';

export const MCP_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const stringProp = (description: string): { type: string; description: string } => ({ type: 'string', description });

export const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: stringProp('The repository name.'),
        description: stringProp('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The issue title.'),
        body: stringProp('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed or all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        state: stringProp('Filter by state: open, closed or all (default open).'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        title: stringProp('The pull request title.'),
        head: stringProp('The head branch name.'),
        base: stringProp('The base branch name.'),
        body: stringProp('The pull request body.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request into its base branch (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: stringProp('The repository owner login.'),
        repo: stringProp('The repository name.'),
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export interface McpOutcome {
  /** HTTP status to answer with. */
  status: number;
  /** The JSON-RPC response object, or null for an empty (notification) answer. */
  body: Record<string, unknown> | null;
}

function result(id: unknown, value: unknown): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result: value } };
}

function rpcError(id: unknown, code: number, message: string): McpOutcome {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolOk(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload as Record<string, unknown>,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function stringArg(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return toolError(`Unknown tool: ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      return toolError(`Missing required argument: ${required}`);
    }
  }
  const repoArg = (): ReturnType<Forge['repoForOwner']> => {
    const owner = stringArg(args, 'owner');
    const repoName = stringArg(args, 'repo');
    if (owner === undefined || repoName === undefined) return null;
    return forge.repoForOwner(owner, repoName);
  };

  switch (name) {
    case 'create_repo': {
      const repoName = stringArg(args, 'name')!;
      const existing = forge.repoByName(repoName);
      if (existing !== undefined) return toolError(`Repository ${repoName} already exists`);
      const repo = forge.createRepo(repoName, {
        isPrivate: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (repo === null) return toolError(`Repository ${repoName} already exists`);
      return toolOk(repoJson(forge, repo));
    }
    case 'get_repo': {
      const repo = repoArg();
      if (repo === null) return toolError('Repository not found');
      return toolOk(repoJson(forge, repo));
    }
    case 'create_issue': {
      const repo = repoArg();
      if (repo === null) return toolError('Repository not found');
      const labels = Array.isArray(args.labels) ? args.labels.map(String) : undefined;
      const issue = forge.createIssue(repo, {
        title: stringArg(args, 'title')!,
        body: typeof args.body === 'string' ? args.body : '',
        ...(labels !== undefined ? { labels } : {}),
      });
      if (issue === 'bad-label') return toolError('Unknown label');
      return toolOk(issueJson(forge, repo, issue));
    }
    case 'list_issues': {
      const repo = repoArg();
      if (repo === null) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.number - b.number)
        .map((issue) => issueJson(forge, repo, issue));
      return toolOk(list);
    }
    case 'create_pull_request': {
      const repo = repoArg();
      if (repo === null) return toolError('Repository not found');
      const pull = forge.createPull(repo, {
        title: stringArg(args, 'title')!,
        body: typeof args.body === 'string' ? args.body : '',
        head: stringArg(args, 'head')!,
        base: stringArg(args, 'base')!,
      });
      if (pull === 'invalid') return toolError('Head or base branch is invalid');
      return toolOk(pullJson(forge, repo, pull));
    }
    case 'merge_pull_request': {
      const repo = repoArg();
      if (repo === null) return toolError('Repository not found');
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) return toolError('Pull request not found');
      const merged = forge.mergePull(repo, pull, 'squash');
      if (merged === 'conflict') return toolError('Pull request has conflicts and cannot be merged');
      if (merged === 'not-open') return toolError('Pull request is not open');
      return toolOk(pullJson(forge, repo, pull));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

/** Handle one already-parsed JSON-RPC request object. */
export function handleMcpRequest(forge: Forge, request: Record<string, unknown>): McpOutcome {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return result(id, {
        supportedVersions: [...MCP_PROTOCOL_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return result(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'makefun-forge', version: '1.0.0' },
      });
    }
    case 'ping':
      return result(id, {});
    case 'tools/list':
      return result(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      if (!TOOLS.some((tool) => tool.name === toolName)) return rpcError(id, -32601, `Unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      return result(id, callTool(forge, toolName, args));
    }
    case 'resources/list':
      return result(id, { resources: [] });
    case 'resources/templates/list':
      return result(id, { resourceTemplates: [] });
    case 'prompts/list':
      return result(id, { prompts: [] });
    default:
      if (isNotification || method.startsWith('notifications/')) return { status: 202, body: null };
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/** Handle a raw /mcp request body (single request or a batch). */
export function handleMcpBody(forge: Forge, raw: Buffer): McpOutcome & { batch?: Record<string, unknown>[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const responses: Record<string, unknown>[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const outcome = handleMcpRequest(forge, item as Record<string, unknown>);
      if (outcome.body !== null) responses.push(outcome.body);
    }
    return { status: 200, body: null, batch: responses };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } } };
  }
  return handleMcpRequest(forge, parsed as Record<string, unknown>);
}
