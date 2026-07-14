# linkedin-ai-autoposter

Daily AI-generated LinkedIn post automation using GitHub Actions.

## Goal
Automatically write and publish one on-brand LinkedIn post per day, with zero manual work, using AI for the copy and a scheduled GitHub Actions workflow for the publishing.

## How it works
1. A GitHub Actions workflow wakes up on a daily cron schedule (see .github/workflows/daily-post.yml).
2. It runs scripts/generate-and-post.js, which picks the next topic from content/topics.json and asks an AI model to write a short LinkedIn post about it.
3. The script publishes the generated text to LinkedIn via the LinkedIn API.
4. Every generated post is also saved under content/posts/ as a permanent log/history in this repo.

## Tech stack
- GitHub Actions (scheduler + runner)
- Node.js script (scripts/generate-and-post.js)
- OpenAI API for content generation
- LinkedIn API (UGC Posts / Share API) for publishing

## Setup (you do this yourself - no credentials live in this repo)
1. Go to this repo's Settings > Secrets and variables > Actions.
2. Add these repository secrets:
   - OPENAI_API_KEY - your OpenAI API key
   - LINKEDIN_ACCESS_TOKEN - a LinkedIn OAuth access token with the w_member_social scope
   - LINKEDIN_PERSON_URN - your LinkedIn member URN, e.g. urn:li:person:xxxxxxx
3. Review/edit content/topics.json to change the sectors, order, or messaging.
4. Make sure GitHub Actions is enabled for this repo (Actions tab).
5. Adjust the cron schedule in .github/workflows/daily-post.yml to your preferred posting time (it is in UTC).
6. Trigger the workflow manually once from the Actions tab (workflow_dispatch) to test before relying on the daily schedule.

## Content plan - initial post
The first post is themed "landing zone": PlayMotion introduced as one platform that acts as a single entry point adapting to many different sectors - Education, Sports, Fitness, Events, Museums & Experience Centers, and Gaming Zones. Later posts rotate through each sector in more depth. The draft lives in content/posts/initial-landing-zone-post.md.

## Disclaimer
No LinkedIn or OpenAI credentials are stored in this repository. You must supply your own API keys/tokens via GitHub Secrets for the automation to actually publish posts.
