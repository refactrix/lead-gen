# Refactrix Lead Pipeline

An automated pipeline that scrapes local business leads, audits their websites with AI, and generates personalized cold email drafts — all stored in Supabase.

## How It Works

```
Scraper → Supabase → Analyzer → Email Generator → Review & Send
```

1. **Scraper** — finds local businesses via Google Maps using Playwright
2. **Analyzer** — fetches each website's HTML and audits it using the NVIDIA API (Qwen model), scoring it 1–10 for opportunity
3. **Email Generator** — drafts a personalized cold email for each high-scoring lead using Groq (Llama 3.1)

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
SUPABASE_KEY=your_supabase_anon_key
NVIDIA_API_KEY=your_nvidia_api_key
GROQ_API_KEY=your_groq_api_key
```

| Variable | Where to get it |
|---|---|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `SUPABASE_KEY` | Supabase dashboard → Project Settings → API |
| `NVIDIA_API_KEY` | [integrate.api.nvidia.com](https://integrate.api.nvidia.com) |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) |

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
| `email_subject` | text |
| `email_body` | text |
| `email_status` | text (`pending` / `processing` / `ready` / `failed`) |
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
| NVIDIA API (Qwen) | Website audit and scoring |
| Groq (Llama 3.1) | Cold email generation (free) |
| Node.js | Runtime |