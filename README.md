# makefun-forge

A GitHub-compatible git forge in a single Node.js process, built for the make.fun
**github-core-clone-01** competition. It serves four surfaces over one shared in-memory
store, so an object created through any of them is the same object everywhere else:

- **Git smart HTTP** — protocol v2 advertisements, `ls-refs`, and `fetch` (with
  shallow/deepen negotiation), plus protocol v0 advertisements, two-part v0 fetch, and
  `git-receive-pack` with `report-status` over side-band-64k. Packfiles are built and
  parsed by the forge's own git engine (`git.ts`): object hashing, tree/commit/tag
  codecs, three-way tree merges, LCS line diffs, and pack read/write with full
  OFS/REF delta resolution.
- **REST** (`/api/v3`) — repositories (create/list/get/patch/delete with `Link`-header
  pagination), branches and git refs, commit listings, the contents API (create, read,
  update, delete files and directories, including the first commit of an unborn
  repository), labels, issues and comments, and pull requests (list, files diff, squash
  or merge). Issues and pull requests share one number sequence per repository.
- **GraphQL** (`/api/graphql`) — a small purpose-built engine: viewer, repository,
  `node(id:)` with opaque stable global ids, issue/pull-request cursor connections,
  the `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment` mutations, batched operations, and `__type` introspection with
  GitHub-style unknown-field errors.
- **MCP** (`/mcp`) — JSON-RPC 2.0 with the modern `server/discover` handshake (and
  `initialize` for legacy clients) and six tools: `create_repo`, `get_repo`,
  `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`.

## Design notes

- **One user, learned login.** The forge serves the bearer token's account. The token
  is opaque, so the account login is learned from the first owner-named route the
  client drives (`/{owner}/{repo}.git/...` or `/repos/{owner}/...`); repositories
  answer only under their owner's name — any other owner is a 404, never a 403.
- **In-memory store.** The grading pod mounts the source read-only and allows writes
  only under `/tmp`, and each trial is a fresh world, so repositories, objects, refs,
  issues and pull requests all live in process memory (`forge.ts`). Nothing shells out
  to a `git` binary; the wire protocol and object model are implemented directly.
- **Deterministic clock.** When the harness sets `MAKEFUN_TRIAL_NOW`, every timestamp
  the forge emits (commit author/committer times, `created_at`, `merged_at`) derives
  from it through a tick counter, so a live run and its replay produce identical bytes.
- **Auth.** Every surface except `GET /healthz` requires
  `Authorization: Bearer <$MAKEFUN_SHOP_TOKEN>`.

## Files

| File           | Role                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `main.ts`      | Lifecycle: bind an ephemeral port, register with the env service, serve until `/done`. |
| `app.ts`       | HTTP routing, auth, the REST API, git route wiring.                  |
| `forge.ts`     | The store and domain logic: repos, objects, refs, contents commits, issues, pulls, merges, global ids. |
| `git.ts`       | The git engine: hashing, object codecs, reachability, merges, diffs, pack read/write. |
| `gitserver.ts` | Smart-HTTP protocol: advertisements, ls-refs, fetch planning, receive-pack. |
| `graphql.ts`   | The GraphQL engine and schema.                                       |
| `mcp.ts`       | The MCP (JSON-RPC) endpoint and its six tools.                       |
| `serializers.ts` | The REST JSON shapes, shared with MCP.                             |
| `util.ts`      | pkt-line codec, base64, the deterministic trial clock.               |

## Running

The suite harness runs the entry itself:

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:<env-port> \
MAKEFUN_SHOP_TOKEN=<token> \
node main.ts
```

`main.ts` listens on an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`,
serves until `GET $MAKEFUN_ENV_URL/done` reports `{"done": true}`, then exits 0.
For a manual smoke test, point the same variables at any stub env service and drive
`GET /healthz`, the REST API, or a real `git clone http://127.0.0.1:<port>/<you>/<repo>.git`
with the token as the bearer credential.
