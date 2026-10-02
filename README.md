# Refactrix Lead Pipeline

An automated pipeline that scrapes local business leads, audits their websites with AI, and generates personalized cold email drafts — all stored in Supabase.

## How It Works

```
Scraper → Supabase → Analyzer → Email Generator → Review & Send
```

1. **Scraper** — finds local businesses via Google Maps using Playwright
2. **Analyzer** — fetches each website's HTML, checks a few facts directly (HTTPS, title, meta description, viewport, language, H1, image alt text), then audits the page text with Groq (`openai/gpt-oss-20b`), scoring it 1–10 for opportunity
3. **Email Generator** — drafts a personalized cold email for each high-scoring lead using Groq (`openai/gpt-oss-20b`), led by the measured facts
4. **Sender** — `sendapproved.js` sends approved drafts, skipping anyone on the suppression list

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file in the root:

```env
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_secret_key
GROQ_API_KEY=your_groq_api_key
UNSUBSCRIBE_SECRET=same_value_as_on_vercel
```

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `SUPABASE_KEY` | Supabase dashboard → Project Settings → API keys — the **secret** (service role) key |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |
| `UNSUBSCRIBE_SECRET` | Generate once, set the same value here and in the website's Vercel project |

`sendapproved.js` refuses to run with an anon or publishable key: the `suppressions` table has RLS on, so that key would read it as empty and the opt-out check would silently pass.

Generate `UNSUBSCRIBE_SECRET` with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Database migrations

Run the files in `migrations/` in the Supabase SQL editor, oldest first. `2026-10-02_suppressions_and_attempts.sql` must be applied before running `analyzer.js`, `emailgen.js` or `sendapproved.js`.

### 3. Supabase table

Your `leads` table should have these columns:

| Column | Type |
|---|---|
| `id` | uuid |
| `business_name` | text |
| `website` | text |
| `email` | text |
| `phone` | text |
| `city` | text |
| `country` | text |
| `category` | text |
| `google_maps_url` | text |
| `domain` | text |
| `status` | text |
| `audit` | jsonb |
| `opportunity_score` | int |
| `audit_status` | text (`pending` / `processing` / `done` / `failed`) |
| `audit_attempts` | int (failed audits retry until 3) |
| `email_subject` | text |
| `email_body` | text (footer holds a `{{UNSUBSCRIBE_URL}}` placeholder filled at send time) |
| `email_status` | text (`pending` / `processing` / `ready` / `approved` / `sending` / `sent` / `failed` / `bounced` / `opted_out`) |
| `email_attempts` | int (failed drafts retry until 3) |
| `notes` | text |
| `contacted_at` | timestamp |
| `created_at` | timestamp |

---

## Usage

### Step 1 — Analyze websites

Fetches up to 20 pending leads, audits each website, and saves the audit + opportunity score.

```bash
node analyzer.js
```

- Skips leads where `audit_status` is not `pending` or `processing`
- Marks leads `failed` if the site returns 403 or the AI returns no valid JSON
- Adds a 1s delay between requests to avoid rate limiting

### Step 2 — Generate email drafts

Generates cold email drafts for leads with `audit_status = done`, `email_status = pending`, and `opportunity_score >= 6`.

```bash
node emailgen.js
```

- Uses Groq (free tier: 14,400 requests/day) — no cost
- Emails are saved to `email_subject` and `email_body` columns
- Status is updated to `ready` when done

---

## GitHub Actions

| Workflow | Trigger | Runs | Reaches the outside world |
|---|---|---|---|
| `process-leads.yml` | Every 4 hours, and manually | `analyzer.js`, then `emailgen.js` | No (database and Groq only) |
| `send-approved.yml` | Manually only, for now | `sendapproved.js`, up to the chosen batch size | **Yes, sends email** |

`scraper.js` and `emailscraper.js` still run locally. They need a browser, and the scraper's data source terms are being checked first.

In CI, `redact-logs.js` masks email addresses in all output (`i***@example.com`), because workflow logs are kept for 90 days and are public on a public repo. Scripts exit non-zero on database errors and failed sends, so GitHub emails a failure notice.

### Secrets and variables

Both workflows run in the **`Production` environment** (Settings → Environments → Production), and read their secrets and variables from there. Under "Deployment branches and tags", restrict it to `main` so a workflow on any other branch cannot read them.

Set them in the environment's "Environment secrets" / "Environment variables" sections, or with the GitHub CLI. `gh` prompts for each value, so values never appear in your shell history:

```bash
gh secret set SUPABASE_URL       --repo refactrix/lead-gen --env Production
gh secret set SUPABASE_KEY       --repo refactrix/lead-gen --env Production   # the secret key, not anon
gh secret set GROQ_API_KEY       --repo refactrix/lead-gen --env Production
gh secret set HOSTINGER_EMAIL    --repo refactrix/lead-gen --env Production
gh secret set HOSTINGER_PASSWORD --repo refactrix/lead-gen --env Production
gh secret set UNSUBSCRIBE_SECRET --repo refactrix/lead-gen --env Production   # same value as on Vercel

gh variable set CALENDAR_LINK    --repo refactrix/lead-gen --env Production --body "https://calendly.com/..."
gh variable set SEND_BATCH_LIMIT --repo refactrix/lead-gen --env Production --body "5"   # used by scheduled sends
```

### Running manually

```bash
gh workflow run process-leads.yml --repo refactrix/lead-gen
gh workflow run send-approved.yml --repo refactrix/lead-gen -f batch_limit=1
```

---

## Audit JSON Structure

Each analyzed lead stores an `audit` object in Supabase:

```json
{
  "performance_issues": ["slow page load", "unoptimized images"],
  "accessibility_issues": ["missing alt text"],
  "seo_issues": ["no meta description", "missing H1 tag"],
  "ai_readability_issues": ["unstructured content"],
  "overall_quality": "poor",
  "top_3_improvements": ["add meta tags", "compress images", "fix mobile layout"],
  "opportunity_score": 8
}
```

---

## Tech Stack

| Tool | Purpose |
|---|---|
| Playwright | Headless browser for scraping Google Maps |
| Supabase | Database for storing leads and results |
| Groq (`openai/gpt-oss-20b`) | Website audit, scoring and cold email generation |
| Nodemailer + Hostinger SMTP | Sending approved emails |
| Node.js | Runtime |