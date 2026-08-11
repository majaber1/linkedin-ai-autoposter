# SignalPost Product Audit

Baseline: 2026-08-11, branch `feat/bilingual-ux-production-hardening`, based on `1468a12`.

## Architecture

SignalPost is a Node.js 20+ Express application with a dependency-free browser UI, OpenAI draft generation, PostgreSQL or filesystem persistence, GitHub OAuth, LinkedIn member publishing, image storage, scheduled GitHub Actions, automation APIs, and an MCP server. Vercel runs `server/index.js` as one serverless function. PostgreSQL stores posts, sessions, OAuth state, media, content pillars, and workspace settings.

## Module matrix

| Module | User purpose | Baseline status | Gap/root cause | Resolution and evidence |
| --- | --- | --- | --- | --- |
| Authentication | Restrict the workspace | Working for allow-listed GitHub users | No registration, recovery, or RBAC; product was owner-only | Preserve owner-only GitHub OAuth in Phase 1; document multi-user RBAC as Phase 2 |
| AI composer | Create English/Arabic drafts | Working | UI defaults and pillars were previously static | Durable workspace settings and pillars; generation consumes saved pillars |
| Review and approval | Human review before publication | Working | LinkedIn language in otherwise generic workflow | Preserve approval gate; introduce channel-neutral catalog and terminology |
| LinkedIn publishing | Publish approved text/image posts | Working with environment token | Permanent OAuth blocked because LinkedIn rejects `vercel.app` callback | Rotated secret, kept temporary token, documented custom-domain requirement |
| Other channels | Distribute to social/editorial destinations | Missing | No capability model; each network has different formats and API approval | Added channel registry with live/export/planned states and format metadata |
| Scheduling | Publish approved due posts | Working | LinkedIn-only executor | Keep executor scoped to LinkedIn until connector contract exists |
| Content pillars | Manage content strategy | Working | Previously visual-only | CRUD persisted in `app_state`; browser verified |
| Settings | Manage drafting defaults | Working | Previously visual-only | Durable audience, tone, objective, and language defaults |
| Arabic/RTL | Use product in Arabic | Partial | Generated content changed language but most interface text stayed English | Application-level locale switch, `lang`/`dir`, Arabic dictionary, logical positioning |
| Media | Attach accessible images | Working | No video pipeline for media-first channels | Preserve image path; video/transcoding remains a future connector requirement |
| Monitoring | Diagnose production failures | Working | No external error tracker configured | Structured Vercel errors plus optional Sentry envelope forwarding |
| Tests/CI | Prevent regressions | Working | Coverage is concentrated on security/generation | Existing 16 tests retained; channel registry added to syntax checks |

## Product boundary

Phase 1 is an owner-operated multi-channel content studio. It creates and manages canonical content, exposes destination capabilities, publishes only through verified connectors, and supports copy-ready editorial exports. Phase 2 adds organizations, account ownership, roles, invitations, per-channel credentials, approval policies, and audit logs. No planned connector is represented as working before its official API contract and credentials are tested.

## External requirements

- A custom domain accepted by LinkedIn for permanent OAuth.
- Reddit, Meetup, Meta/Instagram, TikTok, and YouTube developer applications and approvals.
- A video asset pipeline before short-form video publishing.
- A Sentry DSN only if external error aggregation is desired; Vercel Runtime Logs already operate.
