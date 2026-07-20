# linkedin-ai-autoposter

Daily AI-generated LinkedIn post automation using GitHub Actions with a beautiful web dashboard.

## ✨ Features

- 🤖 **AI-Powered Posts** - Uses OpenAI GPT-3.5 to generate on-brand LinkedIn content
- 🔐 **GitHub OAuth** - Secure authentication via GitHub (no passwords)
- 📊 **Beautiful Dashboard** - Modern web UI to view, generate, and manage posts
- 🚀 **Test Mode** - Generate and preview posts without publishing
- 📋 **Topic Rotation** - Automatically rotates through predefined topics
- 📝 **Post History** - All generated posts saved as permanent history
- ⏰ **Scheduled Automation** - GitHub Actions workflow runs on daily schedule
- 🔄 **Zero Config** - Works out of the box with test/dummy mode

## 🚀 Quick Start

### 1. Local Development

```bash
# Clone and install
git clone https://github.com/majaber1/linkedin-ai-autoposter.git
cd linkedin-ai-autoposter
npm install

# No credentials needed for test mode!
npm start
```

Visit `http://localhost:3000`

### 2. GitHub OAuth Setup (Required for Web Dashboard)

1. Go to https://github.com/settings/developers → **OAuth Apps** → **New OAuth App**
2. Fill in:
   - **Application name:** `LinkedIn AI Autoposter`
   - **Homepage URL:** `http://localhost:3000`
   - **Authorization callback URL:** `http://localhost:3000/auth/github/callback`
3. Copy **Client ID** and **Client Secret**
4. Create `.env` file:
   ```bash
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```

### 3. Optional: Real LinkedIn Publishing

To publish actual posts to LinkedIn:

1. Go to **GitHub Repo** → **Settings** → **Secrets and variables** → **Actions**
2. Add these secrets:
   - `OPENAI_API_KEY` - Get from https://platform.openai.com/api-keys
   - `LINKEDIN_ACCESS_TOKEN` - Create OAuth token at https://www.linkedin.com/developers
   - `LINKEDIN_PERSON_URN` - Your LinkedIn member URN (e.g., `urn:li:person:12345`)

## 📖 How It Works

### Web Dashboard

1. **Sign in** with GitHub OAuth
2. **View dashboard** with:
   - Total posts generated
   - Number of topics available
   - Next topic to be posted
   - Full post history with previews
3. **Generate post** - Click "Generate & Preview" button
4. In test mode, posts are saved locally without publishing to LinkedIn

### Automated Workflow

The GitHub Actions workflow (`daily-post.yml`) runs on schedule:

1. **Triggers daily** at 9:00 AM UTC (customizable)
2. **Fetches next topic** from `content/topics.json`
3. **Generates content** using OpenAI API
4. **Publishes to LinkedIn** (if credentials configured)
5. **Commits post history** to the repo
6. **Increments index** for next post topic

## 📁 Project Structure

```
.
├── frontend/
│   └── index.html           # Web dashboard UI
├── server/
│   └── index.js             # Express server + OAuth + API endpoints
├── scripts/
│   └── generate-and-post.js # Core generation & publishing logic
├── content/
│   ├── topics.json          # Topic rotation list
│   ├── last_index.json      # Current topic index
│   └── posts/               # Generated posts history
├── .github/
│   └── workflows/
│       └── daily-post.yml   # Scheduled workflow
└── package.json
```

## 🔧 Configuration

### Topics (`content/topics.json`)

Edit the topics array to customize what gets posted:

```json
[
  {
    "slug": "landing-zone",
    "sector": "Landing Zone - All Sectors",
    "message": "PlayMotion is one interactive platform..."
  },
  {
    "slug": "education",
    "sector": "Education",
    "message": "How PlayMotion turns classrooms..."
  }
  // ... more topics
]
```

### Schedule (`cron` in `.github/workflows/daily-post.yml`)

Default: **9:00 AM UTC**

```yaml
on:
  schedule:
    - cron: '0 9 * * *'  # Change the 9 to your preferred hour (0-23 UTC)
```

## 🔐 Security

- ✅ No credentials stored in repo
- ✅ Secrets managed via GitHub Actions
- ✅ GitHub OAuth for authentication
- ✅ Test mode for safe local development
- ✅ Environment variable validation

## 📊 API Endpoints

| Method | Endpoint | Auth | Purpose |
|--------|----------|------|---------|
| GET | `/auth/me` | ✓ | Check auth status |
| GET | `/auth/github` | - | OAuth login redirect |
| GET | `/auth/github/callback` | - | OAuth callback |
| POST | `/auth/logout` | ✓ | Logout |
| GET | `/api/posts` | - | Get all posts |
| GET | `/api/topics` | - | Get topics & current index |
| POST | `/api/generate` | ✓ | Generate new post |
| PUT | `/api/topics` | ✓ | Update topics |

## 🛠️ Development

### Local Testing

```bash
npm start
# Visit http://localhost:3000
# Click "Sign in with GitHub" (uses your OAuth app from setup)
```

### Test Workflow Manually

In GitHub repo → Actions → Daily LinkedIn Post → "Run workflow" → Select "true" for test mode

### View Generated Posts

```bash
# All posts are saved to:
ls content/posts/
```

## 🚢 Deployment

### Heroku / Railway / Vercel

Set environment variables:
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `OPENAI_API_KEY` (optional, for real posting)
- `LINKEDIN_ACCESS_TOKEN` (optional)
- `LINKEDIN_PERSON_URN` (optional)

Update OAuth app callback URL to your production domain.

### Docker

```dockerfile
FROM node:18
WORKDIR /app
COPY . .
RUN npm install
CMD ["npm", "start"]
```

## 🤝 Contributing

Ideas for features:
- [ ] Post scheduling UI
- [ ] Topic editor in dashboard
- [ ] Tone/style selector
- [ ] Post preview before save
- [ ] Analytics dashboard
- [ ] Multi-account support

## ⚠️ Disclaimer

- This tool uses OpenAI API - costs may apply
- LinkedIn API rate limits apply
- Always review AI-generated content before publishing
- Test thoroughly before scheduling production posts

## 📝 License

MIT

## 🎯 Next Steps

1. **Fork this repo** (or clone)
2. **Register OAuth app** on GitHub (5 min)
3. **Set env variables** (.env or GitHub Secrets)
4. **Run locally** with `npm start`
5. **Optional:** Add OPENAI_API_KEY and LinkedIn credentials for real publishing
6. **Customize topics** in `content/topics.json`
7. **Deploy** to your hosting platform

---

**Made with ❤️ for automating professional content creation**
