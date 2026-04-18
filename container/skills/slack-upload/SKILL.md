---
name: slack-upload
description: Interact with Slack directly — upload files, send/edit/delete messages, react, read history, reply in threads, pin messages. Use whenever you generate files, want to react to messages, or need richer Slack interaction.
---

# Slack CLI

A `slack` command is available in your PATH for direct Slack channel interaction.

## Check availability

```bash
test -n "$SLACK_CHANNEL_ID" && echo "Slack CLI available" || echo "Not a Slack channel"
```

## File uploads

**Always upload generated files** (images, charts, CSVs, etc.) instead of referencing paths:

```bash
slack upload /workspace/group/chart.png "Chart Title"
```

## Messaging

```bash
slack send "Hello!"                          # Send a message
slack send "FYI" --thread 1234567890.123456   # Send in a thread
slack reply 1234567890.123456 "Got it"        # Reply in thread
slack update 1234567890.123456 "Edited text"  # Edit a message
slack delete 1234567890.123456                # Delete a message
```

## Reactions

```bash
slack react 1234567890.123456 thumbsup        # Add 👍
slack react 1234567890.123456 white_check_mark # Add ✅
slack unreact 1234567890.123456 thumbsup       # Remove reaction
```

## Channel history & threads

```bash
slack history                     # Last 20 messages
slack history --limit 50          # Last 50 messages
slack thread 1234567890.123456    # Read thread replies
```

## Users & pins

```bash
slack userinfo U0123456789        # Get user profile
slack pin 1234567890.123456       # Pin a message
slack unpin 1234567890.123456     # Unpin a message
slack pins                        # List pinned messages
```

## Full help

```bash
slack help
```

## Important

- **Do NOT** use markdown image syntax `![alt](path)` — always use `slack upload`
- Message timestamps (`ts`) are returned by `slack send` and visible in `slack history`
- All commands target the current channel automatically via `$SLACK_CHANNEL_ID`
