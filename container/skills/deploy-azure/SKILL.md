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
           run: zip -r release.zip . -x ".git/*" "tests/*" ".github/*" "__pycache__/*"
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
6. **Monitor the workflow**: `gh run watch` or `gh run view`

## App Configuration

- Set app settings: `az webapp config appsettings set --name <app> --resource-group <rg> --settings KEY=VALUE`
- Set startup command: `az webapp config set --name <app> --resource-group <rg> --startup-file "<command>"`
- View logs: `az webapp log tail --name <app> --resource-group <rg>`

## Verification

After deployment, **always run Playwright** against the live public URL:
```bash
npx playwright screenshot https://<app>.azurewebsites.net /tmp/verify.png
```
Upload the screenshot to chat so the user can see the result.

## Common Pitfalls

- **Do NOT use publish profiles** (`AZURE_WEBAPP_PUBLISH_PROFILE`) — use service principal credentials (`AZURE_CREDENTIALS`) instead
- **Do NOT deploy via `az webapp deployment source config`** for GitHub integration — use GitHub Actions workflow instead
- **Do NOT use `az webapp deploy --src-path`** directly from the container — use GitHub Actions for CI/CD
- **Always zip the artifact** excluding `.git/`, `tests/`, `__pycache__/`, `.github/`
- **Set the startup command** explicitly for Python apps (e.g., `gunicorn app:app`)
- Playwright is pre-installed — do NOT run `npx playwright install chromium`
