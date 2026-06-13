import { useState, useRef, useMemo, useEffect } from "react";

const STEPS = ["provider", "project", "branches", "security", "review", "done"];

const LABEL = {
  provider: "Provider",
  project: "Project details",
  branches: "Branch strategy",
  security: "Security & policies",
  review: "Review & create",
  done: "Done",
};

const BRANCH_PRESETS = [
  { id: "gitflow", name: "GitFlow", branches: ["main", "develop", "staging"], desc: "Classic promotion: develop → staging → main" },
  { id: "trunk", name: "Trunk-based", branches: ["main", "staging"], desc: "Short-lived feature branches, fast merges" },
  { id: "envbased", name: "Env-based", branches: ["main", "staging", "dev"], desc: "One branch per environment" },
];

// ── LLM provider abstraction: works with both Anthropic and OpenAI ───────────
const LLM_PROVIDERS = {
  anthropic: {
    name: "Anthropic · Claude",
    icon: "ti-sparkles",
    keyPlaceholder: "sk-ant-...",
    keyHint: "Used only in this session. Never stored or logged.",
    models: ["claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
  },
  openai: {
    name: "OpenAI · ChatGPT",
    icon: "ti-robot",
    keyPlaceholder: "sk-...",
    keyHint: "Used only in this session. Never stored or logged.",
    models: ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"],
  },
};

// `weight` feeds the security posture score (sums to 100). `rec` marks the
// baseline every IaC repo should ship with. `requires` encodes real dependencies.
const SECURITY_OPTIONS = [
  { id: "branch_protection", label: "Branch protection rules", desc: "Status checks + PR reviews required", default: true, weight: 18, rec: true },
  { id: "secret_scanning", label: "Secret scanning + push protection", desc: "Block commits containing credentials", default: true, weight: 16, rec: true },
  { id: "checkov", label: "Checkov / policy-as-code", desc: "Static analysis CI step (misconfigs, CIS)", default: true, weight: 12, rec: true },
  { id: "remote_state", label: "Remote encrypted state + locking", desc: "S3+DynamoDB / GCS backend, no local state", default: true, weight: 12, rec: true },
  { id: "oidc_auth", label: "Keyless CI auth (OIDC)", desc: "Short-lived cloud creds, no static secrets", default: true, weight: 10, rec: true },
  { id: "codeowners", label: "CODEOWNERS file", desc: "Require team review on infra paths", default: true, weight: 8, rec: true, requires: ["branch_protection"] },
  { id: "signed_commits", label: "Require signed commits", desc: "GPG / SSH commit signing enforced", default: false, weight: 8, requires: ["branch_protection"] },
  { id: "dependabot", label: "Dependency / provider update alerts", desc: "Auto-PRs for provider version updates", default: true, weight: 6 },
  { id: "tflint", label: "tflint linting", desc: "Terraform style and best-practice linting", default: true, weight: 5, rec: true },
  { id: "pr_template", label: "PR template", desc: "Checklist for every infrastructure change", default: true, weight: 5, rec: true },
];

const OPT_BY_ID = Object.fromEntries(SECURITY_OPTIONS.map(o => [o.id, o]));

const SEVERITY = {
  critical: { color: "coral", icon: "ti-alert-octagon", rank: 5 },
  high:     { color: "coral", icon: "ti-alert-triangle", rank: 4 },
  medium:   { color: "amber", icon: "ti-alert-triangle", rank: 3 },
  low:      { color: "blue",  icon: "ti-info-circle", rank: 2 },
  info:     { color: "purple", icon: "ti-info-circle", rank: 1 },
};

const CREATE_SYSTEM = `You are an IaC repository setup assistant. Given a repository configuration, generate a JSON plan describing exactly what steps would be taken to create and configure the repo. Be specific and realistic. Output ONLY valid JSON, no prose, no markdown fences.

JSON shape:
{
  "steps": [ { "action": "string", "status": "ok|warn|info", "detail": "optional" } ],
  "files_created": ["list of files/dirs"],
  "summary": "one sentence summary",
  "repo_url": "https://{provider}.com/{org}/{repo}",
  "warnings": ["important warnings about the config"]
}`;

const AUDIT_SYSTEM = `You are a senior platform-engineering and DevSecOps reviewer. Audit the given repository configuration against current best practices for the specified Git provider (GitHub or GitLab) AND for Infrastructure-as-Code (Terraform/OpenTofu). Consider: branch protection & required reviews, CODEOWNERS coverage, secret scanning & push protection, signed commits, least-privilege CI auth (prefer OIDC over long-lived tokens), remote encrypted state with locking, module/provider version pinning, drift detection, policy-as-code (Checkov/OPA), linting, and resource tagging. Output ONLY valid JSON, no prose, no markdown fences.

JSON shape:
{
  "score": 0-100,
  "summary": "one sentence overall assessment",
  "findings": [
    { "severity": "critical|high|medium|low|info", "area": "github|gitlab|iac|security|ci", "title": "short title", "detail": "what's wrong or risky", "recommendation": "concrete fix" }
  ]
}
Order findings most-severe first. Be concrete and reference the actual config.`;

// ── pure helpers ─────────────────────────────────────────────────────────────
function slugify(raw) {
  return raw.toLowerCase().trim()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
}

function validateRepoName(raw) {
  const slug = slugify(raw);
  if (!raw.trim()) return { slug, ok: false, msg: "Repository name is required." };
  if (slug.length < 2) return { slug, ok: false, msg: "Name must be at least 2 characters." };
  if (slug.length > 100) return { slug, ok: false, msg: "Name must be 100 characters or fewer." };
  if (slug !== raw) return { slug, ok: true, msg: `Will be created as: ${slug}` };
  return { slug, ok: true, msg: "" };
}

function postureScore(security) {
  const got = SECURITY_OPTIONS.reduce((s, o) => s + (security[o.id] ? o.weight : 0), 0);
  let label = "Basic", color = "amber";
  if (got >= 75) { label = "Hardened"; color = "green"; }
  else if (got >= 40) { label = "Good"; color = "blue"; }
  return { score: got, label, color };
}

const SECRET_RE = /\b(ghp_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

function looksLikeSecret(text) {
  return SECRET_RE.test(text || "");
}

function configWarnings({ security, protectedBranches, visibility, description, projectName }) {
  const w = [];
  for (const o of SECURITY_OPTIONS) {
    if (!security[o.id] || !o.requires) continue;
    for (const dep of o.requires) if (!security[dep]) w.push(`"${o.label}" needs "${OPT_BY_ID[dep].label}" to take effect.`);
  }
  if (!protectedBranches.includes("main")) w.push("`main` is not protected — anyone could force-push to it.");
  if (visibility === "public" && !security.secret_scanning) w.push("Public repo without secret scanning risks leaking credentials.");
  if (!security.branch_protection) w.push("Branch protection is off — PR reviews and status checks won't be enforced.");
  if (!security.remote_state) w.push("No remote state backend — local state risks secret leakage and lost locking.");
  if (!security.oidc_auth) w.push("No OIDC keyless auth — CI will rely on long-lived cloud credentials.");
  if (looksLikeSecret(description) || looksLikeSecret(projectName)) w.push("A field appears to contain a secret/credential — remove it before creating.");
  return w;
}

function plannedFiles({ allBranches, security }) {
  const files = [
    "README.md",
    ".gitignore",
    ".terraformignore",
    "terraform/main.tf",
    "terraform/versions.tf",
  ];
  for (const b of allBranches) if (b !== "main") files.push(`environments/${b}/`);
  if (security.remote_state) files.push("terraform/backend.tf");
  if (security.codeowners) files.push(".github/CODEOWNERS");
  if (security.pr_template) files.push(".github/pull_request_template.md");
  if (security.dependabot) files.push(".github/dependabot.yml");
  if (security.checkov) files.push(".checkov.yaml", ".github/workflows/checkov.yml");
  if (security.tflint) files.push(".tflint.hcl", ".github/workflows/tflint.yml");
  if (security.branch_protection) files.push(".github/workflows/terraform-plan.yml");
  return [...new Set(files)];
}

function extractJson(raw) {
  const clean = (raw || "").replace(/```json|```/g, "").trim();
  const match = clean.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : clean);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── file scaffolding templates ───────────────────────────────────────────────
function ghWorkflow(name, body) {
  return `name: ${name}\n\non:\n  pull_request:\n  push:\n    branches: [ main ]\n\njobs:\n${body}`;
}

function fileContent(path, ctx) {
  const { name, description, owner } = ctx;
  switch (path) {
    case "README.md":
      return `# ${name}\n\n${description || "Infrastructure-as-code repository."}\n\nManaged with Terraform/OpenTofu. Scaffolded by the IaC Repository Configurator.\n`;
    case ".gitignore":
      return `# ── Terraform / OpenTofu ──────────────────────────────────────────────
.terraform/
*.tfstate
*.tfstate.*
crash.log
crash.*.log
*.tfvars
!example.tfvars
!*.auto.tfvars.example
override.tf
override.tf.json
*_override.tf
*_override.tf.json
.terraformrc
terraform.rc

# ── Secrets & credentials (never commit) ─────────────────────────────────────
.env
.env.*
!.env.example
*.pem
*.key
*.p12
*.pfx
secrets/
credentials/
*.secrets

# ── OS & editor ──────────────────────────────────────────────────────────────
.DS_Store
Thumbs.db
.idea/
.vscode/
*.swp
*.swo
*~

# ── Logs, cache & temp ───────────────────────────────────────────────────────
*.log
tmp/
.tmp/
.cache/

# ── Scan / test artifacts ────────────────────────────────────────────────────
.checkov.baseline
coverage/
*.test
`;
    case ".terraformignore":
      return `# Excluded from terraform init/plan module uploads
.git/
.github/
*.md
.env
.env.*
*.log
tmp/
`;
    case "terraform/main.tf":
      return `# Root module — extend via your IaC generation API\n`;
    case "terraform/versions.tf":
      return `terraform {\n  required_version = ">= 1.6.0"\n  required_providers {\n    # pin your providers here, e.g.\n    # aws = { source = "hashicorp/aws", version = "~> 5.0" }\n  }\n}\n`;
    case "terraform/backend.tf":
      return `terraform {\n  backend "s3" {\n    # bucket         = "my-tf-state"\n    # key            = "${name}/terraform.tfstate"\n    # region         = "us-east-1"\n    # dynamodb_table = "tf-locks"\n    # encrypt        = true\n  }\n}\n`;
    case ".github/CODEOWNERS":
      return `# Require review on infrastructure changes\n*            @${owner}\n/terraform/  @${owner}\n`;
    case ".github/pull_request_template.md":
      return `## What changed\n\n## Why\n\n## Checklist\n- [ ] \`terraform plan\` reviewed\n- [ ] No secrets committed\n- [ ] Checkov / tflint pass\n- [ ] Docs updated\n`;
    case ".github/dependabot.yml":
      return `version: 2\nupdates:\n  - package-ecosystem: "terraform"\n    directory: "/terraform"\n    schedule: { interval: "weekly" }\n  - package-ecosystem: "github-actions"\n    directory: "/"\n    schedule: { interval: "weekly" }\n`;
    case ".checkov.yaml":
      return `framework:\n  - terraform\nsoft-fail: false\n`;
    case ".tflint.hcl":
      return `plugin "terraform" {\n  enabled = true\n  preset  = "recommended"\n}\n`;
    case ".github/workflows/checkov.yml":
      return ghWorkflow("Checkov", `  checkov:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: bridgecrewio/checkov-action@v12\n        with:\n          directory: terraform\n`);
    case ".github/workflows/tflint.yml":
      return ghWorkflow("tflint", `  tflint:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - uses: terraform-linters/setup-tflint@v4\n      - run: tflint --chdir=terraform\n`);
    case ".github/workflows/terraform-plan.yml":
      return ghWorkflow("Terraform Plan", `  plan:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n      - uses: actions/checkout@v4\n      - uses: hashicorp/setup-terraform@v3\n      - run: terraform -chdir=terraform init -backend=false\n      - run: terraform -chdir=terraform plan\n`);
    default:
      return `# ${path}\n`;
  }
}

// Turn the planned-file list into concrete {path, content} blobs. Empty
// directories get a .gitkeep since git can't track empty folders.
function treeEntries(fileList, ctx) {
  const filesOnly = fileList.filter(f => !f.endsWith("/"));
  const out = filesOnly.map(f => ({ path: f, content: fileContent(f, ctx) }));
  for (const dir of fileList.filter(f => f.endsWith("/"))) {
    if (!filesOnly.some(f => f.startsWith(dir))) out.push({ path: `${dir}.gitkeep`, content: "" });
  }
  return out;
}

// ── GitHub REST ──────────────────────────────────────────────────────────────
function ghFetch(path, token, opts = {}) {
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
}

async function ghErr(res) {
  try { const j = await res.json(); return `${res.status} ${j.message || res.statusText}`.trim(); }
  catch { return `${res.status} ${res.statusText}`; }
}

const DEPENDABOT_BRANCH_RE = /^dependabot\//i;

function branchRefPath(name) {
  return name.split("/").map(encodeURIComponent).join("/");
}

async function deleteGithubBranches(owner, slug, token, names, log, signal) {
  for (const name of names) {
    const r = await ghFetch(`/repos/${owner}/${slug}/git/refs/heads/${branchRefPath(name)}`, token, { method: "DELETE", signal });
    log(r.ok || r.status === 404 ? `✓ Removed branch ${name}` : `⚠ Could not remove ${name} — ${await ghErr(r)}`);
  }
}

async function cleanupDependabotBranchesGithub(owner, slug, token, keepBranches, log, signal) {
  const keep = new Set(keepBranches);
  const r = await ghFetch(`/repos/${owner}/${slug}/branches?per_page=100`, token, { signal });
  if (!r.ok) { log(`⚠ Could not list branches for cleanup — ${await ghErr(r)}`); return; }
  const toDelete = (await r.json())
    .map(b => b.name)
    .filter(name => !keep.has(name) && DEPENDABOT_BRANCH_RE.test(name));
  if (!toDelete.length) return;
  log(`→ Removing ${toDelete.length} dependabot branch${toDelete.length > 1 ? "es" : ""}`);
  await deleteGithubBranches(owner, slug, token, toDelete, log, signal);
}

async function createGithub({ token, orgOrUser, slug, description, visibility, branches, protectedBranches, security, fileList, log, signal }) {
  const repoBody = { name: slug, description: description || undefined, private: visibility !== "public", auto_init: true };
  log(`→ Creating repository ${orgOrUser}/${slug}`);
  let res = await ghFetch(`/orgs/${orgOrUser}/repos`, token, { method: "POST", body: JSON.stringify(repoBody), signal });
  if (res.status === 404 || res.status === 403) {
    log("→ Owner is not an accessible org; creating under your user account");
    res = await ghFetch(`/user/repos`, token, { method: "POST", body: JSON.stringify(repoBody), signal });
  }
  if (!res.ok) throw new Error(`Create repo failed — ${await ghErr(res)}`);
  const repo = await res.json();
  const owner = repo.owner.login;
  const def = repo.default_branch || "main";
  log(`✓ Repository created: ${repo.html_url}`);

  // auto_init creates the first commit asynchronously; wait for the ref.
  let baseSha;
  for (let i = 0; i < 6 && !baseSha; i++) {
    const r = await ghFetch(`/repos/${owner}/${slug}/git/ref/heads/${def}`, token, { signal });
    if (r.ok) baseSha = (await r.json()).object.sha; else await sleep(700);
  }
  if (!baseSha) throw new Error("Timed out waiting for the initial commit.");
  const baseTree = (await (await ghFetch(`/repos/${owner}/${slug}/git/commits/${baseSha}`, token, { signal })).json()).tree.sha;

  const ctx = { name: slug, description, owner };
  const tree = treeEntries(fileList, ctx).map(f => ({ path: f.path, mode: "100644", type: "blob", content: f.content }));
  log(`→ Scaffolding ${tree.length} files`);
  const tRes = await ghFetch(`/repos/${owner}/${slug}/git/trees`, token, { method: "POST", body: JSON.stringify({ base_tree: baseTree, tree }), signal });
  if (!tRes.ok) throw new Error(`Build tree failed — ${await ghErr(tRes)}`);
  const newTree = (await tRes.json()).sha;
  const cRes = await ghFetch(`/repos/${owner}/${slug}/git/commits`, token, { method: "POST", body: JSON.stringify({ message: "chore: scaffold IaC repository", tree: newTree, parents: [baseSha] }), signal });
  if (!cRes.ok) throw new Error(`Commit failed — ${await ghErr(cRes)}`);
  const newCommit = (await cRes.json()).sha;
  await ghFetch(`/repos/${owner}/${slug}/git/refs/heads/${def}`, token, { method: "PATCH", body: JSON.stringify({ sha: newCommit, force: true }), signal });
  log(`✓ Committed ${tree.length} files to ${def}`);

  for (const b of branches) {
    if (b === def) continue;
    const r = await ghFetch(`/repos/${owner}/${slug}/git/refs`, token, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${b}`, sha: newCommit }), signal });
    log(r.ok ? `✓ Branch ${b}` : `⚠ Branch ${b} — ${await ghErr(r)}`);
  }

  if (security.secret_scanning) {
    await ghFetch(`/repos/${owner}/${slug}`, token, { method: "PATCH", signal,
      body: JSON.stringify({ security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } } }) }).catch(() => {});
  }

  if (security.branch_protection) {
    for (const b of protectedBranches) {
      if (!branches.includes(b)) continue;
      const r = await ghFetch(`/repos/${owner}/${slug}/branches/${b}/protection`, token, { method: "PUT", signal,
        body: JSON.stringify({ required_status_checks: null, enforce_admins: true, required_pull_request_reviews: { required_approving_review_count: 1 }, restrictions: null }) });
      log(r.ok ? `✓ Protected ${b}` : `⚠ Protect ${b} — ${await ghErr(r)}`);
      if (r.ok && security.signed_commits) {
        await ghFetch(`/repos/${owner}/${slug}/branches/${b}/protection/required_signatures`, token, { method: "POST", signal }).catch(() => {});
      }
    }
  }

  await cleanupDependabotBranchesGithub(owner, slug, token, [...new Set([...branches, def])], log, signal);
  return { repo_url: repo.html_url, owner, default_branch: def };
}

// ── GitLab REST ──────────────────────────────────────────────────────────────
function glFetch(path, token, opts = {}) {
  return fetch(`https://gitlab.com/api/v4${path}`, {
    ...opts,
    headers: { "PRIVATE-TOKEN": token, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
}

async function glErr(res) {
  try { const j = await res.json(); return `${res.status} ${j.message ? JSON.stringify(j.message) : (j.error || res.statusText)}`; }
  catch { return `${res.status} ${res.statusText}`; }
}

async function cleanupDependabotBranchesGitlab(projectId, token, keepBranches, log, signal) {
  const keep = new Set(keepBranches);
  const r = await glFetch(`/projects/${projectId}/repository/branches?per_page=100`, token, { signal });
  if (!r.ok) { log(`⚠ Could not list branches for cleanup — ${await glErr(r)}`); return; }
  const toDelete = (await r.json())
    .map(b => b.name)
    .filter(name => !keep.has(name) && DEPENDABOT_BRANCH_RE.test(name));
  if (!toDelete.length) return;
  log(`→ Removing ${toDelete.length} dependabot branch${toDelete.length > 1 ? "es" : ""}`);
  for (const name of toDelete) {
    const dr = await glFetch(`/projects/${projectId}/repository/branches/${encodeURIComponent(name)}`, token, { method: "DELETE", signal });
    log(dr.ok || dr.status === 404 ? `✓ Removed branch ${name}` : `⚠ Could not remove ${name} — ${await glErr(dr)}`);
  }
}

async function createGitlab({ token, orgOrUser, slug, description, visibility, branches, protectedBranches, security, fileList, log, signal }) {
  let namespace_id;
  if (orgOrUser) {
    const nr = await glFetch(`/namespaces?search=${encodeURIComponent(orgOrUser)}`, token, { signal });
    if (nr.ok) {
      const arr = await nr.json();
      const m = arr.find(n => [n.path, n.full_path].some(p => p?.toLowerCase() === orgOrUser.toLowerCase()));
      if (m) namespace_id = m.id;
    }
  }
  const body = { name: slug, path: slug, description, visibility, initialize_with_readme: false };
  if (namespace_id) body.namespace_id = namespace_id;
  log(`→ Creating project ${orgOrUser}/${slug}`);
  const res = await glFetch(`/projects`, token, { method: "POST", body: JSON.stringify(body), signal });
  if (!res.ok) throw new Error(`Create project failed — ${await glErr(res)}`);
  const proj = await res.json();
  const id = proj.id;
  const def = proj.default_branch || "main";
  log(`✓ Project created: ${proj.web_url}`);

  // One commit creates the default branch and all scaffold files at once.
  const ctx = { name: slug, description, owner: orgOrUser };
  const actions = treeEntries(fileList, ctx).map(f => ({ action: "create", file_path: f.path, content: f.content }));
  const cRes = await glFetch(`/projects/${id}/repository/commits`, token, { method: "POST", signal,
    body: JSON.stringify({ branch: def, commit_message: "chore: scaffold IaC repository", actions }) });
  if (!cRes.ok) throw new Error(`Initial commit failed — ${await glErr(cRes)}`);
  log(`✓ Committed ${actions.length} files to ${def}`);

  for (const b of branches) {
    if (b === def) continue;
    const r = await glFetch(`/projects/${id}/repository/branches?branch=${encodeURIComponent(b)}&ref=${encodeURIComponent(def)}`, token, { method: "POST", signal });
    log(r.ok ? `✓ Branch ${b}` : `⚠ Branch ${b} — ${await glErr(r)}`);
  }

  if (security.branch_protection) {
    for (const b of protectedBranches) {
      if (!branches.includes(b)) continue;
      const r = await glFetch(`/projects/${id}/protected_branches?name=${encodeURIComponent(b)}`, token, { method: "POST", signal });
      log(r.ok ? `✓ Protected ${b}` : `⚠ Protect ${b} — ${await glErr(r)}`);
    }
  }

  await cleanupDependabotBranchesGitlab(id, token, [...new Set([...branches, def])], log, signal);
  return { repo_url: proj.web_url, owner: orgOrUser, default_branch: def };
}

function createRepoReal(args) {
  return args.provider === "gitlab" ? createGitlab(args) : createGithub(args);
}

// Single entrypoint for both providers; normalizes request + response shape.
async function callLLM({ provider, model, apiKey, system, user, signal, maxTokens = 1500 }) {
  if (provider === "openai") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      signal,
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        response_format: { type: "json_object" },
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI ${res.status} ${res.statusText}. ${body.slice(0, 160)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  }
  // anthropic
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    signal,
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic ${res.status} ${res.statusText}. ${body.slice(0, 160)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || "";
}

// ── presentational components ────────────────────────────────────────────────
function Badge({ color, children }) {
  const colors = {
    green: { bg: "#EAF3DE", text: "#27500A", border: "#97C459" },
    amber: { bg: "#FAEEDA", text: "#633806", border: "#EF9F27" },
    blue:  { bg: "#E6F1FB", text: "#0C447C", border: "#85B7EB" },
    purple:{ bg: "#EEEDFE", text: "#3C3489", border: "#AFA9EC" },
    coral: { bg: "#FAECE7", text: "#712B13", border: "#F0997B" },
  };
  const c = colors[color] || colors.blue;
  return (
    <span style={{ background: c.bg, color: c.text, border: `0.5px solid ${c.border}`, borderRadius: 6, fontSize: 11, fontWeight: 500, padding: "2px 8px", whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

function Input({ label, value, onChange, placeholder, mono, hint, invalid }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6 }}>{label}</label>
      <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: "100%", fontFamily: mono ? "var(--font-mono)" : "inherit", boxSizing: "border-box", border: invalid ? "0.5px solid var(--color-border-danger)" : undefined }} />
      {hint && <p style={{ fontSize: 12, color: invalid ? "var(--color-text-danger)" : "var(--color-text-tertiary)", margin: "4px 0 0" }}>{hint}</p>}
    </div>
  );
}

function SecretInput({ label, value, onChange, placeholder, hint, show, onToggleShow, invalid }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6 }}>
        <i className="ti ti-shield-lock" style={{ fontSize: 13, verticalAlign: -2, marginRight: 4 }} aria-hidden />
        {label}
      </label>
      <div style={{ position: "relative" }}>
        <input type={show ? "text" : "password"} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} autoComplete="off" spellCheck={false}
          style={{ width: "100%", fontFamily: "var(--font-mono)", boxSizing: "border-box", paddingRight: 64, border: invalid ? "0.5px solid var(--color-border-danger)" : undefined }} />
        <button type="button" onClick={onToggleShow} style={{ position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)", padding: "3px 8px", fontSize: 11 }}>
          {show ? "Hide" : "Show"}
        </button>
      </div>
      {hint && <p style={{ fontSize: 12, color: invalid ? "var(--color-text-danger)" : "var(--color-text-tertiary)", margin: "4px 0 0" }}>{hint}</p>}
    </div>
  );
}

function StepBar({ current, furthest, onJump }) {
  return (
    <div style={{ display: "flex", gap: 0, marginBottom: 28, borderRadius: "var(--border-radius-md)", overflow: "hidden", border: "0.5px solid var(--color-border-tertiary)" }}>
      {STEPS.filter(s => s !== "done").map((s, i) => {
        const idx = STEPS.indexOf(current);
        const mine = STEPS.indexOf(s);
        const done = mine < idx;
        const active = s === current;
        const reachable = mine <= STEPS.indexOf(furthest);
        return (
          <div key={s} onClick={() => reachable && onJump(s)} style={{
            flex: 1, padding: "8px 4px", textAlign: "center", fontSize: 11, fontWeight: active ? 500 : 400,
            background: active ? "var(--color-background-info)" : done ? "var(--color-background-secondary)" : "transparent",
            color: active ? "var(--color-text-info)" : done ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
            borderRight: i < 4 ? "0.5px solid var(--color-border-tertiary)" : "none",
            cursor: reachable ? "pointer" : "default", transition: "all 0.2s",
          }}>
            {done ? <i className="ti ti-check" style={{ fontSize: 11 }} /> : null} {LABEL[s]}
          </div>
        );
      })}
    </div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{ background: "var(--color-background-primary)", border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-lg)", padding: "1rem 1.25rem", ...style }}>
      {children}
    </div>
  );
}

function LogLine({ line }) {
  const isError = line.includes("✗") || line.toLowerCase().includes("error") || line.toLowerCase().includes("failed");
  const isSuccess = line.includes("✓") || line.toLowerCase().includes("success") || line.toLowerCase().includes("created");
  const isInfo = line.startsWith("→") || line.startsWith("  ");
  return (
    <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, padding: "2px 0", whiteSpace: "pre-wrap",
      color: isError ? "var(--color-text-danger)" : isSuccess ? "var(--color-text-success)" : isInfo ? "var(--color-text-secondary)" : "var(--color-text-primary)" }}>
      {line || "\u00A0"}
    </div>
  );
}

function ScoreMeter({ score, label, color }) {
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)" }}>Security posture</span>
        <Badge color={color}>{label} · {score}/100</Badge>
      </div>
      <div style={{ height: 6, borderRadius: 999, background: "var(--color-background-secondary)", overflow: "hidden" }}>
        <div style={{ width: `${score}%`, height: "100%", background: "var(--color-text-success)", transition: "width 0.25s" }} />
      </div>
    </div>
  );
}

export default function App() {
  const [step, setStep] = useState("provider");
  const [furthest, setFurthest] = useState("provider");
  const [provider, setProvider] = useState("github");
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [orgOrUser, setOrgOrUser] = useState("");
  const [projectName, setProjectName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState("private");
  const [branchPreset, setBranchPreset] = useState("gitflow");
  const [customBranches, setCustomBranches] = useState([]);
  const [protectedBranches, setProtectedBranches] = useState(["main"]);
  const [security, setSecurity] = useState(Object.fromEntries(SECURITY_OPTIONS.map(o => [o.id, o.default])));

  // AI reviewer config (works with both Anthropic + OpenAI)
  const [llmProvider, setLlmProvider] = useState("anthropic");
  const [llmModel, setLlmModel] = useState(LLM_PROVIDERS.anthropic.models[0]);
  const [llmKey, setLlmKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  const [mode, setMode] = useState("real"); // "real" hits the provider API; "simulate" asks the LLM for a mock plan
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [copied, setCopied] = useState(false);

  const [audit, setAudit] = useState(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState("");

  const logsRef = useRef(null);
  const abortRef = useRef(null);
  const auditAbortRef = useRef(null);

  const preset = BRANCH_PRESETS.find(p => p.id === branchPreset);
  const allBranches = useMemo(() => [...new Set([...preset.branches, ...customBranches])], [preset, customBranches]);
  const nameCheck = useMemo(() => validateRepoName(projectName), [projectName]);
  const posture = useMemo(() => postureScore(security), [security]);
  const warnings = useMemo(() => configWarnings({ security, protectedBranches, visibility, description, projectName }), [security, protectedBranches, visibility, description, projectName]);
  const files = useMemo(() => plannedFiles({ allBranches, security }), [allBranches, security]);

  useEffect(() => {
    setProtectedBranches(prev => {
      const pruned = prev.filter(b => allBranches.includes(b));
      return pruned.length === prev.length ? prev : pruned;
    });
  }, [allBranches]);

  // Build a secret-free config for the model. Secrets never leave this client.
  const safeConfig = useMemo(() => ({
    provider, orgOrUser, projectName: nameCheck.slug, description, visibility,
    branches: allBranches, protectedBranches,
    security: Object.fromEntries(SECURITY_OPTIONS.map(o => [o.id, !!security[o.id]])),
    securityScore: posture.score,
  }), [provider, orgOrUser, nameCheck.slug, description, visibility, allBranches, protectedBranches, security, posture.score]);

  function goTo(s) {
    setStep(s);
    if (STEPS.indexOf(s) > STEPS.indexOf(furthest)) setFurthest(s);
  }

  // Redact known + pattern-matched secrets before anything hits the log UI.
  function redact(text) {
    let t = String(text);
    for (const s of [token, llmKey]) if (s && s.length >= 6) t = t.split(s).join("••••••");
    return t.replace(SECRET_RE, "••••••");
  }

  function addLog(line) {
    setLogs(prev => {
      const next = [...prev, redact(line)];
      setTimeout(() => logsRef.current?.scrollTo(0, logsRef.current.scrollHeight), 50);
      return next;
    });
  }

  function addBranch() {
    const b = slugify(newBranch);
    if (b && !allBranches.includes(b)) setCustomBranches(p => [...p, b]);
    setNewBranch("");
  }

  function removeBranch(b) { setCustomBranches(p => p.filter(x => x !== b)); }

  function toggleProtected(branch) {
    setProtectedBranches(p => p.includes(branch) ? p.filter(x => x !== branch) : [...p, branch]);
  }

  function toggleSecurity(id) {
    setSecurity(prev => {
      const next = { ...prev, [id]: !prev[id] };
      if (next[id]) for (const dep of OPT_BY_ID[id].requires || []) next[dep] = true;
      return next;
    });
  }

  function applyRecommended() {
    setSecurity(Object.fromEntries(SECURITY_OPTIONS.map(o => [o.id, !!o.rec])));
  }

  function changeLlmProvider(p) {
    setLlmProvider(p);
    setLlmModel(LLM_PROVIDERS[p].models[0]);
  }

  function copyUrl(url) {
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function exportConfig() {
    const blob = new Blob([JSON.stringify(safeConfig, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${nameCheck.slug || "iac-repo"}.config.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function runAudit() {
    if (!llmKey.trim()) { setAuditError("Add an AI reviewer API key on the Provider step first."); return; }
    setAuditing(true);
    setAuditError("");
    setAudit(null);
    const controller = new AbortController();
    auditAbortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 45000);
    try {
      const raw = await callLLM({
        provider: llmProvider, model: llmModel, apiKey: llmKey, signal: controller.signal, maxTokens: 1800,
        system: AUDIT_SYSTEM,
        user: `Audit this ${provider} IaC repository configuration:\n${JSON.stringify(safeConfig, null, 2)}`,
      });
      const parsed = extractJson(raw);
      parsed.findings = (parsed.findings || []).sort(
        (a, b) => (SEVERITY[b.severity]?.rank || 0) - (SEVERITY[a.severity]?.rank || 0)
      );
      setAudit(parsed);
    } catch (e) {
      setAuditError(e.name === "AbortError" ? "Audit cancelled or timed out." : (e.message || "Audit failed"));
    } finally {
      clearTimeout(timeout);
      auditAbortRef.current = null;
      setAuditing(false);
    }
  }

  async function createRepo() {
    if (mode === "real" && !token.trim()) { setError("Add your Git provider token on the Provider step first."); return; }
    if (mode === "simulate" && !llmKey.trim()) { setError("Simulate mode needs an AI reviewer API key (Provider step)."); return; }
    setLoading(true);
    setLogs([]);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      if (mode === "real") {
        addLog(`Creating real ${provider === "gitlab" ? "GitLab" : "GitHub"} repository ${orgOrUser}/${nameCheck.slug}...`);
        const out = await createRepoReal({
          provider, token, orgOrUser, slug: nameCheck.slug, description, visibility,
          branches: allBranches, protectedBranches, security, fileList: files,
          log: addLog, signal: controller.signal,
        });
        if (warnings.length) { addLog(""); for (const w of warnings) addLog(`⚠ ${w}`); }
        addLog("");
        addLog(`✓ Repository ready: ${out.repo_url}`);
        setResult({
          summary: `Created ${out.owner}/${nameCheck.slug} on ${provider === "gitlab" ? "GitLab" : "GitHub"} with ${allBranches.length} branch${allBranches.length > 1 ? "es" : ""}.`,
          repo_url: out.repo_url,
          files_created: files.filter(f => !f.endsWith("/")),
          warnings,
        });
        goTo("done");
        return;
      }

      // simulate: ask the LLM for a realistic (mock) plan
      addLog(`Simulating with ${LLM_PROVIDERS[llmProvider].name} (${llmModel})`);
      addLog(`Generating plan for ${orgOrUser}/${nameCheck.slug}...`);
      const raw = await callLLM({
        provider: llmProvider, model: llmModel, apiKey: llmKey, signal: controller.signal, maxTokens: 1500,
        system: CREATE_SYSTEM,
        user: `Create an IaC repository with this configuration:\n${JSON.stringify({ ...safeConfig, token: token ? "provided" : "missing" }, null, 2)}\n\nGenerate the realistic step-by-step plan.`,
      });
      let plan;
      try { plan = extractJson(raw); }
      catch { throw new Error("Could not parse plan from model response: " + raw.slice(0, 200)); }

      for (const s of plan.steps || []) {
        await sleep(240);
        const icon = s.status === "ok" ? "✓" : s.status === "warn" ? "⚠" : "→";
        addLog(`${icon} ${s.action}`);
        if (s.detail) addLog(`  ${s.detail}`);
      }
      const mergedWarnings = [...new Set([...(plan.warnings || []), ...warnings])];
      if (mergedWarnings.length) { addLog(""); for (const w of mergedWarnings) addLog(`⚠ ${w}`); }
      addLog("");
      addLog(`✓ Plan complete (simulated): ${plan.repo_url}`);
      setResult({ ...plan, summary: `[Simulated] ${plan.summary || ""}`, files_created: plan.files_created?.length ? plan.files_created : files, warnings: mergedWarnings });
      goTo("done");
    } catch (e) {
      const msg = e.name === "AbortError" ? "Creation cancelled or timed out." : (e.message || "Unknown error");
      addLog(`✗ Failed: ${msg}`);
      setError(msg);
    } finally {
      clearTimeout(timeout);
      abortRef.current = null;
      setLoading(false);
    }
  }

  function resetWizard() {
    setStep("provider"); setFurthest("provider");
    setLogs([]); setResult(null); setError("");
    setProjectName(""); setCustomBranches([]); setProtectedBranches(["main"]);
    setAudit(null); setAuditError("");
  }

  function askNextSteps() {
    const prompt = `I just created the repo ${orgOrUser}/${nameCheck.slug} using the IaC configurator. What should I do next to set up the tf-agent to start generating code into this repo?`;
    if (typeof sendPrompt === "function") sendPrompt(prompt);
  }

  const canProceedProvider = token.trim() && orgOrUser.trim();
  const canProceedProject = nameCheck.ok;
  const lp = LLM_PROVIDERS[llmProvider];

  return (
    <div style={{ padding: "1.5rem 0", maxWidth: 660, margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: "var(--color-background-info)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <i className="ti ti-cloud-cog" style={{ fontSize: 18, color: "var(--color-text-info)" }} aria-hidden />
          </div>
          <div>
            <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>IaC Repository Configurator</h2>
            <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-tertiary)" }}>Provision a compliant infrastructure repo, AI-reviewed.</p>
          </div>
        </div>
        <Badge color="green"><i className="ti ti-building-bank" style={{ fontSize: 11, verticalAlign: -1, marginRight: 3 }} /> Enterprise</Badge>
      </div>

      <p style={{ fontSize: 13, color: "var(--color-text-tertiary)", margin: "10px 0 22px" }}>
        Configure a production-ready infrastructure repo with IaC best practices, protected branches, and security policies — validated by an AI DevSecOps reviewer (Claude or ChatGPT).
      </p>

      {step !== "done" && <StepBar current={step} furthest={furthest} onJump={goTo} />}

      {step === "provider" && (
        <>
          <Card style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 16, color: "var(--color-text-secondary)" }}>Connect your Git provider</p>
            <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
              {["github", "gitlab"].map(p => (
                <button key={p} onClick={() => setProvider(p)} style={{
                  flex: 1, padding: "10px 0", borderRadius: "var(--border-radius-md)",
                  border: provider === p ? "2px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
                  background: provider === p ? "var(--color-background-info)" : "transparent",
                  color: provider === p ? "var(--color-text-info)" : "var(--color-text-secondary)",
                  fontWeight: provider === p ? 500 : 400, fontSize: 14, cursor: "pointer",
                }}>
                  <i className={`ti ti-brand-${p}`} style={{ fontSize: 18, verticalAlign: -3, marginRight: 6 }} aria-hidden />
                  {p === "github" ? "GitHub" : "GitLab"}
                </button>
              ))}
            </div>
            <SecretInput label="Personal access token" value={token} onChange={setToken} show={showToken} onToggleShow={() => setShowToken(s => !s)}
              placeholder={provider === "github" ? "ghp_..." : "glpat-..."} invalid={looksLikeSecret(token) && token.length < 10}
              hint={`Needs: repo (GitHub) or api scope (GitLab). Stored in memory only, redacted from logs.`} />
            <Input label={provider === "github" ? "Organisation or username" : "Namespace / group"} value={orgOrUser} onChange={setOrgOrUser}
              placeholder={provider === "github" ? "my-org" : "my-group"} mono />
          </Card>

          <Card style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, color: "var(--color-text-secondary)" }}>
              <i className="ti ti-robot" style={{ fontSize: 14, verticalAlign: -2, marginRight: 6 }} aria-hidden />
              AI reviewer
            </p>
            <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 14 }}>Powers the creation plan and the best-practice audit. Choose your model provider.</p>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              {Object.entries(LLM_PROVIDERS).map(([id, cfg]) => (
                <button key={id} onClick={() => changeLlmProvider(id)} style={{
                  flex: 1, padding: "10px 0", borderRadius: "var(--border-radius-md)",
                  border: llmProvider === id ? "2px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
                  background: llmProvider === id ? "var(--color-background-info)" : "transparent",
                  color: llmProvider === id ? "var(--color-text-info)" : "var(--color-text-secondary)",
                  fontWeight: llmProvider === id ? 500 : 400, fontSize: 13, cursor: "pointer",
                }}>
                  <i className={`ti ${cfg.icon}`} style={{ fontSize: 16, verticalAlign: -3, marginRight: 6 }} aria-hidden />
                  {cfg.name}
                </button>
              ))}
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 6 }}>Model</label>
              <select value={llmModel} onChange={e => setLlmModel(e.target.value)}
                style={{ width: "100%", fontFamily: "var(--font-mono)", fontSize: 13, padding: "8px 10px", borderRadius: "var(--border-radius-md)", border: "0.5px solid var(--color-border-tertiary)", background: "var(--color-background-primary)", color: "var(--color-text-primary)", boxSizing: "border-box" }}>
                {lp.models.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <SecretInput label={`${lp.name} API key`} value={llmKey} onChange={setLlmKey} show={showKey} onToggleShow={() => setShowKey(s => !s)}
              placeholder={lp.keyPlaceholder} hint={lp.keyHint} />
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 10px", borderRadius: "var(--border-radius-md)", background: "var(--color-background-secondary)" }}>
              <i className="ti ti-lock" style={{ fontSize: 13, color: "var(--color-text-tertiary)", marginTop: 1 }} aria-hidden />
              <p style={{ margin: 0, fontSize: 11, color: "var(--color-text-tertiary)" }}>
                Keys stay in this browser session, are sent only to the chosen provider over HTTPS, and are automatically redacted from the activity log.
              </p>
            </div>
          </Card>

          <button disabled={!canProceedProvider} onClick={() => goTo("project")} style={{ width: "100%", padding: "11px 0", fontWeight: 500 }}>
            Continue <i className="ti ti-arrow-right" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden />
          </button>
          <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", textAlign: "center", margin: "8px 0 0" }}>
            {!canProceedProvider
              ? "Provide a Git token and owner to continue."
              : "AI key is optional — needed only for the audit and simulate mode."}
          </p>
        </>
      )}

      {step === "project" && (
        <Card>
          <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 16, color: "var(--color-text-secondary)" }}>Name and describe the project</p>
          <Input label="Repository name" value={projectName} onChange={setProjectName} placeholder="terraform-infra-live" mono
            invalid={!!projectName && !nameCheck.ok}
            hint={projectName ? (nameCheck.msg || "Looks good.") : "Lowercase, hyphens only. This becomes the repo name."} />
          <Input label="Description" value={description} onChange={setDescription} placeholder="Infrastructure-as-code for production workloads"
            invalid={looksLikeSecret(description)}
            hint={looksLikeSecret(description) ? "This looks like a secret — don't put credentials here." : "Shown in the repo header and indexes."} />
          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 8 }}>Visibility</label>
            <div style={{ display: "flex", gap: 10 }}>
              {["private", "internal", "public"].map(v => (
                <button key={v} onClick={() => setVisibility(v)} style={{
                  flex: 1, padding: "8px 0", borderRadius: "var(--border-radius-md)",
                  border: visibility === v ? "2px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
                  background: visibility === v ? "var(--color-background-info)" : "transparent",
                  color: visibility === v ? "var(--color-text-info)" : "var(--color-text-secondary)",
                  fontWeight: visibility === v ? 500 : 400, fontSize: 13, cursor: "pointer",
                }}>
                  <i className={`ti ti-${v === "private" ? "lock" : v === "internal" ? "building" : "world"}`} style={{ fontSize: 13, verticalAlign: -2, marginRight: 4 }} aria-hidden />
                  {v.charAt(0).toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => goTo("provider")} style={{ flex: 1, padding: "10px 0" }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden /> Back
            </button>
            <button disabled={!canProceedProject} onClick={() => goTo("branches")} style={{ flex: 2, padding: "10px 0", fontWeight: 500 }}>
              Continue <i className="ti ti-arrow-right" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden />
            </button>
          </div>
        </Card>
      )}

      {step === "branches" && (
        <Card>
          <p style={{ fontSize: 13, fontWeight: 500, marginBottom: 16, color: "var(--color-text-secondary)" }}>Branch strategy</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
            {BRANCH_PRESETS.map(p => (
              <div key={p.id} onClick={() => setBranchPreset(p.id)} style={{
                display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 12px",
                border: branchPreset === p.id ? "2px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
                borderRadius: "var(--border-radius-md)", cursor: "pointer",
                background: branchPreset === p.id ? "var(--color-background-info)" : "transparent",
              }}>
                <div style={{ marginTop: 2, width: 14, height: 14, borderRadius: "50%", border: "2px solid", borderColor: branchPreset === p.id ? "var(--color-text-info)" : "var(--color-border-secondary)", background: branchPreset === p.id ? "var(--color-text-info)" : "transparent", flexShrink: 0 }} />
                <div>
                  <p style={{ margin: 0, fontWeight: 500, fontSize: 14, color: branchPreset === p.id ? "var(--color-text-info)" : "var(--color-text-primary)" }}>{p.name}</p>
                  <p style={{ margin: "2px 0 6px", fontSize: 12, color: "var(--color-text-secondary)" }}>{p.desc}</p>
                  <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                    {p.branches.map(b => <Badge key={b} color="purple">{b}</Badge>)}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 6 }}>Add custom branch</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={newBranch} onChange={e => setNewBranch(e.target.value)} onKeyDown={e => e.key === "Enter" && addBranch()} placeholder="hotfix" style={{ flex: 1, fontFamily: "var(--font-mono)" }} />
              <button onClick={addBranch} style={{ padding: "0 16px" }}><i className="ti ti-plus" style={{ fontSize: 14 }} aria-hidden /></button>
            </div>
            {customBranches.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                {customBranches.map(b => (
                  <button key={b} onClick={() => removeBranch(b)} title="Remove custom branch" style={{
                    padding: "4px 8px", borderRadius: 6, fontSize: 12, fontFamily: "var(--font-mono)",
                    border: "0.5px solid var(--color-border-tertiary)", background: "transparent",
                    color: "var(--color-text-secondary)", cursor: "pointer", display: "flex", alignItems: "center", gap: 4,
                  }}>
                    {b} <i className="ti ti-x" style={{ fontSize: 11 }} aria-hidden />
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginBottom: 20 }}>
            <label style={{ fontSize: 13, fontWeight: 500, color: "var(--color-text-secondary)", display: "block", marginBottom: 8 }}>
              Protected branches <span style={{ fontWeight: 400, color: "var(--color-text-tertiary)" }}>(click to toggle)</span>
            </label>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {allBranches.map(b => {
                const isProtected = protectedBranches.includes(b);
                return (
                  <button key={b} onClick={() => toggleProtected(b)} style={{
                    padding: "4px 10px", borderRadius: 6, fontSize: 12, fontFamily: "var(--font-mono)",
                    border: isProtected ? "0.5px solid var(--color-border-success)" : "0.5px solid var(--color-border-tertiary)",
                    background: isProtected ? "var(--color-background-success)" : "transparent",
                    color: isProtected ? "var(--color-text-success)" : "var(--color-text-tertiary)", cursor: "pointer",
                  }}>
                    {isProtected && <i className="ti ti-lock" style={{ fontSize: 11, verticalAlign: -1, marginRight: 4 }} aria-hidden />}
                    {b}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => goTo("project")} style={{ flex: 1, padding: "10px 0" }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden /> Back
            </button>
            <button onClick={() => goTo("security")} style={{ flex: 2, padding: "10px 0", fontWeight: 500 }}>
              Continue <i className="ti ti-arrow-right" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden />
            </button>
          </div>
        </Card>
      )}

      {step === "security" && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
            <p style={{ fontSize: 13, fontWeight: 500, margin: 0, color: "var(--color-text-secondary)" }}>Security & IaC policies</p>
            <button onClick={applyRecommended} style={{ padding: "4px 10px", fontSize: 12, fontWeight: 500 }}>
              <i className="ti ti-sparkles" style={{ fontSize: 13, verticalAlign: -2, marginRight: 4 }} aria-hidden /> Recommended
            </button>
          </div>
          <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", marginBottom: 12 }}>Applied to protected branches. Recommended settings are pre-selected.</p>

          <div style={{ marginBottom: 16 }}><ScoreMeter {...posture} /></div>

          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 20 }}>
            {SECURITY_OPTIONS.map(opt => {
              const unmetDep = (opt.requires || []).find(d => security[opt.id] && !security[d]);
              return (
                <div key={opt.id} onClick={() => toggleSecurity(opt.id)} style={{
                  display: "flex", alignItems: "flex-start", gap: 12, padding: "10px 12px",
                  borderRadius: "var(--border-radius-md)", cursor: "pointer",
                  background: security[opt.id] ? "var(--color-background-success)" : "var(--color-background-secondary)",
                  border: security[opt.id] ? "0.5px solid var(--color-border-success)" : "0.5px solid var(--color-border-tertiary)",
                  transition: "all 0.15s",
                }}>
                  <div style={{ marginTop: 2, width: 16, height: 16, borderRadius: 4, border: "1.5px solid", borderColor: security[opt.id] ? "var(--color-text-success)" : "var(--color-border-secondary)", background: security[opt.id] ? "var(--color-text-success)" : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "all 0.15s" }}>
                    {security[opt.id] && <i className="ti ti-check" style={{ fontSize: 10, color: "var(--color-background-primary)" }} />}
                  </div>
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontWeight: 500, fontSize: 13, color: security[opt.id] ? "var(--color-text-success)" : "var(--color-text-primary)" }}>
                      {opt.label} {opt.rec && <span style={{ fontWeight: 400, fontSize: 11, color: "var(--color-text-tertiary)" }}>· recommended</span>}
                    </p>
                    <p style={{ margin: "1px 0 0", fontSize: 12, color: "var(--color-text-secondary)" }}>{opt.desc}</p>
                    {unmetDep && <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--color-text-danger)" }}>Needs "{OPT_BY_ID[unmetDep].label}" enabled.</p>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => goTo("branches")} style={{ flex: 1, padding: "10px 0" }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden /> Back
            </button>
            <button onClick={() => goTo("review")} style={{ flex: 2, padding: "10px 0", fontWeight: 500 }}>
              Review <i className="ti ti-arrow-right" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden />
            </button>
          </div>
        </Card>
      )}

      {step === "review" && (
        <div>
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
              <p style={{ fontSize: 13, fontWeight: 500, margin: 0, color: "var(--color-text-secondary)" }}>Repository overview</p>
              <div style={{ display: "flex", gap: 6 }}>
                <Badge color={posture.color}>{posture.label} · {posture.score}/100</Badge>
                <button onClick={exportConfig} title="Export config JSON" style={{ padding: "2px 8px", fontSize: 11 }}>
                  <i className="ti ti-download" style={{ fontSize: 12 }} aria-hidden /> Export
                </button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
              {[
                ["Provider", provider === "github" ? "GitHub" : "GitLab"],
                ["Owner", orgOrUser],
                ["Repository", nameCheck.slug],
                ["Visibility", visibility],
              ].map(([k, v]) => (
                <div key={k} style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "8px 10px" }}>
                  <p style={{ margin: 0, fontSize: 11, color: "var(--color-text-tertiary)" }}>{k}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 13, fontWeight: 500, fontFamily: k === "Repository" || k === "Owner" ? "var(--font-mono)" : "inherit" }}>{v}</p>
                </div>
              ))}
            </div>

            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 8 }}>Branches</p>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
              {allBranches.map(b => (
                <span key={b} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <Badge color="purple">{b}</Badge>
                  {protectedBranches.includes(b) && <Badge color="green"><i className="ti ti-lock" style={{ fontSize: 10 }} /> protected</Badge>}
                </span>
              ))}
            </div>

            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 8 }}>Security policies enabled</p>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {SECURITY_OPTIONS.filter(o => security[o.id]).map(o => <Badge key={o.id} color="blue">{o.label}</Badge>)}
            </div>
          </Card>

          {/* AI best-practice audit */}
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: audit || auditError ? 12 : 0 }}>
              <p style={{ fontSize: 13, fontWeight: 500, margin: 0, color: "var(--color-text-secondary)" }}>
                <i className="ti ti-shield-check" style={{ fontSize: 14, verticalAlign: -2, marginRight: 6 }} aria-hidden />
                AI best-practice audit
              </p>
              {auditing ? (
                <button onClick={() => auditAbortRef.current?.abort()} style={{ padding: "5px 12px", fontSize: 12, fontWeight: 500 }}>
                  <i className="ti ti-loader-2" style={{ fontSize: 13, verticalAlign: -2, marginRight: 4 }} aria-hidden /> Cancel
                </button>
              ) : (
                <button onClick={runAudit} style={{ padding: "5px 12px", fontSize: 12, fontWeight: 500 }}>
                  <i className={`ti ${audit ? "ti-refresh" : lp.icon}`} style={{ fontSize: 13, verticalAlign: -2, marginRight: 4 }} aria-hidden />
                  {audit ? "Re-run" : `Audit with ${llmProvider === "openai" ? "ChatGPT" : "Claude"}`}
                </button>
              )}
            </div>

            {!audit && !auditError && !auditing && (
              <p style={{ fontSize: 12, color: "var(--color-text-tertiary)", margin: "10px 0 0" }}>
                Run an AI DevSecOps review of this config against {provider === "github" ? "GitHub" : "GitLab"} + Terraform/OpenTofu best practices before you create the repo.
              </p>
            )}

            {auditError && (
              <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-danger)" }}>
                <i className="ti ti-alert-triangle" style={{ fontSize: 13, verticalAlign: -2, marginRight: 4 }} aria-hidden />{auditError}
              </p>
            )}

            {audit && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <Badge color={audit.score >= 75 ? "green" : audit.score >= 40 ? "blue" : "coral"}>AI score · {audit.score}/100</Badge>
                  <p style={{ margin: 0, fontSize: 12, color: "var(--color-text-secondary)" }}>{audit.summary}</p>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {audit.findings?.map((f, i) => {
                    const sev = SEVERITY[f.severity] || SEVERITY.info;
                    return (
                      <div key={i} style={{ border: "0.5px solid var(--color-border-tertiary)", borderRadius: "var(--border-radius-md)", padding: "8px 10px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
                          <Badge color={sev.color}><i className={`ti ${sev.icon}`} style={{ fontSize: 10, verticalAlign: -1, marginRight: 2 }} />{f.severity}</Badge>
                          {f.area && <Badge color="purple">{f.area}</Badge>}
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{f.title}</span>
                        </div>
                        {f.detail && <p style={{ margin: "2px 0 0", fontSize: 12, color: "var(--color-text-secondary)" }}>{f.detail}</p>}
                        {f.recommendation && (
                          <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--color-text-success)" }}>
                            <i className="ti ti-arrow-right" style={{ fontSize: 11, verticalAlign: -1, marginRight: 4 }} aria-hidden />{f.recommendation}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </Card>

          {warnings.length > 0 && (
            <Card style={{ marginBottom: 12, border: "0.5px solid #EF9F27", background: "#FAEEDA" }}>
              <p style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 500, color: "#633806" }}>
                <i className="ti ti-alert-triangle" style={{ fontSize: 13, verticalAlign: -2, marginRight: 6 }} aria-hidden />
                {warnings.length} thing{warnings.length > 1 ? "s" : ""} to review
              </p>
              {warnings.map((w, i) => <p key={i} style={{ margin: "2px 0 0", fontSize: 12, color: "#633806" }}>• {w}</p>)}
            </Card>
          )}

          <Card style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 10 }}>
              <i className="ti ti-folder-code" style={{ fontSize: 13, verticalAlign: -2, marginRight: 6 }} aria-hidden />
              Will scaffold {files.length} files & directories
            </p>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {files.map(f => (
                <span key={f} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-text-secondary)", background: "var(--color-background-secondary)", borderRadius: 4, padding: "2px 6px" }}>{f}</span>
              ))}
            </div>
          </Card>

          {logs.length > 0 && (
            <Card style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 8 }}>
                <i className="ti ti-terminal-2" style={{ fontSize: 13, verticalAlign: -2, marginRight: 6 }} aria-hidden />
                Creation log
              </p>
              <div ref={logsRef} style={{ maxHeight: 280, overflowY: "auto", background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 12px" }}>
                {logs.map((l, i) => <LogLine key={i} line={l} />)}
                {loading && <div style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--color-text-tertiary)", animation: "pulse 1s infinite" }}>▌</div>}
              </div>
            </Card>
          )}

          {error && (
            <Card style={{ marginBottom: 12, border: "0.5px solid var(--color-border-danger)", background: "var(--color-background-danger)" }}>
              <p style={{ margin: 0, fontSize: 13, color: "var(--color-text-danger)" }}>
                <i className="ti ti-alert-triangle" style={{ fontSize: 14, verticalAlign: -2, marginRight: 6 }} aria-hidden />{error}
              </p>
            </Card>
          )}

          <Card style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 8 }}>Create mode</p>
            <div style={{ display: "flex", gap: 10 }}>
              {[
                { id: "real", label: "Create for real", desc: `Calls the ${provider === "gitlab" ? "GitLab" : "GitHub"} API with your token`, icon: "ti-cloud-upload" },
                { id: "simulate", label: "Simulate (AI plan)", desc: "Dry run — no repo is created", icon: "ti-flask" },
              ].map(m => (
                <div key={m.id} onClick={() => setMode(m.id)} style={{
                  flex: 1, padding: "10px 12px", borderRadius: "var(--border-radius-md)", cursor: "pointer",
                  border: mode === m.id ? "2px solid var(--color-border-info)" : "0.5px solid var(--color-border-tertiary)",
                  background: mode === m.id ? "var(--color-background-info)" : "transparent",
                }}>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 500, color: mode === m.id ? "var(--color-text-info)" : "var(--color-text-primary)" }}>
                    <i className={`ti ${m.icon}`} style={{ fontSize: 14, verticalAlign: -2, marginRight: 6 }} aria-hidden />{m.label}
                  </p>
                  <p style={{ margin: "3px 0 0", fontSize: 11, color: "var(--color-text-secondary)" }}>{m.desc}</p>
                </div>
              ))}
            </div>
            {mode === "real" && (
              <p style={{ margin: "10px 0 0", fontSize: 11, color: "var(--color-text-tertiary)" }}>
                <i className="ti ti-info-circle" style={{ fontSize: 12, verticalAlign: -2, marginRight: 4 }} aria-hidden />
                Requires token scopes: <code>repo</code> (GitHub) or <code>api</code> (GitLab). Branch protection needs admin rights; some org security settings may require GitHub Advanced Security.
              </p>
            )}
          </Card>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={() => goTo("security")} disabled={loading} style={{ flex: 1, padding: "10px 0" }}>
              <i className="ti ti-arrow-left" style={{ fontSize: 14, verticalAlign: -2 }} aria-hidden /> Back
            </button>
            {loading ? (
              <button onClick={() => abortRef.current?.abort()} style={{ flex: 2, padding: "11px 0", fontWeight: 500, background: "var(--color-background-danger)", color: "var(--color-text-danger)", border: "0.5px solid var(--color-border-danger)" }}>
                <i className="ti ti-loader-2" style={{ fontSize: 14, verticalAlign: -2, marginRight: 6 }} aria-hidden />Cancel
              </button>
            ) : (
              <button onClick={createRepo} style={{ flex: 2, padding: "11px 0", fontWeight: 500, background: "var(--color-background-info)", color: "var(--color-text-info)", border: "0.5px solid var(--color-border-info)" }}>
                <i className={`ti ti-${error ? "refresh" : mode === "real" ? "rocket" : "flask"}`} style={{ fontSize: 14, verticalAlign: -2, marginRight: 6 }} aria-hidden />
                {error ? "Retry" : mode === "real" ? "Create repository" : "Run simulation"}
              </button>
            )}
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div>
          <Card style={{ marginBottom: 12, border: "0.5px solid var(--color-border-success)", textAlign: "center" }}>
            <i className="ti ti-circle-check" style={{ fontSize: 32, color: "var(--color-text-success)", display: "block", margin: "8px auto 12px" }} aria-hidden />
            <p style={{ fontWeight: 500, fontSize: 16, margin: "0 0 4px" }}>Repository created</p>
            <p style={{ fontSize: 13, color: "var(--color-text-secondary)", margin: "0 0 14px" }}>{result.summary}</p>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <a href={result.repo_url} style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--color-text-info)", wordBreak: "break-all" }}>
                {result.repo_url} <i className="ti ti-external-link" style={{ fontSize: 12, verticalAlign: -1 }} aria-hidden />
              </a>
              <button onClick={() => copyUrl(result.repo_url)} title="Copy URL" style={{ padding: "2px 8px", fontSize: 12 }}>
                <i className={`ti ti-${copied ? "check" : "copy"}`} style={{ fontSize: 13 }} aria-hidden /> {copied ? "Copied" : "Copy"}
              </button>
            </div>
          </Card>

          <Card style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 10 }}>Files & directories created</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {result.files_created?.map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", borderBottom: i < result.files_created.length - 1 ? "0.5px solid var(--color-border-tertiary)" : "none" }}>
                  <i className={`ti ti-${f.endsWith("/") || !f.includes(".") ? "folder" : "file"}`} style={{ fontSize: 14, color: "var(--color-text-tertiary)" }} aria-hidden />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{f}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card style={{ marginBottom: 12 }}>
            <p style={{ fontSize: 12, fontWeight: 500, color: "var(--color-text-secondary)", marginBottom: 10 }}>Creation log</p>
            <div ref={logsRef} style={{ background: "var(--color-background-secondary)", borderRadius: "var(--border-radius-md)", padding: "10px 12px", maxHeight: 220, overflowY: "auto" }}>
              {logs.map((l, i) => <LogLine key={i} line={l} />)}
            </div>
          </Card>

          <div style={{ display: "flex", gap: 10 }}>
            <button onClick={resetWizard} style={{ flex: 1, padding: "10px 0" }}>
              <i className="ti ti-plus" style={{ fontSize: 14, verticalAlign: -2, marginRight: 4 }} aria-hidden /> New repo
            </button>
            <button onClick={askNextSteps} style={{ flex: 2, padding: "10px 0", fontWeight: 500 }}>
              Next steps ↗
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
