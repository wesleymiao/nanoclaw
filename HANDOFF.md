# Session Hand-off — NanoClaw Multi-Tenancy Multi-VM Architecture Doc

## Where things are
- **Working folder (new):** `Q:\src\nanoclaw` — freshly cloned from `origin/main`
  (`https://github.com/wesleymiao/nanoclaw.git`), fast-forwarded to commit `0639d72`.
- **Architecture doc:** `Q:\src\nanoclaw\NanoClaw_Architecture_Interactive.html`
  (copied over from `C:\Users\wesleymiao\proxy`, currently untracked — not part of
  the repo's source tree, kept as a standalone artifact).
- **Proxy VM** (`proxy-vm`, resource group `PROXY-RG`, public IP `20.63.217.212`,
  user `azureuser`): live NanoClaw deployment lives at `/home/azureuser/nanoclaw`.
  Its git remotes: `origin` = `wesleymiao/nanoclaw` (this repo), `upstream` =
  `qwibitai/nanoclaw`, `slack` = `qwibitai/nanoclaw-slack`. Working tree was
  fully clean and pushed as of this hand-off (no pending local changes).
- **Old local server:** a Python HTTP server previously served the HTML from
  `C:\Users\wesleymiao\proxy` on `http://127.0.0.1:8000` during this session —
  it has since been **stopped** (confirmed unreachable). If you want to preview
  the page again, start a new one pointed at `Q:\src\nanoclaw`, e.g.
  `python -m http.server 8000 --bind 127.0.0.1` run from `Q:\src\nanoclaw`.

## What the HTML doc is
An interactive single-file HTML presentation (`NanoClaw_Architecture_Interactive.html`)
documenting NanoClaw's architecture, built up over many rounds of edits. Left sidebar
now has 3 top-level groups:
1. **Overview & Context** — landing page: what NanoClaw is today, the problem being
   solved, how the doc is organized, key vocabulary, navigation tips.
2. **Chapter 1 — Current Single-VM Architecture** — Core Architecture, Credentials &
   Authentication, Session Lifecycle, Container Image Build, Scaling, Credential Matrix.
3. **Chapter 2 — Multi-Tenancy Multi-VM Design & Local Testability** —
   - **Walkthroughs**: 3 diagram-backed scenarios (Feishu new conversation, Feishu
     follow-up, Web channel follow-up) + a shared Reference card grid, including
     detailed Service Bus session-lock API mechanics (`AcceptNextSessionAsync`,
     `RenewSessionLockAsync`, sticky delivery).
   - **Implementation Stages**: a 9-stage rollout plan (Stage 0–8) that externalizes
     one dependency at a time on a single VM before cutting over to real multi-VM
     infra. Web channel was deliberately moved early (Stage 1) as a scriptable,
     rate-limit-free test harness.
   - **Local Testability**: how to make nearly everything above — including
     cross-worker races and chaos scenarios — testable on a laptop via
     docker-compose (ports/adapters pattern, N local worker containers, virtual
     clock, local chaos harness, contract tests), with an honest card about what
     still needs real Azure (Front Door, Entra ID login, Monitor autoscale timing).

Diagrams are click-to-inspect: clicking a node opens a detail drawer at the bottom.
Card colors are consistent: green = favorable/de-risking, amber = limitation/watch-out,
default = neutral fact.

## Validation pattern used throughout
Every edit round was validated with a small inline Node script counting matched
open/close tags (`section`, `div`, `article`, `h2`, `p`, `nav`, `button` — ignore
self-closing tags like `path`/`text`), plus confirming nav `data-view` values match
`<section id="...">` values as sets, plus an `Invoke-WebRequest` reload check for
200 OK. **Gotcha:** the file has mixed line endings (mostly CRLF); any Node script
doing multi-line string search/replace must join lines with `\r\n`, not `\n`, or
matches silently fail.

## Status / next steps
- All requested edits so far are complete and validated (tag-balanced, reloads
  cleanly). No known outstanding TODOs on the HTML doc itself.
- Possible next steps to consider in the new session:
  - Decide whether `NanoClaw_Architecture_Interactive.html` should be formally
    added to the `nanoclaw` git repo (currently untracked) or kept as a
    standalone doc outside version control.
  - Re-point/restart the local preview server from `Q:\src\nanoclaw`.
  - Continue any further content requests against the same file.
