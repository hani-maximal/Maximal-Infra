import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

// ── Auth helpers ──────────────────────────────────────────────────────────────

function buildGitHubAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId })).toString("base64url");
  const unsigned = `${header}.${payload}`;
  const sig = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${sig}`;
}

async function getInstallationToken(appId: string, privateKey: string, installationId: string): Promise<string> {
  const jwt = buildGitHubAppJwt(appId, privateKey);
  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    { method: "POST", headers: { Authorization: `Bearer ${jwt}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } }
  );
  if (!res.ok) throw new Error(`GitHub App token exchange failed: ${res.status}`);
  const data = await res.json() as { token: string };
  return data.token;
}

async function resolveToken(): Promise<string> {
  const pat = process.env.GITHUB_TOKEN;
  if (pat) return pat;

  const appId = process.env.GITHUB_APP_ID;
  const keyPath = process.env.GITHUB_PRIVATE_KEY_PATH;
  const privateKey = keyPath
    ? readFileSync(keyPath, "utf8")
    : process.env.GITHUB_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  if (appId && privateKey && installationId) {
    return getInstallationToken(appId, privateKey, installationId);
  }
  throw new Error("GitHub credentials not configured (set GITHUB_TOKEN or GITHUB_APP_ID + GITHUB_PRIVATE_KEY + GITHUB_INSTALLATION_ID)");
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export interface GitHubFileState {
  content: string;
  sha: string;
  path: string;
}

export interface GitHubPrState {
  pullNumber: number;
  repo: string;
}

export interface GitHubAdapterInterface {
  getFileContent(repo: string, filePath: string, ref: string): Promise<GitHubFileState>;
  createBranch(repo: string, branchName: string, fromSha: string): Promise<void>;
  commitFile(repo: string, filePath: string, content: string, message: string, branch: string, existingSha: string): Promise<void>;
  createPr(repo: string, title: string, body: string, head: string, base: string): Promise<GitHubPrState>;
  closePr(repo: string, pullNumber: number): Promise<void>;
}

async function ghFetch(path: string, init: RequestInit): Promise<Response> {
  const token = await resolveToken();
  return fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string> ?? {}),
    },
  });
}

export class GitHubAdapter implements GitHubAdapterInterface {
  async getFileContent(repo: string, filePath: string, ref: string): Promise<GitHubFileState> {
    const res = await ghFetch(`/repos/${repo}/contents/${filePath}?ref=${encodeURIComponent(ref)}`, { method: "GET" });
    if (!res.ok) throw new Error(`GitHub get file failed: ${res.status} ${repo}/${filePath}@${ref}`);
    const data = await res.json() as { content: string; sha: string; path: string };
    return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha, path: data.path };
  }

  async createBranch(repo: string, branchName: string, fromSha: string): Promise<void> {
    const res = await ghFetch(`/repos/${repo}/git/refs`, {
      method: "POST",
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha: fromSha }),
    });
    if (!res.ok) throw new Error(`GitHub create branch failed: ${res.status} ${branchName}`);
  }

  async commitFile(repo: string, filePath: string, content: string, message: string, branch: string, existingSha: string): Promise<void> {
    const res = await ghFetch(`/repos/${repo}/contents/${filePath}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
        sha: existingSha,
        branch,
      }),
    });
    if (!res.ok) throw new Error(`GitHub commit file failed: ${res.status} ${filePath}`);
  }

  async createPr(repo: string, title: string, body: string, head: string, base: string): Promise<GitHubPrState> {
    const res = await ghFetch(`/repos/${repo}/pulls`, {
      method: "POST",
      body: JSON.stringify({ title, body, head, base }),
    });
    if (!res.ok) throw new Error(`GitHub create PR failed: ${res.status}`);
    const data = await res.json() as { number: number };
    return { pullNumber: data.number, repo };
  }

  async closePr(repo: string, pullNumber: number): Promise<void> {
    const res = await ghFetch(`/repos/${repo}/pulls/${pullNumber}`, {
      method: "PATCH",
      body: JSON.stringify({ state: "closed" }),
    });
    if (!res.ok) throw new Error(`GitHub close PR failed: ${res.status} #${pullNumber}`);
  }
}

// Null adapter for environments without GitHub credentials (dry-run / tests)
export class NullGitHubAdapter implements GitHubAdapterInterface {
  async getFileContent(_repo: string, filePath: string, _ref: string): Promise<GitHubFileState> {
    return { content: "# placeholder\n", sha: "0000000000000000000000000000000000000000", path: filePath };
  }
  async createBranch(): Promise<void> {}
  async commitFile(): Promise<void> {}
  async createPr(repo: string, _title: string, _body: string, head: string, base: string): Promise<GitHubPrState> {
    return { pullNumber: 0, repo };
  }
  async closePr(): Promise<void> {}
}

export function getGitHubAdapter(): GitHubAdapterInterface | null {
  const hasToken = Boolean(process.env.GITHUB_TOKEN);
  const hasKey = Boolean(process.env.GITHUB_PRIVATE_KEY || process.env.GITHUB_PRIVATE_KEY_PATH);
  const hasApp = Boolean(process.env.GITHUB_APP_ID && hasKey && process.env.GITHUB_INSTALLATION_ID);
  if (!hasToken && !hasApp) return null;
  return new GitHubAdapter();
}
