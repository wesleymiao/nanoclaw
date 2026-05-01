---
name: deploy-azure
description: Deploy a web app to Azure App Service via GitHub Actions. Use when tasked to build, deploy, or update a site on Azure.
---

# /deploy-azure — Azure App Service Deployment

Proven deployment approach for Azure App Service. **Do NOT use publish profiles** — they are fragile and cause many issues.

## Deployment Pipeline

1. **Create a GitHub repo** for the project using `gh repo create`
2. **Create a service principal** for GitHub Actions:
   ```bash
   az ad sp create-for-rbac --name "github-actions-<app-name>" --role contributor \
     --scopes /subscriptions/<sub-id>/resourceGroups/<rg-name> --sdk-auth
   ```
3. **Store the JSON output as a GitHub secret**:
   ```bash
   gh secret set AZURE_CREDENTIALS --repo <owner>/<repo> --body '<json>'
   ```
4. **Create a GitHub Actions workflow** (`.github/workflows/deploy.yml`):
   ```yaml
   name: Deploy to Azure
   on:
     push:
       branches: [main]
   jobs:
     deploy:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - name: Set up runtime  # Python/Node/etc.
           uses: actions/setup-python@v5  # or setup-node
           with:
             python-version: "3.11"
         - name: Install dependencies
           run: pip install -r requirements.txt
         - name: Zip artifact
           run: zip -r release.zip . -x ".git/*" ".github/*" "__pycache__/*" "*.md"
         - name: Login to Azure
           uses: azure/login@v2
           with:
             creds: ${{ secrets.AZURE_CREDENTIALS }}
         - name: Deploy
           uses: azure/webapps-deploy@v2
           with:
             app-name: <AppName>
             package: release.zip
   ```
5. **Push to trigger deployment**: `git push origin main`
6. **Monitor the workflow**: `gh run view <run-id> --repo <owner>/<repo>` (do NOT use `gh run watch` — it blocks)

## App Configuration

- Set app settings: `az webapp config appsettings set --name <app> --resource-group <rg> --settings KEY=VALUE`
- Set startup command: `az webapp config set --name <app> --resource-group <rg> --startup-file "<command>"`
- View logs: `az webapp log tail --name <app> --resource-group <rg>`

## Verification

After deployment, **always run `/verify-site`** to create and run comprehensive E2E tests against the live public URL. This includes:
- Page load, navigation, forms, responsive views
- Screenshots uploaded to chat as visual proof
- Backend log monitoring if E2E fails

A quick smoke test before full E2E:
```bash
npx playwright screenshot https://<app>.azurewebsites.net /tmp/verify.png
```
Upload the screenshot to chat so the user can see the result.

## Node.js App Service — Proven Recipe

This is the exact pattern that works. Follow it precisely — do NOT experiment with alternatives.

### GitHub Actions Workflow (Node.js)

```yaml
name: Deploy to Azure
on:
  push:
    branches: [master]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Install dependencies
        run: npm install --production
      - name: Create data directories
        run: mkdir -p data  # if app needs writable dirs
      - name: Zip artifact
        run: zip -r release.zip . -x ".git/*" ".github/*" "*.md"
      - name: Login to Azure
        uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      - name: Deploy
        uses: azure/webapps-deploy@v2
        with:
          app-name: <app-name>
          package: release.zip
```

### Critical: Include node_modules in the zip

The zip MUST include `node_modules/`. Do NOT exclude it. Azure's Oryx build system (`SCM_DO_BUILD_DURING_DEPLOYMENT`) is unreliable with zip deploy — it often skips `npm install`, causing `MODULE_NOT_FOUND` errors at runtime.

**Build in CI, deploy the complete artifact.** This is the only reliable approach.

### Critical: Disable SCM build and WEBSITE_RUN_FROM_PACKAGE

Set these app settings to prevent Azure from interfering with the deployed artifact:

```bash
az webapp config appsettings set --name <app> --resource-group <rg> --settings \
  SCM_DO_BUILD_DURING_DEPLOYMENT=false \
  WEBSITE_RUN_FROM_PACKAGE=0
```

- `SCM_DO_BUILD_DURING_DEPLOYMENT=false` — prevents Oryx from stripping/rebuilding node_modules
- `WEBSITE_RUN_FROM_PACKAGE=0` — keeps filesystem writable (required for SQLite, file uploads, etc.)

### Startup command

For Node.js apps, set the startup command explicitly:

```bash
az webapp config set --name <app> --resource-group <rg> --startup-file "node server.js"
```

### Monitoring the deploy

Do NOT use `gh run watch` — it blocks and will timeout the container. Use polling:

```bash
RUN_ID=$(gh run list --repo <owner>/<repo> --limit 1 --json databaseId -q '.[0].databaseId')
# Check status
gh run view $RUN_ID --repo <owner>/<repo> --json status,conclusion -q '{status,conclusion}'
```

## Common Pitfalls

- **Do NOT use publish profiles** (`AZURE_WEBAPP_PUBLISH_PROFILE`) — use service principal credentials (`AZURE_CREDENTIALS`) instead
- **Do NOT deploy via `az webapp deployment source config`** for GitHub integration — use GitHub Actions workflow instead
- **Do NOT use `az webapp deploy --src-path`** directly from the container — use GitHub Actions for CI/CD
- **Do NOT exclude node_modules from the zip** — Azure Oryx often fails to rebuild them
- **Do NOT set `WEBSITE_RUN_FROM_PACKAGE=1`** if the app needs a writable filesystem (SQLite, file uploads)
- **Do NOT use `gh run watch`** — it blocks and will timeout the container; use `gh run view` to poll
- **Do NOT rely on `SCM_DO_BUILD_DURING_DEPLOYMENT=true`** — it's unreliable with zip deploy
- **Set the startup command** explicitly for Python apps (e.g., `gunicorn app:app`) and Node.js apps (e.g., `node server.js`)
- Playwright is pre-installed — do NOT run `npx playwright install chromium`
