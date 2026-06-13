# IaC Repository Configurator

An enterprise-ready wizard for provisioning a **production-grade Infrastructure-as-Code repository** on GitHub or GitLab — with sane branch strategies, branch protection, and security/IaC policies baked in. An AI reviewer (Claude **or** ChatGPT) audits your configuration against best practices before anything is created.

The entire app is a single React component (`iac-repo-configurator.jsx`) wrapped in a minimal [Vite](https://vitejs.dev/) dev shell.

---

## Features

- **5-step guided wizard** — Provider → Project → Branch strategy → Security & policies → Review & create.
- **Real repository creation** — calls the GitHub / GitLab REST APIs with your token to actually create the repo, scaffold files, create branches, and apply branch protection.
- **Simulate mode** — a dry run that asks the LLM to produce a realistic plan without creating anything.
- **Multi-LLM support** — works with **Anthropic (Claude)** and **OpenAI (ChatGPT)** through a single provider abstraction.
- **AI best-practice audit** — a DevSecOps review of your config against GitHub/GitLab + Terraform/OpenTofu best practices, with severity-rated findings (`critical → info`) and concrete recommendations.
- **Security posture score** — a weighted 0–100 score with dependency-aware policy toggles (e.g. CODEOWNERS requires branch protection).
- **Branch presets** — GitFlow, Trunk-based, or Env-based, plus custom branches and per-branch protection.
- **File scaffolding** — README, `.gitignore`, `.terraformignore`, `terraform/` (`main.tf`, `versions.tf`, optional `backend.tf`), per-branch `environments/<branch>/`, plus optional `.github/` policies and CI workflows. Empty stubs (`variables.tf`, `outputs.tf`), placeholder OIDC workflow, and bare `modules/` / `environments/` folders are omitted.
- **Built-in security handling** — masked secret inputs with show/hide, secret redaction in logs, and a local secret-leak scan on form fields.
- **Export config** — download the (secret-free) configuration as JSON.

---

## What gets created (real mode)

When you run in **Create for real** mode, the app performs the following against your provider:

| Step | GitHub | GitLab |
|------|--------|--------|
| Create repo | `POST /orgs/{org}/repos` (falls back to `/user/repos`) | `POST /projects` (resolves namespace/group) |
| Scaffold files | single commit via Git Data API (tree → commit → ref) | single commit via the Commits API |
| Create branches | `POST /git/refs` per branch | `POST /repository/branches` per branch |
| Branch protection | `PUT /branches/{b}/protection` (+ required signatures) | `POST /protected_branches` |
| Secret scanning | `PATCH /repos/{o}/{r}` security settings | n/a |

Calls that require elevated permissions (branch protection, org security settings) fail gracefully and are logged as warnings rather than aborting the run.

---

## Requirements

See **[REQUIREMENTS.md](./REQUIREMENTS.md)** for full system setup (Node, npm, Git, browser, tokens, and install commands per OS).

**Summary:**

- **Node.js** ≥ 20 and **npm** ≥ 10 (see `.nvmrc` / `.node-version`)
- **Git** — to clone this repo
- A **modern browser** with internet access
- For **real** repository creation: a Git provider **personal access token**
  - **GitHub** — `repo` scope (and admin on the target org/repo for branch protection).
  - **GitLab** — `api` scope.
- For the **AI audit** or **simulate** mode: an API key for your chosen LLM
  - **Anthropic** — `sk-ant-...`
  - **OpenAI** — `sk-...`

> The AI key is **optional**. Real repo creation only needs the Git token + owner.

### Dependencies

| Package | Version |
|---------|---------|
| react / react-dom | ^19.2 |
| vite | ^8.0 |
| @vitejs/plugin-react | ^6.0 |

Tabler icons are loaded from a CDN in `index.html`.

---

## Project structure

```
project-deployer/
├── iac-repo-configurator.jsx   # the entire app (component + provider/LLM logic)
├── index.html                  # HTML entry; loads Tabler icons
├── vite.config.js              # Vite + React config (port 5173)
├── package.json
├── REQUIREMENTS.md             # system prerequisites & install guide
├── .nvmrc / .node-version      # Node 20 pin
├── .gitignore
└── src/
    ├── main.jsx                # mounts <App/>, stubs the global sendPrompt()
    └── styles.css              # design tokens (--color-*) + base element styles
```

---

## Running the app

```bash
# 1. Install dependencies
npm install

# 2. Start the dev server (auto-opens the browser)
npm run dev
```

Then open **http://localhost:5173/**.

### Production build

```bash
npm run build     # outputs to dist/
npm run preview   # serve the production build locally
```

---

## Using the wizard

1. **Provider** — choose GitHub or GitLab, paste your personal access token and org/username. Optionally configure the AI reviewer (provider, model, API key).
2. **Project details** — repository name (auto-slugified), description, and visibility.
3. **Branch strategy** — pick a preset, add custom branches, toggle which branches are protected.
4. **Security & policies** — enable IaC/security controls; watch the posture score update. Use **Recommended** for a sensible baseline.
5. **Review & create** — review the summary, optionally run the **AI best-practice audit**, choose **Create for real** or **Simulate**, then create.

---

## Security notes

- API keys and tokens are kept **in memory for the session only** — never persisted to disk or `localStorage`.
- Secrets are **redacted from the activity log** (both known values and pattern matches like `ghp_…`, `glpat-…`, `sk-…`, AWS keys, PEM blocks).
- The config sent to the LLM is **secret-free** (the token is only reported as `"provided"`/`"missing"`).

> ⚠️ **Browser-direct calls**: in this setup, requests to `api.github.com`, `gitlab.com`, `api.anthropic.com`, and `api.openai.com` are made directly from the browser, so your token/key lives client-side. This is fine for local/personal use. For team or production deployments, put a small backend proxy in front so secrets never reach the browser, and be aware that some providers restrict browser-origin (CORS) requests.

---

## Troubleshooting

- **"Create repo failed — 401/403"** — check the token scopes and that the owner is correct.
- **Branch protection logged as `⚠`** — you likely lack admin rights on the repo/org, or the feature needs GitHub Advanced Security. The repo is still created.
- **AI audit/create fails with a CORS or network error** — the provider may be blocking browser-origin requests; use a backend proxy.
- **Icons not showing** — ensure you have network access (Tabler icons load from a CDN in `index.html`).
