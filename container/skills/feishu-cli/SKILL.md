---
name: feishu-cli
description: Interact with Feishu/Lark directly — upload files, send messages, react, read history. Use whenever you generate files or need richer Feishu interaction.
---

# Feishu CLI

A `feishu` command is available for direct Feishu channel interaction.

## Check availability

```bash
test -n "$FEISHU_CHAT_ID" && echo "Feishu CLI available" || echo "Not a Feishu channel"
```

## File uploads

**Always upload generated files** instead of referencing paths:

```bash
feishu upload /workspace/group/chart.png "Chart Title"
feishu upload /workspace/group/report.pdf "Monthly Report"
```

## Messaging

```bash
feishu send "Hello!"                              # Send a message
feishu reply om_xxxxx "Got it"                     # Reply to a message
feishu delete om_xxxxx                             # Delete a message
```

## Reactions

```bash
feishu react om_xxxxx THUMBSUP                     # Add 👍
feishu react om_xxxxx OK                            # Add 👌
```

## History

```bash
feishu history                                     # Last 20 messages
feishu history --limit 50                          # Last 50 messages
```

## Full help

```bash
feishu help
```

## Important

- **Do NOT** use markdown image syntax `![alt](path)` — always use `feishu upload`
- Message IDs (`om_xxxxx`) are returned by `feishu send` and visible in `feishu history`
