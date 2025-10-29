# Contact Form Worker

A Cloudflare Worker that handles contact form submissions with Mailgun email delivery and rate limiting.

## Features

- **SMTP Integration**: Sends emails via Cloudflare Worker to Migadu's SMTP port instead of Cloudflare Email
- **Rate Limiting**: Prevents abuse with IP-based rate limiting
- **CORS Support**: Handles preflight requests for web forms
- **Automatic Deployment**: GitHub Actions workflow for CI/CD

## Setup

### 1. SMTP Configuration

```bash
wrangler secret put EMAIL_USERNAME
wrangler secret put EMAIL_PASSWORD
```

Optional:
```bash
wrangler secret put RECIPIENT_EMAIL  # defaults to dev@joinez.co
```

### 2. Rate Limiting

The worker uses Cloudflare's rate limiting API with two separate limiters:
- `IP_RATE_LIMITER`: Limits requests by client IP (namespace_id: 1001)

Both are configured for 1 request per hour (3600 seconds).

### 3. GitHub Actions Deployment

The repository includes a GitHub Actions workflow that automatically deploys the worker when changes are made to the contact form code.

Required GitHub secrets:
- `CLOUDFLARE_API_TOKEN`: Your Cloudflare API token
- `CLOUDFLARE_ACCOUNT_ID`: Your Cloudflare account ID

The worker secrets (MAILGUN_API_TOKEN, etc.) should be set directly in Cloudflare using `wrangler secret put`.

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Deploy manually
npm run deploy

# View logs
npm run tail
```

## API

### POST /

Accepts form data with the following fields:

**Required:**
- `name`: Contact name
- `email`: Contact email
- `service`: Service type
- `minBudget`: Minimum budget
- `maxBudget`: Maximum budget
- `currency`: Currency code
- `message`: Message (minimum 50 characters)

**Optional:**
- `dateRange`: Project timeline

### Response Format

Success:
```json
{
  "success": true,
  "message": "Form submitted successfully"
}
```

Error:
```json
{
  "success": false,
  "error": "Error description"
}
```

### Rate Limiting

When rate limited, returns HTTP 429 with:
```json
{
  "success": false,
  "error": "Rate limit exceeded. Please try again later."
}
```

## CORS

The worker supports CORS for the following origins:
- `https://joinez.co`
- `https://www.joinez.co`

## Email Format

Emails are sent via Cloudflare Worker to Migadu's SMTP port with:
- **From**: `Mailatron 9000 <mailatron@mail.joinez.co>`
- **To**: `{RECIPIENT_EMAIL}` (default: dev@joinez.co)
- **Subject**: `[new project] [{service}] for {name}`
- **Reply-To**: Contact's email address