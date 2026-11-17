// A compact GraphQL engine for the forge's schema: the viewer, repositories, issues and
// pull requests the conformance documents query, the five mutations they drive, Relay
// node(id:) lookups, cursor connections, and the __type introspection surface (including
// the unknown-field error wording GitHub uses). Documents are fixed by the suite, so the
// engine covers the GraphQL features those documents use: operations with variables,
// aliases, arguments of every literal kind, inline and named fragments.

import { globalId, parseGlobalId, type Forge, type Issue, type Pull, type Repo } from './forge.ts';
import { issueJson, pullJson, repoJson } from './serializers.ts';
import { ZERO_OID } from './util.ts';

// ---------------------------------------------------------------------------------------------
// lexer + parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet?: SelectionNode[];
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition?: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      index += 1;
      continue;
    }
    if (source.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('{}()[]:@$=!&|'.includes(ch)) {
      tokens.push(ch);
      index += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', index)) {
        const end = source.indexOf('"""', index + 3);
        tokens.push(`"${source.slice(index + 3, end < 0 ? source.length : end)}"`);
        index = end < 0 ? source.length : end + 3;
        continue;
      }
      let cursor = index + 1;
      let value = '';
      while (cursor < source.length && source[cursor] !== '"') {
        if (source[cursor] === '\\') {
          value += source[cursor + 1] === 'n' ? '\n' : source[cursor + 1] === 't' ? '\t' : source[cursor + 1]!;
          cursor += 2;
        } else {
          value += source[cursor];
          cursor += 1;
        }
      }
      tokens.push(`"${value}"`);
      index = cursor + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let cursor = index;
      while (cursor < source.length && isNameChar(source[cursor]!)) cursor += 1;
      tokens.push(source.slice(index, cursor));
      index = cursor;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let cursor = index;
      while (cursor < source.length && /[0-9.]/.test(source[cursor]!)) cursor += 1;
      tokens.push(source.slice(index, cursor));
      index = cursor;
      continue;
    }
    index += 1;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }
  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    if (token === undefined) throw new Error('unexpected end of document');
    return token;
  }
  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }
  private skip(token: string): boolean {
    if (this.peek() === token) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ operation: 'query', variableDefaults: new Map(), selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation' || head === 'subscription') {
        this.next();
        let name: string | undefined;
        if (this.peek() !== undefined && /^[A-Za-z_]/.test(this.peek()!) && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        const variableDefaults = new Map<string, ValueNode>();
        if (this.skip('(')) {
          while (!this.skip(')')) {
            this.expect('$');
            const varName = this.next();
            this.expect(':');
            this.parseType();
            if (this.skip('=')) variableDefaults.set(varName, this.parseValue());
            if (this.peek() === '@') this.parseDirectives();
          }
        }
        if (this.peek() === '@') this.parseDirectives();
        operations.push({
          operation: head === 'mutation' ? 'mutation' : 'query',
          ...(name !== undefined ? { name } : {}),
          variableDefaults,
          selectionSet: this.parseSelectionSet(),
        });
      } else if (head === 'fragment') {
        this.next();
        const fragName = this.next();
        this.expect('on');
        const typeCondition = this.next();
        if (this.peek() === '@') this.parseDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return { operations, fragments };
  }

  private parseType(): void {
    if (this.skip('[')) {
      this.parseType();
      this.expect(']');
    } else {
      this.next();
    }
    this.skip('!');
  }

  private parseDirectives(): void {
    while (this.skip('@')) {
      this.next();
      if (this.skip('(')) {
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token === '(') depth += 1;
          else if (token === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (!this.skip('}')) selections.push(this.parseSelection());
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.skip('...')) {
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        if (this.peek() === '@') this.parseDirectives();
        return { kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      const name = this.next();
      if (this.peek() === '@') this.parseDirectives();
      return { kind: 'spread', name };
    }
    let name = this.next();
    let alias: string | undefined;
    if (this.skip(':')) {
      alias = name;
      name = this.next();
    }
    const args = new Map<string, ValueNode>();
    if (this.skip('(')) {
      while (!this.skip(')')) {
        const argName = this.next();
        this.expect(':');
        args.set(argName, this.parseValue());
      }
    }
    if (this.peek() === '@') this.parseDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : undefined;
    return { kind: 'field', ...(alias !== undefined ? { alias } : {}), name, args, ...(selectionSet !== undefined ? { selectionSet } : {}) };
  }

  private parseValue(): ValueNode {
    const token = this.peek()!;
    if (token === '$') {
      this.next();
      return { kind: 'variable', name: this.next() };
    }
    if (token === '[') {
      this.next();
      const values: ValueNode[] = [];
      while (!this.skip(']')) values.push(this.parseValue());
      return { kind: 'list', values };
    }
    if (token === '{') {
      this.next();
      const fields: { name: string; value: ValueNode }[] = [];
      while (!this.skip('}')) {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) {
      this.next();
      return { kind: 'string', value: token.slice(1, -1) };
    }
    this.next();
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'int':
    case 'float':
    case 'string':
    case 'boolean':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.values.map((value) => resolveValue(value, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// schema description (drives introspection and unknown-field errors)

interface FieldDef {
  type: string;
  args?: { name: string; type: string }[];
}

const OBJECT_FIELDS: Record<string, Record<string, FieldDef>> = {
  Query: {
    viewer: { type: 'User!' },
    repository: { type: 'Repository', args: [{ name: 'owner', type: 'String!' }, { name: 'name', type: 'String!' }] },
    node: { type: 'Node', args: [{ name: 'id', type: 'ID!' }] },
    rateLimit: { type: 'RateLimit' },
    search: { type: 'SearchResultItemConnection!', args: [{ name: 'query', type: 'String!' }, { name: 'type', type: 'SearchType!' }] },
    __type: { type: '__Type', args: [{ name: 'name', type: 'String!' }] },
    __schema: { type: '__Schema' },
  },
  Mutation: {
    createIssue: { type: 'CreateIssuePayload', args: [{ name: 'input', type: 'CreateIssueInput!' }] },
    closeIssue: { type: 'CloseIssuePayload', args: [{ name: 'input', type: 'CloseIssueInput!' }] },
    createPullRequest: { type: 'CreatePullRequestPayload', args: [{ name: 'input', type: 'CreatePullRequestInput!' }] },
    mergePullRequest: { type: 'MergePullRequestPayload', args: [{ name: 'input', type: 'MergePullRequestInput!' }] },
    addComment: { type: 'AddCommentPayload', args: [{ name: 'input', type: 'AddCommentInput!' }] },
  },
  User: {
    id: { type: 'ID!' },
    login: { type: 'String!' },
    name: { type: 'String' },
    url: { type: 'URI!' },
    avatarUrl: { type: 'URI!' },
  },
  Repository: {
    id: { type: 'ID!' },
    databaseId: { type: 'Int' },
    name: { type: 'String!' },
    nameWithOwner: { type: 'String!' },
    owner: { type: 'RepositoryOwner!' },
    defaultBranchRef: { type: 'Ref' },
    viewerPermission: { type: 'RepositoryPermission' },
    hasIssuesEnabled: { type: 'Boolean!' },
    description: { type: 'String' },
    isPrivate: { type: 'Boolean!' },
    url: { type: 'URI!' },
    createdAt: { type: 'DateTime!' },
    updatedAt: { type: 'DateTime!' },
    issue: { type: 'Issue', args: [{ name: 'number', type: 'Int!' }] },
    issues: {
      type: 'IssueConnection!',
      args: [
        { name: 'first', type: 'Int' },
        { name: 'after', type: 'String' },
        { name: 'states', type: '[IssueState!]' },
        { name: 'orderBy', type: 'IssueOrder' },
        { name: 'labels', type: '[String!]' },
      ],
    },
    pullRequest: { type: 'PullRequest', args: [{ name: 'number', type: 'Int!' }] },
    pullRequests: {
      type: 'PullRequestConnection!',
      args: [
        { name: 'first', type: 'Int' },
        { name: 'after', type: 'String' },
        { name: 'states', type: '[PullRequestState!]' },
        { name: 'orderBy', type: 'IssueOrder' },
      ],
    },
  },
  Issue: {
    id: { type: 'ID!' },
    number: { type: 'Int!' },
    title: { type: 'String!' },
    state: { type: 'IssueState!' },
    body: { type: 'String!' },
    url: { type: 'URI!' },
    author: { type: 'Actor' },
    repository: { type: 'Repository!' },
    createdAt: { type: 'DateTime!' },
    updatedAt: { type: 'DateTime!' },
    comments: { type: 'IssueCommentConnection!', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
    labels: { type: 'LabelConnection!', args: [{ name: 'first', type: 'Int' }] },
  },
  PullRequest: {
    id: { type: 'ID!' },
    number: { type: 'Int!' },
    title: { type: 'String!' },
    body: { type: 'String' },
    state: { type: 'PullRequestState!' },
    merged: { type: 'Boolean!' },
    mergedAt: { type: 'DateTime' },
    mergeCommit: { type: 'Commit' },
    headRefName: { type: 'String!' },
    baseRefName: { type: 'String!' },
    headRefOid: { type: 'GitObjectID!' },
    baseRefOid: { type: 'GitObjectID!' },
    mergeable: { type: 'MergeableState!' },
    url: { type: 'URI!' },
    author: { type: 'Actor' },
    repository: { type: 'Repository!' },
    createdAt: { type: 'DateTime!' },
    updatedAt: { type: 'DateTime!' },
    files: { type: 'PullRequestChangedFileConnection', args: [{ name: 'first', type: 'Int' }, { name: 'after', type: 'String' }] },
  },
  Ref: { id: { type: 'ID!' }, name: { type: 'String!' }, prefix: { type: 'String!' } },
  Commit: { id: { type: 'ID!' }, oid: { type: 'GitObjectID!' }, message: { type: 'String!' }, committedDate: { type: 'DateTime!' } },
  PageInfo: {
    hasNextPage: { type: 'Boolean!' },
    hasPreviousPage: { type: 'Boolean!' },
    startCursor: { type: 'String' },
    endCursor: { type: 'String' },
  },
  IssueConnection: {
    nodes: { type: '[Issue]' },
    edges: { type: '[IssueEdge]' },
    pageInfo: { type: 'PageInfo!' },
    totalCount: { type: 'Int!' },
  },
  IssueEdge: { node: { type: 'Issue' }, cursor: { type: 'String!' } },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]' },
    edges: { type: '[PullRequestEdge]' },
    pageInfo: { type: 'PageInfo!' },
    totalCount: { type: 'Int!' },
  },
  PullRequestEdge: { node: { type: 'PullRequest' }, cursor: { type: 'String!' } },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]' },
    edges: { type: '[PullRequestChangedFileEdge]' },
    pageInfo: { type: 'PageInfo!' },
    totalCount: { type: 'Int!' },
  },
  PullRequestChangedFileEdge: { node: { type: 'PullRequestChangedFile' }, cursor: { type: 'String!' } },
  PullRequestChangedFile: {
    path: { type: 'String!' },
    additions: { type: 'Int!' },
    deletions: { type: 'Int!' },
    changeType: { type: 'PatchStatus!' },
  },
  IssueCommentConnection: {
    nodes: { type: '[IssueComment]' },
    edges: { type: '[IssueCommentEdge]' },
    pageInfo: { type: 'PageInfo!' },
    totalCount: { type: 'Int!' },
  },
  IssueCommentEdge: { node: { type: 'IssueComment' }, cursor: { type: 'String!' } },
  IssueComment: {
    id: { type: 'ID!' },
    body: { type: 'String!' },
    author: { type: 'Actor' },
    createdAt: { type: 'DateTime!' },
    updatedAt: { type: 'DateTime!' },
    url: { type: 'URI!' },
  },
  Label: { id: { type: 'ID!' }, name: { type: 'String!' }, color: { type: 'String!' }, description: { type: 'String' } },
  LabelConnection: { nodes: { type: '[Label]' }, pageInfo: { type: 'PageInfo!' }, totalCount: { type: 'Int!' } },
  RateLimit: { limit: { type: 'Int!' }, remaining: { type: 'Int!' }, used: { type: 'Int!' }, resetAt: { type: 'DateTime!' } },
  CreateIssuePayload: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  CloseIssuePayload: { issue: { type: 'Issue' }, clientMutationId: { type: 'String' } },
  CreatePullRequestPayload: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  MergePullRequestPayload: { pullRequest: { type: 'PullRequest' }, clientMutationId: { type: 'String' } },
  AddCommentPayload: { commentEdge: { type: 'IssueCommentEdge' }, clientMutationId: { type: 'String' }, subject: { type: 'Node' } },
  __Type: {
    name: { type: 'String' },
    kind: { type: '__TypeKind!' },
    description: { type: 'String' },
    fields: { type: '[__Field!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
    enumValues: { type: '[__EnumValue!]', args: [{ name: 'includeDeprecated', type: 'Boolean' }] },
    possibleTypes: { type: '[__Type!]' },
    inputFields: { type: '[__InputValue!]' },
    ofType: { type: '__Type' },
    specifiedByURL: { type: 'String' },
  },
  __Field: {
    name: { type: 'String!' },
    description: { type: 'String' },
    args: { type: '[__InputValue!]!' },
    type: { type: '__Type!' },
    isDeprecated: { type: 'Boolean!' },
    deprecationReason: { type: 'String' },
  },
  __EnumValue: { name: { type: 'String!' }, description: { type: 'String' }, isDeprecated: { type: 'Boolean!' }, deprecationReason: { type: 'String' } },
  __InputValue: { name: { type: 'String!' }, description: { type: 'String' }, type: { type: '__Type!' }, defaultValue: { type: 'String' } },
  __Schema: {
    types: { type: '[__Type!]!' },
    queryType: { type: '__Type!' },
    mutationType: { type: '__Type' },
    subscriptionType: { type: '__Type' },
    directives: { type: '[__Directive!]!' },
  },
  __Directive: { name: { type: 'String!' }, description: { type: 'String' }, locations: { type: '[__DirectiveLocation!]!' }, args: { type: '[__InputValue!]!' } },
};

const ENUM_VALUES: Record<string, string[]> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['DISCUSSION', 'ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  PatchStatus: ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED'],
  __TypeKind: ['SCALAR', 'OBJECT', 'INTERFACE', 'UNION', 'ENUM', 'INPUT_OBJECT', 'LIST', 'NON_NULL'],
  __DirectiveLocation: ['QUERY', 'MUTATION', 'FIELD', 'FRAGMENT_DEFINITION', 'FRAGMENT_SPREAD', 'INLINE_FRAGMENT'],
};

const INPUT_FIELDS: Record<string, { name: string; type: string }[]> = {
  IssueOrder: [
    { name: 'field', type: 'IssueOrderField!' },
    { name: 'direction', type: 'OrderDirection!' },
  ],
  CreateIssueInput: [
    { name: 'repositoryId', type: 'ID!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
  ],
  CloseIssueInput: [{ name: 'issueId', type: 'ID!' }],
  CreatePullRequestInput: [
    { name: 'repositoryId', type: 'ID!' },
    { name: 'baseRefName', type: 'String!' },
    { name: 'headRefName', type: 'String!' },
    { name: 'title', type: 'String!' },
    { name: 'body', type: 'String' },
  ],
  MergePullRequestInput: [
    { name: 'pullRequestId', type: 'ID!' },
    { name: 'mergeMethod', type: 'PullRequestMergeMethod' },
  ],
  AddCommentInput: [
    { name: 'subjectId', type: 'ID!' },
    { name: 'body', type: 'String!' },
  ],
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime', 'GitObjectID', 'HTML']);
const INTERFACES: Record<string, string[]> = {
  Node: ['Repository', 'Issue', 'PullRequest', 'IssueComment', 'User', 'Label', 'Commit', 'Ref'],
  Actor: ['User'],
  RepositoryOwner: ['User'],
};

/** Parse a type reference string ('[Issue!]!') into nested __Type-shaped objects. */
function typeRef(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.endsWith('!')) return { __typename: '__Type', kind: 'NON_NULL', name: null, ofType: typeRef(trimmed.slice(0, -1)) };
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return { __typename: '__Type', kind: 'LIST', name: null, ofType: typeRef(trimmed.slice(1, -1)) };
  const kind = SCALARS.has(trimmed)
    ? 'SCALAR'
    : ENUM_VALUES[trimmed] !== undefined
      ? 'ENUM'
      : INPUT_FIELDS[trimmed] !== undefined
        ? 'INPUT_OBJECT'
        : INTERFACES[trimmed] !== undefined
          ? 'INTERFACE'
          : 'OBJECT';
  return { __typename: '__Type', kind, name: trimmed, ofType: null };
}

function introspectType(name: string): Record<string, unknown> | null {
  if (OBJECT_FIELDS[name] !== undefined) {
    return {
      __typename: '__Type',
      kind: INTERFACES[name] !== undefined ? 'INTERFACE' : 'OBJECT',
      name,
      description: null,
      fields: Object.entries(OBJECT_FIELDS[name]!).map(([fieldName, def]) => ({
        __typename: '__Field',
        name: fieldName,
        description: null,
        args: (def.args ?? []).map((arg) => ({ __typename: '__InputValue', name: arg.name, description: null, type: typeRef(arg.type), defaultValue: null })),
        type: typeRef(def.type),
        isDeprecated: false,
        deprecationReason: null,
      })),
      enumValues: null,
      possibleTypes: (INTERFACES[name] ?? []).map((typeName) => introspectType(typeName)),
      inputFields: null,
      ofType: null,
      specifiedByURL: null,
    };
  }
  if (ENUM_VALUES[name] !== undefined) {
    return {
      __typename: '__Type',
      kind: 'ENUM',
      name,
      description: null,
      fields: null,
      enumValues: ENUM_VALUES[name]!.map((value) => ({ __typename: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null })),
      possibleTypes: null,
      inputFields: null,
      ofType: null,
      specifiedByURL: null,
    };
  }
  if (INPUT_FIELDS[name] !== undefined) {
    return {
      __typename: '__Type',
      kind: 'INPUT_OBJECT',
      name,
      description: null,
      fields: null,
      enumValues: null,
      possibleTypes: null,
      inputFields: INPUT_FIELDS[name]!.map((field) => ({ __typename: '__InputValue', name: field.name, description: null, type: typeRef(field.type), defaultValue: null })),
      ofType: null,
      specifiedByURL: null,
    };
  }
  if (SCALARS.has(name)) {
    return { __typename: '__Type', kind: 'SCALAR', name, description: null, fields: null, enumValues: null, possibleTypes: null, inputFields: null, ofType: null, specifiedByURL: null };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// execution

interface Ctx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: SelectionNode[] }>;
  errors: { message: string }[];
}

type Source = Record<string, unknown> & { __typename: string };

function userSource(forge: Forge): Source {
  const login = forge.viewerLogin();
  return {
    __typename: 'User',
    id: globalId('User', login),
    login,
    name: login,
    url: `https://forge.invalid/${login}`,
    avatarUrl: `https://forge.invalid/avatars/${login}`,
  };
}

function repoSource(forge: Forge, repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(forge: Forge, repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(forge: Forge, repo: Repo, pull: Pull): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexForCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return -1;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

/** Slice one page out of a connection list and shape nodes/edges/pageInfo. */
function connection<T>(items: readonly T[], args: Map<string, unknown>, wrap: (item: T) => Source): Source {
  const first = typeof args.get('first') === 'number' ? (args.get('first') as number) : items.length;
  const start = indexForCursor(args.get('after')) + 1;
  const page = items.slice(start, start + Math.max(0, first));
  const nodes = page.map(wrap);
  const edges = page.map((item, offset) => ({ __typename: 'Edge', node: wrap(item), cursor: cursorFor(start + offset) }));
  return {
    __typename: 'Connection',
    nodes,
    edges,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor: page.length > 0 ? cursorFor(start + page.length - 1) : null,
    },
    totalCount: items.length,
  };
}

function resolveField(ctx: Ctx, source: Source, field: FieldNode): unknown {
  const { forge } = ctx;
  const typename = source.__typename;
  const name = field.name;
  const args = new Map<string, unknown>();
  for (const [key, value] of field.args) args.set(key, resolveValue(value, ctx.variables));

  if (name === '__typename') return typename;
  if (name === '__type') return introspectType(String(args.get('name') ?? ''));
  if (name === '__schema') {
    return {
      __typename: '__Schema',
      types: Object.keys({ ...OBJECT_FIELDS, ...ENUM_VALUES, ...INPUT_FIELDS }).map((typeName) => introspectType(typeName)),
      queryType: introspectType('Query'),
      mutationType: introspectType('Mutation'),
      subscriptionType: null,
      directives: [],
    };
  }

  const known = OBJECT_FIELDS[typename === 'Connection' ? 'IssueConnection' : typename];
  if (known !== undefined && !(name in known) && source[name] === undefined) {
    ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typename}'` });
    return null;
  }

  switch (typename) {
    case 'Query': {
      if (name === 'viewer') return userSource(forge);
      if (name === 'repository') {
        const repo = forge.repoForOwner(String(args.get('owner') ?? ''), String(args.get('name') ?? ''));
        return repo === null ? null : repoSource(forge, repo);
      }
      if (name === 'node') return resolveNode(ctx, String(args.get('id') ?? ''));
      if (name === 'rateLimit') return { __typename: 'RateLimit', limit: 5000, remaining: 5000, used: 0, resetAt: forge.clock.peekIso() };
      return null;
    }
    case 'Mutation':
      return resolveMutation(ctx, name, args);
    case 'User':
      return source[name] ?? null;
    case 'Repository': {
      const repo = source.repo as Repo;
      const json = repoJson(forge, repo);
      switch (name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return json.full_name;
        case 'owner':
          return userSource(forge);
        case 'defaultBranchRef': {
          const tip = repo.refs.get(forge.headRef(repo));
          if (tip === undefined) return null;
          return { __typename: 'Ref', id: globalId('Ref', repo.id, repo.defaultBranch), name: repo.defaultBranch, prefix: 'refs/heads/' };
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description === '' ? null : repo.description;
        case 'isPrivate':
          return repo.isPrivate;
        case 'url':
          return json.html_url;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'issue': {
          const issue = repo.issues.get(Number(args.get('number')));
          return issue === undefined ? null : issueSource(forge, repo, issue);
        }
        case 'issues': {
          let list = [...repo.issues.values()];
          const states = args.get('states');
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state).toLowerCase()));
            list = list.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = args.get('orderBy') as { direction?: string } | undefined;
          const ascending = orderBy?.direction === 'ASC';
          list.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
          return connection(list, args, (issue) => issueSource(forge, repo, issue));
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.get('number')));
          return pull === undefined ? null : pullSource(forge, repo, pull);
        }
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const states = args.get('states');
          if (Array.isArray(states) && states.length > 0) {
            const wanted = new Set(states.map((state) => String(state)));
            list = list.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          }
          const orderBy = args.get('orderBy') as { direction?: string } | undefined;
          const ascending = orderBy?.direction === 'ASC';
          list.sort((a, b) => (ascending ? a.number - b.number : b.number - a.number));
          return connection(list, args, (pull) => pullSource(forge, repo, pull));
        }
        default:
          return null;
      }
    }
    case 'Issue': {
      const repo = source.repo as Repo;
      const issue = source.issue as Issue;
      switch (name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
        case 'url':
          return issueJson(forge, repo, issue).html_url;
        case 'author':
          return userSource(forge);
        case 'repository':
          return repoSource(forge, repo);
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'comments':
          return connection(issue.comments, args, (comment) => commentSource(forge, repo, issue, comment.id));
        case 'labels': {
          const labels = issue.labels.map((labelName) => ({
            __typename: 'Label',
            id: globalId('Label', repo.id, labelName),
            name: labelName,
            color: repo.labels.get(labelName)?.color ?? '000000',
            description: repo.labels.get(labelName)?.description ?? null,
          }));
          return connection(labels, args, (label) => label as Source);
        }
        default:
          return null;
      }
    }
    case 'PullRequest': {
      const repo = source.repo as Repo;
      const pull = source.pull as Pull;
      switch (name) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommit':
          return pull.mergeCommitSha === null
            ? null
            : { __typename: 'Commit', id: globalId('Commit', pull.mergeCommitSha), oid: pull.mergeCommitSha, message: pull.title, committedDate: pull.mergedAt ?? pull.updatedAt };
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRefOid':
          return repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
        case 'baseRefOid':
          return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
        case 'mergeable':
          return forge.pullMergeable(repo, pull);
        case 'url':
          return pullJson(forge, repo, pull).html_url;
        case 'author':
          return userSource(forge);
        case 'repository':
          return repoSource(forge, repo);
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'files': {
          const files = forge.pullFiles(repo, pull).map((change) => ({
            __typename: 'PullRequestChangedFile',
            path: change.filename,
            additions: change.additions,
            deletions: change.deletions,
            changeType: change.status === 'added' ? 'ADDED' : change.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          return connection(files, args, (file) => file as Source);
        }
        default:
          return null;
      }
    }
    case 'Connection': {
      if (name === 'nodes') return source.nodes;
      if (name === 'edges') return source.edges;
      if (name === 'pageInfo') return source.pageInfo;
      if (name === 'totalCount') return source.totalCount;
      return null;
    }
    default: {
      const value = source[name];
      return value === undefined ? null : value;
    }
  }
}

function commentSource(forge: Forge, repo: Repo, issue: Issue, commentId: number): Source {
  const comment = issue.comments.find((candidate) => candidate.id === commentId);
  return {
    __typename: 'IssueComment',
    id: globalId('IssueComment', repo.id, issue.number, commentId),
    body: comment?.body ?? '',
    author: userSource(forge),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://forge.invalid/${forge.ownerOf(repo)}/${repo.name}/issues/${issue.number}#issuecomment-${commentId}`,
  };
}

function resolveNode(ctx: Ctx, id: string): Source | null {
  const { forge } = ctx;
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  const repoId = Number(parsed.parts[0]);
  switch (parsed.kind) {
    case 'Repository': {
      const repo = forge.repoById(repoId);
      return repo === undefined ? null : repoSource(forge, repo);
    }
    case 'Issue': {
      const repo = forge.repoById(repoId);
      const issue = repo?.issues.get(Number(parsed.parts[1]));
      return repo === undefined || issue === undefined ? null : issueSource(forge, repo, issue);
    }
    case 'PullRequest': {
      const repo = forge.repoById(repoId);
      const pull = repo?.pulls.get(Number(parsed.parts[1]));
      return repo === undefined || pull === undefined ? null : pullSource(forge, repo, pull);
    }
    case 'IssueComment': {
      const repo = forge.repoById(repoId);
      const issue = repo?.issues.get(Number(parsed.parts[1]));
      if (repo === undefined || issue === undefined) return null;
      return commentSource(forge, repo, issue, Number(parsed.parts[2]));
    }
    case 'User':
      return userSource(forge);
    default:
      return null;
  }
}

function resolveMutation(ctx: Ctx, name: string, args: Map<string, unknown>): Source | null {
  const { forge } = ctx;
  const input = (args.get('input') ?? {}) as Record<string, unknown>;
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (name) {
    case 'createIssue': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'Repository' ? forge.repoById(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve repository' });
        return { __typename: 'CreateIssuePayload', issue: null, clientMutationId };
      }
      const issue = forge.createIssue(repo, { title: String(input.title ?? ''), body: typeof input.body === 'string' ? input.body : '' });
      if (issue === 'bad-label') {
        ctx.errors.push({ message: 'Validation failed' });
        return { __typename: 'CreateIssuePayload', issue: null, clientMutationId };
      }
      return { __typename: 'CreateIssuePayload', issue: issueSource(forge, repo, issue), clientMutationId };
    }
    case 'closeIssue': {
      const node = resolveNode(ctx, String(input.issueId ?? ''));
      if (node === null || node.__typename !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve issue' });
        return { __typename: 'CloseIssuePayload', issue: null, clientMutationId };
      }
      const issue = node.issue as Issue;
      issue.state = 'closed';
      issue.updatedAt = forge.clock.peekIso();
      return { __typename: 'CloseIssuePayload', issue: node, clientMutationId };
    }
    case 'createPullRequest': {
      const parsed = parseGlobalId(String(input.repositoryId ?? ''));
      const repo = parsed !== null && parsed.kind === 'Repository' ? forge.repoById(Number(parsed.parts[0])) : undefined;
      if (repo === undefined) {
        ctx.errors.push({ message: 'Could not resolve repository' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId };
      }
      const pull = forge.createPull(repo, {
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (pull === 'invalid') {
        ctx.errors.push({ message: 'Head or base ref is invalid' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(forge, repo, pull), clientMutationId };
    }
    case 'mergePullRequest': {
      const node = resolveNode(ctx, String(input.pullRequestId ?? ''));
      if (node === null || node.__typename !== 'PullRequest') {
        ctx.errors.push({ message: 'Could not resolve pull request' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId };
      }
      const repo = node.repo as Repo;
      const pull = node.pull as Pull;
      const method = String(input.mergeMethod ?? 'MERGE').toUpperCase();
      const result = forge.mergePull(repo, pull, method === 'MERGE' ? 'merge' : 'squash');
      if (result === 'conflict') ctx.errors.push({ message: 'Pull request is not mergeable' });
      else if (result === 'not-open') ctx.errors.push({ message: 'Pull request is not open' });
      return { __typename: 'MergePullRequestPayload', pullRequest: node, clientMutationId };
    }
    case 'addComment': {
      const node = resolveNode(ctx, String(input.subjectId ?? ''));
      if (node === null || node.__typename !== 'Issue') {
        ctx.errors.push({ message: 'Could not resolve subject' });
        return { __typename: 'AddCommentPayload', commentEdge: null, clientMutationId, subject: null };
      }
      const repo = node.repo as Repo;
      const issue = node.issue as Issue;
      const comment = forge.addComment(repo, issue, String(input.body ?? ''));
      return {
        __typename: 'AddCommentPayload',
        commentEdge: { __typename: 'Edge', node: commentSource(forge, repo, issue, comment.id), cursor: cursorFor(issue.comments.length - 1) },
        clientMutationId,
        subject: node,
      };
    }
    default:
      return null;
  }
}

/** Flatten a selection set against a runtime type, expanding fragments whose condition matches. */
function collectFields(ctx: Ctx, typename: string, selections: SelectionNode[], into: Map<string, FieldNode>): void {
  for (const selection of selections) {
    if (selection.kind === 'field') {
      into.set(selection.alias ?? selection.name, selection);
    } else if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === typename || (INTERFACES[selection.typeCondition] ?? []).includes(typename)) {
        collectFields(ctx, typename, selection.selectionSet, into);
      }
    } else {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typename || (INTERFACES[fragment.typeCondition] ?? []).includes(typename))) {
        collectFields(ctx, typename, fragment.selectionSet, into);
      }
    }
  }
}

function executeSelectionSet(ctx: Ctx, source: Source, selections: SelectionNode[]): Record<string, unknown> {
  const fields = new Map<string, FieldNode>();
  collectFields(ctx, source.__typename, selections, fields);
  const out: Record<string, unknown> = {};
  for (const [responseKey, field] of fields) {
    const value = resolveField(ctx, source, field);
    out[responseKey] = completeValue(ctx, value, field);
  }
  return out;
}

function completeValue(ctx: Ctx, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object' && field.selectionSet !== undefined) {
    const source = value as Source;
    if (typeof source.__typename === 'string') return executeSelectionSet(ctx, source, field.selectionSet);
    return value;
  }
  return value;
}

/** Execute one GraphQL operation document; answers the {data, errors?} envelope. */
export function executeGraphql(forge: Forge, query: string, variables: Record<string, unknown>, operationName?: string): { data: Record<string, unknown> | null; errors?: { message: string }[] } {
  let document: DocumentNode;
  try {
    document = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'syntax error' }] };
  }
  const operation =
    document.operations.find((candidate) => operationName === undefined || candidate.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation found' }] };
  const mergedVariables: Record<string, unknown> = {};
  for (const [name, defaultNode] of operation.variableDefaults) mergedVariables[name] = resolveValue(defaultNode, {});
  Object.assign(mergedVariables, variables);
  const ctx: Ctx = { forge, variables: mergedVariables, fragments: document.fragments, errors: [] };
  const root: Source = { __typename: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelectionSet(ctx, root, operation.selectionSet);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}
