---
name: add-wecom
description: Add Enterprise WeChat (企业微信/WeCom) channel support to NanoClaw
---

# Add Enterprise WeChat (WeCom) Channel

This skill adds WeCom (企业微信) support to NanoClaw.

## Prerequisites

- A WeCom enterprise account with admin access
- A self-built app (自建应用) created in WeCom admin console
- A public URL for the callback endpoint (e.g. via reverse proxy or cloud VM)

## Phase 1: Check if Already Applied

Check if `src/channels/wecom.ts` exists. If it does, skip to Phase 3 (Setup).

## Phase 2: Code Changes

The WeCom channel should already be in the codebase. If not, the files needed are:

- `src/channels/wecom.ts` — Channel implementation
- `src/channels/wecom.test.ts` — Unit tests
- `import './wecom.js'` in `src/channels/index.ts`
- `fast-xml-parser` npm dependency

Build and verify:

```bash
npm install
npm run build
npx vitest run src/channels/wecom.test.ts
```

## Phase 3: Setup

### Create WeCom App (if needed)

1. Go to [WeCom Admin Console](https://work.weixin.qq.com/wework_admin/frame#apps)
2. Click **自建** → **创建应用**
3. Set app name, logo, and visible range (可见范围)
4. Note down:
   - **企业ID (Corp ID)**: Found in 我的企业 → 企业信息 → 企业ID
   - **AgentId**: Found in the app's settings page
   - **Secret**: Found in the app's settings page

### Configure Callback URL

1. In the app settings, go to **接收消息** → **设置API接收**
2. Set:
   - **URL**: `https://your-domain.com/wecom/callback`
   - **Token**: Generate a random token (click 随机获取)
   - **EncodingAESKey**: Generate a random key (click 随机获取)
3. **Do NOT click Save yet** — first configure the env vars and start the server, then save to trigger URL verification

### Configure Environment

Add to `.env`:

```bash
WECOM_CORP_ID=your_corp_id
WECOM_CORP_SECRET=your_app_secret
WECOM_AGENT_ID=1000002
WECOM_TOKEN=your_callback_token
WECOM_ENCODING_AES_KEY=your_encoding_aes_key
WECOM_CALLBACK_PORT=9800
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Set Up Reverse Proxy

The callback server listens on `WECOM_CALLBACK_PORT` (default 9800). You need a reverse proxy to expose it via HTTPS:

**Nginx example:**
```nginx
location /wecom/callback {
    proxy_pass http://127.0.0.1:9800;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### Build and Restart

```bash
npm run build
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux
systemctl --user restart nanoclaw
```

### Complete Callback URL Verification

Now go back to the WeCom admin console and click **保存** on the callback URL settings. WeCom will send a GET request to verify the URL. Check logs:

```bash
tail -f logs/nanoclaw.log | grep WeCom
```

You should see: `WeCom: URL verification succeeded`

## Phase 4: Registration

### Register the Channel

The JID format is: `wecom:{agentid}`

WeCom auto-registers on first message. Or register manually:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "wecom:1000002" \
  --name "WeCom App" \
  --folder "wecom_main" \
  --trigger "@Andy" \
  --channel wecom \
  --no-trigger-required
```

## Phase 5: Verify

Send a message to the bot in WeCom (企业微信 app). The bot should respond.

Check logs if needed:
```bash
tail -f logs/nanoclaw.log | grep WeCom
```

## Troubleshooting

### URL verification fails
- Check that the callback port is accessible from the internet
- Check that `WECOM_TOKEN` and `WECOM_ENCODING_AES_KEY` match the WeCom admin console
- Check reverse proxy is correctly forwarding to the callback port

### Bot not responding
- Check env vars are set in both `.env` and `data/env/env`
- Check `WECOM_CORP_SECRET` is the app's secret (not the enterprise-level secret)
- Check the app's visible range includes the users who are messaging

### Access token errors
- Token expires every 2 hours — the channel auto-refreshes
- If getting persistent errors, check `WECOM_CORP_ID` and `WECOM_CORP_SECRET`

### Message decryption fails
- Verify `WECOM_ENCODING_AES_KEY` is exactly 43 characters (base64 without trailing =)

## Known Limitations

- **No group chat support yet** — WeCom group chats (群聊) use a different API. Current implementation handles single-user app messages only.
- **No reactions** — WeCom doesn't support emoji reactions.
- **No typing indicator** — WeCom doesn't expose a typing indicator API.
- **Markdown subset** — WeCom markdown support is limited (no tables, no inline images). Complex formatting should use HTML render → screenshot → image upload.
- **Media files expire** — Downloaded media IDs are only valid for 3 days.
