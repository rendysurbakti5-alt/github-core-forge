// The JSON shapes the REST surface answers with, shared with the MCP tools so an object
// created on one surface reads identically on the other.

import { globalId, type Forge, type Issue, type IssueComment, type Label, type Pull, type Repo } from './forge.ts';
import { ZERO_OID } from './util.ts';

export function userJson(forge: Forge): Record<string, unknown> {
  const login = forge.viewerLogin();
  return { login, id: 1, node_id: globalId('User', login), type: 'User', site_admin: false };
}

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  const owner = forge.ownerOf(repo);
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.isPrivate,
    owner: { login: owner, id: 1, node_id: globalId('User', owner), type: 'User' },
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://forge.invalid/${owner}/${repo.name}`,
    clone_url: `https://forge.invalid/${owner}/${repo.name}.git`,
    git_url: `git://forge.invalid/${owner}/${repo.name}.git`,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: repo.objects.size,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color, description: label.description, default: false };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = forge.ownerOf(repo);
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: '000000', description: null })),
    user: { login: owner, id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: null,
    html_url: `https://forge.invalid/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `https://forge.invalid/api/v3/repos/${owner}/${repo.name}`,
  };
}

export function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: IssueComment): Record<string, unknown> {
  const owner = forge.ownerOf(repo);
  return {
    id: comment.id,
    node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
    body: comment.body,
    user: { login: owner, id: 1, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    html_url: `https://forge.invalid/${owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = forge.ownerOf(repo);
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    user: { login: owner, id: 1, type: 'User' },
    head: { ref: pull.headRef, sha: headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    html_url: `https://forge.invalid/${owner}/${repo.name}/pull/${pull.number}`,
  };
}
