# Enterprise recommendations — IaC Repository Configurator

Assessment of the current stack and a practical path to an enterprise-ready product.

---

## Current stack (summary)

| Layer | Choice |
|-------|--------|
| UI | React 19 + Vite 8 |
| Structure | Single ~1,300-line `iac-repo-configurator.jsx` |
| Styling | Inline styles + CSS variables; Tabler icons from CDN |
| Backend | None |
| Git / LLM | Browser → GitHub, GitLab, Anthropic, OpenAI APIs directly |
| Types / tests | No TypeScript; no automated test suite |

---

## What works well

- **React + Vite** — mainstream, fast dev experience, easy static deployment, widely understood by enterprise teams.
- **Multi-provider LLM abstraction** (Claude + OpenAI) — good flexibility for audit and simulate modes.
- **Real Git provider API integration** — correct direction for a deployer (not simulation-only).
- **Separation from Terraform generation API** — repo bootstrap vs `.tf` content is a sound enterprise split.

---

## Gaps for enterprise use

### 1. No backend (highest priority)

Users paste PATs and LLM keys in the browser; calls go directly to provider APIs from the client.

**Enterprise risks:**

- Secrets exposed in the browser (DevTools, extensions, XSS)
- No SSO / RBAC / audit trail of who created what
- CORS and provider policies may break in locked-down networks
- No job queue for long repo setup (branch protection, Dependabot cleanup, etc.)
- Hard to integrate with Vault, AWS Secrets Manager, or corporate identity

**Recommendation:** Add a backend API (NestJS, Fastify, Go, or FastAPI) that holds service credentials or exchanges SSO for short-lived tokens.

### 2. Monolithic single file

Fine for a demo; weak for enterprise maintenance — hard to review, test, and assign ownership. UI, Git client, LLM, and provisioning logic are coupled.

**Recommendation:** Split into modules or packages (`/api`, `/services/github`, `/services/llm`, `/components`, `/hooks`).

### 3. No TypeScript

Enterprise teams usually expect typed contracts for Git API payloads, wizard state, and LLM JSON schemas.

**Recommendation:** Adopt TypeScript + Zod for validation as the wizard grows.

### 4. Inline styles + CDN assets

Works for a prototype; enterprises often require a design system, self-hosted assets (no CDN dependency in air-gapped networks), and accessibility / i18n.

**Recommendation:** Design system (Tailwind + shadcn/ui, MUI, or company component library); self-host Tabler or equivalent icons.

### 5. LLM-only policy checks

LLM audit is useful but should not be the sole source of truth for compliance.

**Recommendation:** Deterministic rules (OPA/Rego, Checkov, custom validators); keep LLM as an advisory layer on top.

### 6. Personal access tokens

PATs do not scale in enterprise — tied to individuals, hard to rotate and audit, and org admins dislike users pasting tokens into internal tools.

**Recommendation:** GitHub App, GitLab OAuth / group access tokens, or org-scoped service accounts.

### 7. Missing enterprise operations

No tests, CI, structured logging, metrics, feature flags, multi-tenancy, or idempotent provisioning jobs with retry.

**Recommendation:** Vitest + Playwright, audit logging (who, what, when), and async job processing for repo creation.

---

## Target architecture (evolution)

```
┌─────────────────────────────────────────────────────────┐
│  Frontend: React + TypeScript + Vite                    │
│  UI: design system (e.g. shadcn/ui)                     │
│  State: TanStack Query + Zod validation                 │
└───────────────────────┬─────────────────────────────────┘
                        │ HTTPS (SSO session / JWT)
┌───────────────────────▼─────────────────────────────────┐
│  Backend: NestJS / Fastify (Node) or Go                   │
│  - GitHub App / GitLab OAuth                              │
│  - Secrets from Vault / AWS Secrets Manager               │
│  - Job queue (BullMQ / Temporal) for repo provisioning  │
│  - Audit log                                              │
└───────────────────────┬─────────────────────────────────┘
                        │
        ┌───────────────┼───────────────┐
        ▼               ▼               ▼
   GitHub/GitLab    LLM gateway     Terraform generation API
   REST/GraphQL     (server-side)   (existing service)
```

---

## Alternatives by area

| Area | Alternative | When it's better |
|------|-------------|------------------|
| Frontend | **Next.js** (App Router) | SSR, API routes, SSO middleware in one repo |
| Backend | **Go + chi/fiber** | High throughput, simple deploy, strong for platform teams |
| Repo provisioning | **Terraform/Pulumi** as engine | Git repos as side effect of IaC modules |
| Git integration | **GitHub App + webhooks** | Org-wide install, fine-grained permissions |
| LLM | **LiteLLM / Azure OpenAI / Bedrock** | Single gateway, compliance, no keys in UI |
| Policy | **OPA + Checkov** (deterministic) | Auditable, no hallucination risk |
| Auth | **OIDC** (Okta / Azure AD) | Standard enterprise SSO |

---

## Verdict

| Question | Answer |
|----------|--------|
| Is React + Vite wrong? | **No** — keep them for the UI. |
| Is the current setup enterprise-ready? | **Not yet** — mainly client-side secrets, no backend/auth/audit, monolithic structure. |
| Best single upgrade? | **Backend proxy** + **GitHub App/OAuth** + **TypeScript split**. |

---

## Recommended roadmap (priority order)

1. **Backend proxy** for Git + LLM; remove PAT/API keys from the browser
2. **GitHub App / GitLab OAuth** instead of user PATs
3. **Split the monolith** + **TypeScript** + **Zod** validation
4. **Job queue** for async repo creation with status polling
5. **Deterministic policy engine**; keep LLM as advisory audit only
6. **Tests + CI** (Vitest, Playwright) and **audit logging**
7. **Design system** + self-hosted assets for air-gapped deployments

---

## Related docs

- [README.md](./README.md) — features and usage
- [REQUIREMENTS.md](./REQUIREMENTS.md) — local setup prerequisites
