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
