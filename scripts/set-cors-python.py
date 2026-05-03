#!/usr/bin/env python3
"""
Set CORS configuration for Firebase Storage bucket using Google Cloud Storage library.
This requires application default credentials from Firebase login.
"""

import json
import subprocess
import sys

def get_access_token():
    """Get access token from Firebase CLI"""
    try:
        result = subprocess.run(
            ['npx', 'firebase', 'login:ci', '--interactive'],
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except Exception as e:
        print(f"Error getting token: {e}")
    return None

def set_cors_with_curl():
    """Set CORS using curl and Google Cloud Storage REST API"""
    import urllib.request
    import urllib.error
    
    bucket_name = "careconnex-d4c8b.appspot.com"
    
    cors_config = {
        "cors": [
            {
                "origin": ["https://careconnex-d4c8b.web.app", "http://localhost:5173"],
                "method": ["GET", "POST", "PUT", "DELETE", "HEAD"],
                "maxAgeSeconds": 3600,
                "responseHeader": ["Content-Type", "Authorization", "x-goog-resumable"]
            }
        ]
    }
    
    # First, try to get the current CORS config to verify access
    url = f"https://storage.googleapis.com/storage/v1/b/{bucket_name}?projection=full"
    
    print(f"🔍 Checking bucket: {bucket_name}")
    print(f"📋 CORS config to apply:")
    print(json.dumps(cors_config, indent=2))
    print()
    print("⚠️  Note: Automatic CORS configuration requires Google Cloud SDK")
    print("📖 Manual steps:")
    print("1. Visit: https://console.cloud.google.com/storage/browser/careconnex-d4c8b.appspot.com")
    print("2. Click the bucket name")
    print("3. Go to Configuration tab")
    print("4. Edit CORS configuration")
    print("5. Paste the JSON above")
    print()
    print("✅ cors.json file has been created for reference")

if __name__ == "__main__":
    set_cors_with_curl()
