#!/bin/bash

# Deploy script for contact form worker

echo "🚀 Deploying Contact Form Worker..."

# Check if wrangler is installed
if ! command -v wrangler &> /dev/null; then
    echo "❌ Wrangler CLI not found. Please install it first:"
    echo "pnpm install -g wrangler"
    exit 1
fi

# Check if user is logged in
if ! wrangler whoami &> /dev/null; then
    echo "🔐 Please log in to Cloudflare first:"
    echo "wrangler login"
    exit 1
fi

# Install dependencies if node_modules doesn't exist
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    pnpm install
fi

# Check if secrets are set
echo "🔍 Checking required secrets..."

# Check MAILGUN_API_TOKEN
if ! wrangler secret list | grep -q "MAILGUN_API_TOKEN"; then
    echo "⚠️  MAILGUN_API_TOKEN secret not found."
    echo "Please set it with: wrangler secret put MAILGUN_API_TOKEN"
    read -p "Do you want to set it now? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        wrangler secret put MAILGUN_API_TOKEN
    else
        echo "❌ MAILGUN_API_TOKEN is required for the worker to function."
        exit 1
    fi
fi

# Deploy the worker
echo "🚀 Deploying worker..."
wrangler deploy

if [ $? -eq 0 ]; then
    echo "✅ Worker deployed successfully!"
    echo ""
    echo "📋 Next steps:"
    echo "1. Update the form action URL in newproject.astro with your worker URL"
    echo "2. Test the form submission"
    echo ""
    echo "🔗 Your worker URL will be displayed above."
else
    echo "❌ Deployment failed!"
    exit 1
fi