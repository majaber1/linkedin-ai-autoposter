# SignalPost Multi-Channel Foundation Release

## Summary

This release evolves SignalPost from a LinkedIn-shaped dashboard into a bilingual, channel-neutral content operations foundation while preserving the verified LinkedIn publisher and human approval model.

## UX and design improvements

- Global Arabic/English locale control with document-level RTL/LTR.
- Channel management view with honest connected, export-ready, and planned states.
- Logical-position CSS for the locale control and restrained dialog/card interactions.
- Arabic navigation and primary composer terminology without altering technical values.

## Functional changes

- Added a centralized channel capability registry for LinkedIn, Reddit, Meetup, Instagram, TikTok, YouTube, editorial publications, and owned technology sites.
- Added authenticated `/api/channels` discovery.
- Retained explicit approval and LinkedIn-only publishing until each connector is verified.
- Kept durable content pillars, workspace defaults, structured Vercel logging, and optional Sentry forwarding.

## Verification

- `npm run check`
- `npm test`
- Local demo startup and `/api/health`
- Desktop and mobile browser inspection in English and Arabic
- Console error inspection

## Known limitations

- Permanent LinkedIn OAuth requires a custom domain; the current temporary token remains active.
- Reddit, Meetup, Instagram, TikTok, and YouTube require provider apps, account authorization, and connector-specific implementation.
- Video publishing requires upload, validation, storage, transcoding, thumbnail, caption, and rights workflows.
- Multi-user organizations/RBAC are intentionally deferred to Phase 2.

## Local run

```bash
npm ci
# set DEMO_MODE=true in a local .env
npm start
```

Deployment remains ready for Vercel with PostgreSQL and the documented environment variables.
