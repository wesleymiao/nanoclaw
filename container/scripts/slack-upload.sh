#!/bin/bash
# Upload a file to the current Slack channel.
# Usage: slack-upload.sh <file-path> [title]
#
# Requires SLACK_BOT_TOKEN and SLACK_CHANNEL_ID env vars (injected by NanoClaw).

set -euo pipefail

FILE="$1"
TITLE="${2:-$(basename "$FILE")}"

if [ -z "${SLACK_BOT_TOKEN:-}" ] || [ -z "${SLACK_CHANNEL_ID:-}" ]; then
  echo "Error: SLACK_BOT_TOKEN and SLACK_CHANNEL_ID must be set" >&2
  exit 1
fi

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE" >&2
  exit 1
fi

# Slack files.uploadV2 requires a two-step process:
# 1. Get an upload URL
# 2. Upload the file to that URL
# 3. Complete the upload

FILESIZE=$(stat -c%s "$FILE" 2>/dev/null || stat -f%z "$FILE" 2>/dev/null)
FILENAME=$(basename "$FILE")

# Step 1: Get upload URL
RESPONSE=$(curl -s -X POST "https://slack.com/api/files.getUploadURLExternal" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -d "filename=$FILENAME" \
  -d "length=$FILESIZE")

OK=$(echo "$RESPONSE" | grep -o '"ok":true' || true)
if [ -z "$OK" ]; then
  echo "Error: Failed to get upload URL: $RESPONSE" >&2
  exit 1
fi

UPLOAD_URL=$(echo "$RESPONSE" | grep -o '"upload_url":"[^"]*"' | cut -d'"' -f4)
FILE_ID=$(echo "$RESPONSE" | grep -o '"file_id":"[^"]*"' | cut -d'"' -f4)

# Step 2: Upload file
curl -s -X POST "$UPLOAD_URL" \
  -F "file=@$FILE" > /dev/null

# Step 3: Complete upload
COMPLETE=$(curl -s -X POST "https://slack.com/api/files.completeUploadExternal" \
  -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"files\":[{\"id\":\"$FILE_ID\",\"title\":\"$TITLE\"}],\"channel_id\":\"$SLACK_CHANNEL_ID\"}")

OK=$(echo "$COMPLETE" | grep -o '"ok":true' || true)
if [ -z "$OK" ]; then
  echo "Error: Failed to complete upload: $COMPLETE" >&2
  exit 1
fi

echo "Uploaded $FILENAME to Slack"
