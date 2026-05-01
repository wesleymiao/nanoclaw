---
name: verify-site
description: Verify a deployed web site using Playwright. Use after deploying a site, or when asked to test/verify a web app is working.
---

# /verify-site — Post-Deploy Web Site Verification

Use Playwright to verify a deployed web site works correctly. Playwright and Chromium are pre-installed — do NOT run `npx playwright install`.

## Quick Verification

For a simple "is it up and looking right" check:

```bash
npx playwright screenshot https://<your-site>.azurewebsites.net /tmp/site-verify.png --full-page
```

Then upload the screenshot to chat so the user can see it.

## Comprehensive E2E Test

For thorough testing, create a test script (`tests/e2e-live.js`):

```javascript
const { chromium } = require('playwright');
const path = require('path');

const BASE = process.env.BASE_URL || 'https://<your-site>.azurewebsites.net';
const SHOTS = path.join(__dirname, 'screenshots');
let passed = 0, failed = 0;
const results = [];

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

async function shot(page, name) {
  const file = path.join(SHOTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    results.push(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    results.push(`  ❌ ${name}\n     ${e.message.split('\n')[0]}`);
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  console.log(`\nE2E Tests — ${BASE}\n`);

  // Add tests here:
  await test('Home page loads', async () => {
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await shot(page, '01-homepage');
    const title = await page.title();
    assert(title, 'Page has no title');
    await page.close();
  });

  await test('Mobile viewport', async () => {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await shot(page, '02-mobile');
    await page.close();
    await ctx.close();
  });

  await browser.close();
  console.log('\n' + results.join('\n'));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
```

Run with: `node tests/e2e-live.js`

## What to Test

Cover these areas as applicable:

| Area | What to Check |
|------|--------------|
| **Page load** | Title, key elements visible, no JS errors |
| **Navigation** | Links work, routing correct |
| **Forms** | Login, registration, input validation |
| **Responsive** | Mobile viewport (375×812), tablet (768×1024) |
| **Dark mode** | Theme toggle works if present |
| **i18n** | Language toggle works if present |
| **API calls** | Data loads, CRUD operations work |
| **Error states** | 404 page, invalid inputs handled |

## Screenshots

- Save to `tests/screenshots/` with numbered descriptive names: `01-homepage.png`, `02-after-login.png`
- **Always upload key screenshots to chat** after testing:
  ```bash
  feishu upload tests/screenshots/01-homepage.png "Homepage"
  feishu upload tests/screenshots/02-mobile.png "Mobile view"
  ```
- For Slack: use the Slack file upload API instead

## Common Pitfalls

- Do NOT run `npx playwright install chromium` — it's pre-installed
- Use `{ waitUntil: 'networkidle' }` for pages that fetch data on load
- Use `page.waitForTimeout(1000-3000)` after actions that trigger async updates (form submissions, API calls)
- Use `page.waitForSelector('#element', { timeout: 10000 })` instead of fixed waits when possible
- Take screenshots at key steps — they help debug failures and show the user what happened
- Always test against the **live public URL**, not localhost

## Backend Log Monitoring During E2E

Playwright catches frontend issues, but server-side errors (missing env vars, DB failures, unhandled exceptions, 500s) are invisible to the browser. **Only check backend logs when E2E tests fail** — don't waste time on logs when everything passes.

### Enable logging

Turn on application and web server logging for the Azure App Service:

```bash
az webapp log config \
  --name <app-name> \
  --resource-group <rg-name> \
  --application-logging filesystem \
  --web-server-logging filesystem \
  --level information
```

### Tail logs to diagnose failures

When E2E tests fail, tail recent backend logs to find the root cause:

```bash
# Grab the last 200 lines of backend logs
az webapp log tail --name <app-name> --resource-group <rg-name> > /tmp/backend-logs.txt 2>&1 &
LOG_PID=$!
sleep 5

# Reproduce the failure — re-run the failing test
BASE_URL="$BASE_URL" node tests/e2e-live.js
kill $LOG_PID 2>/dev/null
wait $LOG_PID 2>/dev/null

# Search for errors
grep -iE 'error|exception|500|unhandled|ECONNREFUSED|FATAL' /tmp/backend-logs.txt | head -20
```

### Download full logs

For deeper debugging, download the complete log bundle:

```bash
az webapp log download \
  --name <app-name> \
  --resource-group <rg-name> \
  --log-file /tmp/webapp-logs.zip

unzip -o /tmp/webapp-logs.zip -d /tmp/webapp-logs/
```

### Combined verification script

Runs E2E first. Only captures and analyzes backend logs if E2E fails:

```bash
#!/bin/bash
set -e
APP_NAME="${1:?Usage: verify.sh <app-name> <resource-group>}"
RG="${2:?Usage: verify.sh <app-name> <resource-group>}"
BASE_URL="https://${APP_NAME}.azurewebsites.net"

echo "🔍 Verifying ${BASE_URL}"
echo "================================"

# 1. Run E2E tests
echo "🎭 Running Playwright E2E tests..."
if BASE_URL="$BASE_URL" node tests/e2e-live.js; then
  echo ""
  echo "✅ Verification PASSED (all E2E tests passed)"
  exit 0
fi

# 2. E2E failed — now check backend logs for root cause
echo ""
echo "❌ E2E tests failed — checking backend logs for clues..."
echo ""

az webapp log config --name "$APP_NAME" --resource-group "$RG" \
  --application-logging filesystem --web-server-logging filesystem \
  --level information -o none

az webapp log tail --name "$APP_NAME" --resource-group "$RG" > /tmp/backend-logs.txt 2>&1 &
LOG_PID=$!
sleep 5

# Re-run failing tests to capture logs during failure
BASE_URL="$BASE_URL" node tests/e2e-live.js 2>/dev/null || true

kill $LOG_PID 2>/dev/null
wait $LOG_PID 2>/dev/null

# 3. Analyze
echo "=== Backend Log Analysis ==="
if grep -iE 'error|exception|500|unhandled|FATAL' /tmp/backend-logs.txt | head -20; then
  echo ""
  echo "⚠️  Backend errors detected — likely root cause above"
else
  echo "No backend errors found — failure is frontend-only"
fi

echo ""
echo "❌ Verification FAILED"
exit 1
```

Save as `tests/verify.sh`, run with: `bash tests/verify.sh <app-name> <resource-group>`
