#!/usr/bin/env node

// Pre-deployment checklist. Reports what is configured and what is missing
// for the target you are deploying to.

const serverless = Boolean(process.env.VERCEL);
const rows = [
  ['OPENAI_API_KEY', process.env.OPENAI_API_KEY, 'AI drafts (falls back to the demo generator)'],
  ['GITHUB_CLIENT_ID', process.env.GITHUB_CLIENT_ID, 'dashboard sign-in'],
  ['GITHUB_CLIENT_SECRET', process.env.GITHUB_CLIENT_SECRET, 'dashboard sign-in'],
  ['GITHUB_REDIRECT_URI', process.env.GITHUB_REDIRECT_URI, 'OAuth callback in production'],
  ['ALLOWED_GITHUB_USERS', process.env.ALLOWED_GITHUB_USERS, 'dashboard owner allowlist'],
  ['LINKEDIN_CLIENT_ID', process.env.LINKEDIN_CLIENT_ID, 'LinkedIn OAuth connection'],
  ['LINKEDIN_CLIENT_SECRET', process.env.LINKEDIN_CLIENT_SECRET, 'LinkedIn OAuth connection'],
  ['LINKEDIN_REDIRECT_URI', process.env.LINKEDIN_REDIRECT_URI, 'LinkedIn OAuth callback'],
  ['LINKEDIN_TOKEN_ENCRYPTION_KEY', process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY, 'encrypted token storage'],
  ['LINKEDIN_ACCESS_TOKEN', process.env.LINKEDIN_ACCESS_TOKEN, 'publishing'],
  ['LINKEDIN_PERSON_URN', process.env.LINKEDIN_PERSON_URN, 'publishing'],
  ['DATABASE_URL', process.env.DATABASE_URL, serverless ? 'REQUIRED on serverless' : 'optional; enables Postgres'],
  ['AUTOMATION_API_KEY', process.env.AUTOMATION_API_KEY, 'n8n and cron automation'],
  ['NODE_ENV=production', process.env.NODE_ENV === 'production' || undefined, 'secure cookies, disables demo mode']
];

console.log('SignalPost deployment check\n');
for (const [name, value, why] of rows) {
  console.log(`  ${value ? 'set    ' : 'missing'}  ${name.padEnd(22)} ${why}`);
}

const blocking = [];
if (serverless && !process.env.DATABASE_URL) blocking.push('DATABASE_URL is required on Vercel: posts and sessions cannot use the filesystem.');
if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_GITHUB_USERS) blocking.push('ALLOWED_GITHUB_USERS is required in production or no dashboard user can sign in.');
if (process.env.LINKEDIN_CLIENT_ID && (!process.env.LINKEDIN_CLIENT_SECRET || !process.env.LINKEDIN_REDIRECT_URI || !process.env.LINKEDIN_TOKEN_ENCRYPTION_KEY)) blocking.push('LinkedIn OAuth configuration is incomplete.');
if (process.env.DEMO_MODE === 'true' && process.env.NODE_ENV === 'production') blocking.push('DEMO_MODE is ignored in production. Configure GitHub OAuth instead.');

console.log(blocking.length ? `\nBlocking:\n${blocking.map(line => `  - ${line}`).join('\n')}` : '\nNothing blocking.');
console.log('\nHosts: Railway, Fly.io, Render, or a container work with the filesystem driver.');
console.log('Vercel and other serverless hosts need DATABASE_URL.');
