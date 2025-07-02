# Contact Form Worker

A Cloudflare Worker that handles form submissions from the ezdev.lol contact form and sends emails via SendGrid.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up environment variables:
   ```bash
   # Set your SendGrid API key
   wrangler secret put EMAIL_API_KEY
   
   # Set the recipient email (defaults to theo@ezdev.lol)
   wrangler secret put RECIPIENT_EMAIL
   ```

3. Deploy the worker:
   ```bash
   npm run deploy
   ```

## Development

Run the worker locally:
```bash
npm run dev
```

## Configuration

The worker expects the following environment variables:

- `EMAIL_API_KEY`: Your SendGrid API key
- `RECIPIENT_EMAIL`: The email address to send form submissions to (optional, defaults to theo@ezdev.lol)

## Form Fields

The worker accepts the following form fields:

- `name` (required): Contact's name
- `email` (required): Contact's email address
- `service` (required): Type of service requested
- `dateRange` (optional): Project timeline
- `minBudget` (required): Minimum budget
- `maxBudget` (required): Maximum budget
- `currency` (required): Currency code (e.g., USD)
- `message` (required): Project description (minimum 50 characters)

## API Endpoint

The worker responds to POST requests with form data and returns JSON responses:

### Success Response
```json
{
  "success": true,
  "message": "Form submitted successfully"
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error message"
}
```

## CORS

The worker includes CORS headers to allow cross-origin requests from the ezdev.lol website.