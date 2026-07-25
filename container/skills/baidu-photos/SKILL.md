# Skill: Baidu Cloud Photos

Access the user's iPhone photos synced to Baidu Cloud (百度网盘).

## Prerequisites

- `BaiduPCS-Go` is on PATH (pre-installed)
- Credentials are mounted at `~/.config/BaiduPCS-Go/` (pre-configured)

## Photo Location

iPhone photos auto-sync to: `/来自：iPhone/`

Files are named by timestamp: `YYYY-MM-DD HHMMSS.heic`

## Common Commands

```bash
# List latest photos (newest first)
BaiduPCS-Go ls "/来自：iPhone" --desc --time

# Download a photo (save to workspace so it persists across sessions)
BaiduPCS-Go d "/来自：iPhone/2026-05-01 160902.heic" --saveto /workspace/group/downloads/

# Search by date pattern
BaiduPCS-Go ls "/来自：iPhone" --desc --time | grep "2026-05-01"

# Check quota
BaiduPCS-Go quota
```

## HEIC Conversion

iPhone photos are `.heic` format. You MUST convert before viewing or uploading to chat.

**Method 1 — pillow-heif (recommended, pre-installed):**

```bash
python3 -c "
from pillow_heif import register_heif_opener
from PIL import Image
register_heif_opener()
img = Image.open('/workspace/group/downloads/photo.heic')
img.save('/workspace/group/downloads/photo.jpg', 'JPEG')
print(f'Converted: {img.size}')
"
```

**Method 2 — heif-convert (pre-installed):**

```bash
heif-convert /workspace/group/downloads/photo.heic /workspace/group/downloads/photo.jpg
```

Note: `heif-convert` may fail on some iPhone HEIC files with metadata errors. Use Method 1 if that happens.

## Workflow

1. Create downloads dir: `mkdir -p /workspace/group/downloads`
2. List photos: `BaiduPCS-Go ls "/来自：iPhone" --desc --time`
3. Download: `BaiduPCS-Go d "<path>" --saveto /workspace/group/downloads/`
4. Convert: HEIC → JPG (see above)
5. View: Use the Read tool on the JPG file
6. Upload to chat: `feishu upload /workspace/group/downloads/photo.jpg "Photo description"`

**IMPORTANT:** Always save downloads to `/workspace/group/downloads/`, NOT `/tmp/`. Files in `/tmp/` are lost when the container shuts down. Files in `/workspace/group/` persist across sessions.

## Other Baidu Cloud Operations

```bash
# Browse any folder
BaiduPCS-Go ls "/<folder>"

# Upload a file to Baidu Cloud
BaiduPCS-Go u /local/file.pdf "/remote/path/"

# Download any file
BaiduPCS-Go d "/path/to/file" --saveto /tmp/

# Create folder
BaiduPCS-Go mkdir "/new-folder"

# Move / copy / delete
BaiduPCS-Go mv "/old/path" "/new/path"
BaiduPCS-Go cp "/src" "/dst"
BaiduPCS-Go rm "/path/to/delete"
```
