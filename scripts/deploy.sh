#!/bin/bash

# Deployment Script for CareConnex

echo "🚀 Starting Deployment Process..."

# 1. Build the application
echo "📦 Building React Application..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build Failed! Aborting."
    exit 1
fi

# 2. Deploy to Firebase
echo "🔥 Deploying to Firebase Hosting..."
# firebase deploy --only hosting

echo "✅ Build complete. Run 'firebase deploy' to publish."
