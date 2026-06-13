# System requirements — IaC Repository Configurator

Everything you need installed locally to run this app without issues.

---

## Quick checklist

| Requirement | Minimum | Recommended | Required for |
|-------------|---------|-------------|--------------|
| **Node.js** | 20.x | 20 LTS (latest) | Running the app |
| **npm** | 10.x | 10+ (ships with Node 20) | Installing packages |
| **Git** | 2.30+ | Latest | Cloning the repo |
| **Modern browser** | Chrome 100+, Firefox 100+, Safari 15+, Edge 100+ | Latest | UI + API calls |
| **Internet** | — | Stable connection | npm install, CDN icons, Git/LLM APIs |

Optional (not required to run the UI):

| Optional | Purpose |
|----------|---------|
| **nvm** / **fnm** / **volta** | Pin Node 20 via `.nvmrc` / `.node-version` |
| **GitHub PAT** (`ghp_…`) | Create repos on GitHub (real mode) |
| **GitLab PAT** (`glpat-…`) | Create repos on GitLab (real mode) |
| **Anthropic API key** | AI audit / simulate mode (Claude) |
| **OpenAI API key** | AI audit / simulate mode (ChatGPT) |

---

## 1. Install Node.js & npm

The app uses **Vite 8** and **React 19**. Use **Node 20 LTS** or newer.

### macOS

```bash
# Option A — Homebrew (recommended)
brew install node@20
echo 'export PATH="/opt/homebrew/opt/node@20/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# Option B — nvm (matches .nvmrc in this repo)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.zshrc
nvm install
nvm use
```

### Linux (Debian/Ubuntu)

```bash
# NodeSource Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Or nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install
nvm use
```

### Windows

```powershell
# winget
winget install OpenJS.NodeJS.LTS

# Or nvm-windows: https://github.com/coreybutler/nvm-windows
# Then: nvm install 20 && nvm use 20
```

### Verify

```bash
node -v    # expect v20.x.x or higher
npm -v     # expect 10.x.x or higher
```

---

## 2. Install Git

Needed to clone and work with this repository.

### macOS

```bash
xcode-select --install
# or: brew install git
```

### Linux

```bash
sudo apt-get update && sudo apt-get install -y git
```

### Windows

```powershell
winget install Git.Git
```

### Verify

```bash
git --version
```

---

## 3. Clone & install project dependencies

```bash
git clone <your-repo-url> project-deployer
cd project-deployer

# If using nvm/fnm, Node 20 is picked up automatically from .nvmrc
npm install
```

This installs everything from `package.json`:

| Package | Role |
|---------|------|
| `react`, `react-dom` | UI framework |
| `vite` | Dev server & build tool |
| `@vitejs/plugin-react` | React support for Vite |

Tabler icons are loaded from a CDN in `index.html` (no npm package).

---

## 4. Run the app

```bash
npm run dev
```

Open **http://localhost:5173/** (Vite may auto-open the browser).

Production build:

```bash
npm run build
npm run preview
```

---

## 5. Runtime credentials (wizard usage)

These are **not** installed on your system — you paste them in the UI when using the wizard.

### Git provider token (real repo creation)

| Provider | Token type | Scopes |
|----------|------------|--------|
| **GitHub** | Personal access token (classic or fine-grained) | `repo` (full control of private repos) |
| **GitLab** | Personal access token | `api` |

For branch protection and org security settings you also need **admin** rights on the target org/repo.

Create tokens:

- GitHub: https://github.com/settings/tokens  
- GitLab: https://gitlab.com/-/user_settings/personal_access_tokens  

### AI reviewer keys (optional)

| Provider | Key format | Used for |
|----------|------------|----------|
| **Anthropic** | `sk-ant-…` | AI audit, simulate mode |
| **OpenAI** | `sk-…` | AI audit, simulate mode |

Real repo creation works with **Git token + owner only** — no AI key required.

---

## 6. Network & browser requirements

The app must reach:

| Host | Why |
|------|-----|
| `registry.npmjs.org` | `npm install` |
| `cdn.jsdelivr.net` | Tabler icons (UI) |
| `api.github.com` | GitHub repo creation (real mode) |
| `gitlab.com` | GitLab repo creation (real mode) |
| `api.anthropic.com` | Claude audit/simulate (optional) |
| `api.openai.com` | ChatGPT audit/simulate (optional) |

Use a current browser with JavaScript enabled. Disable strict extensions that block cross-origin requests if Git/LLM API calls fail.

---

## 7. Version pin files in this repo

| File | Purpose |
|------|---------|
| `.nvmrc` | Node 20 for **nvm** users |
| `.node-version` | Node 20 for **fnm** / **asdf** users |
| `package.json` → `engines` | Documents minimum Node 20 / npm 10 |

---

## 8. Troubleshooting setup

| Problem | Fix |
|---------|-----|
| `node: command not found` | Install Node 20 (see §1) |
| `npm install` fails with EACCES | Avoid `sudo npm`; fix npm prefix or use nvm |
| Wrong Node version | Run `nvm use` or install Node 20 |
| Port 5173 in use | Stop other Vite apps or change port in `vite.config.js` |
| Blank page, no icons | Check internet; CDN may be blocked |
| `engine` warning from npm | Upgrade to Node ≥ 20 and npm ≥ 10 |

---

## Minimum one-liner (macOS with Homebrew)

```bash
brew install node@20 git && cd project-deployer && npm install && npm run dev
```
