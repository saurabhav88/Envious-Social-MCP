# Envious Social MCP

A lightweight [MCP](https://modelcontextprotocol.io/) server that lets you post to social media directly from Claude Code. No Docker, no middleware, no SaaS subscriptions — just direct API calls with tokens stored securely in macOS Keychain.

Built by [Envious Labs](https://enviouswispr.com) because every social media scheduler we tried was either too heavy, too flaky, or too expensive for what we needed: **just post the thing**.

## What it does

Post text and media to social platforms from any Claude Code conversation:

```
> Post "Hello world!" to X with the logo attached
> Reply to tweet 123456 with a link
> Check which platforms are connected
```

## Supported platforms

| Platform | Status | Auth | Notes |
|---|---|---|---|
| X / Twitter | Working | OAuth 1.0a | $0.01/post (pay-per-use) |
| LinkedIn | Working | OAuth 2.0 | Personal profile posting |
| YouTube | Planned | OAuth 2.0 | Waiting on video content |
| Facebook | Planned | OAuth 2.0 | — |
| Instagram | Planned | OAuth 2.0 (via Facebook) | — |
| TikTok | Planned | OAuth 2.0 | Media must be public HTTPS |

## Tools

| Tool | Description |
|---|---|
| `social_post` | Post text + optional media to a platform |
| `social_reply` | Reply to an existing post (threaded on X) |
| `social_upload_media` | Pre-upload media for advanced workflows |
| `social_delete` | Delete a post (X only, LinkedIn/Instagram don't allow it) |
| `social_auth_status` | Check which platforms have valid tokens |
| `social_store_tokens` | Store OAuth tokens in macOS Keychain |

## Setup

### Prerequisites

- macOS (uses Keychain for token storage)
- Python 3.10+
- [uv](https://github.com/astral-sh/uv) (recommended) or pip

### Install

```bash
cd Envious-Social-MCP
uv venv && uv pip install -e .
```

### Register with Claude Code

Add to `~/.mcp.json`:

```json
{
  "envious-social": {
    "command": "/path/to/uv",
    "args": ["--directory", "/path/to/Envious-Social-MCP", "run", "server.py"]
  }
}
```

Enable in `~/.claude/settings.local.json`:

```json
{
  "enabledMcpjsonServers": ["envious-social"]
}
```

### Connect X / Twitter

1. Create an app at [developer.x.com](https://developer.x.com) (select "Native App" type)
2. Store your credentials:

```bash
# Via the MCP tool:
social_store_tokens(platform="x", consumer_key="...", consumer_secret="...", access_token="...", access_secret="...")

# Or via macOS Keychain directly:
security add-generic-password -s envious-social -a x-consumer-key -w "YOUR_KEY" -U
security add-generic-password -s envious-social -a x-consumer-secret -w "YOUR_SECRET" -U
security add-generic-password -s envious-social -a x-access-token -w "YOUR_TOKEN" -U
security add-generic-password -s envious-social -a x-access-secret -w "YOUR_SECRET" -U
```

### Connect LinkedIn

1. Create an app at [linkedin.com/developers](https://www.linkedin.com/developers/apps)
2. Add "Share on LinkedIn" product
3. Add `http://localhost:9876/callback` as an authorized redirect URL
4. Run the OAuth flow:

```bash
LINKEDIN_CLIENT_ID=your_id LINKEDIN_CLIENT_SECRET=your_secret python oauth_flow.py linkedin
```

Tokens are stored in Keychain automatically.

## Architecture

```
server.py                  # MCP entry point — registers tools, delegates to connectors
connectors/
  base.py                  # Abstract connector interface
  keychain.py              # Shared macOS Keychain helpers
  x_connector.py           # X/Twitter — OAuth 1.0a, media v1, posts v2
  linkedin_connector.py    # LinkedIn — OAuth 2.0, UGC Posts API
oauth_flow.py              # One-shot OAuth 2.0 browser flow for token acquisition
docs/
  platform-auth-reference.md  # Auth details for all 6 platforms
```

Each platform is a self-contained connector module. Adding a new platform means creating a new `connectors/<platform>_connector.py` and registering it in `server.py`. No shared state, no abstractions that leak.

## Token storage

All OAuth tokens live in macOS Keychain under the service name `envious-social`. No `.env` files, no config files with secrets, no Docker volumes.

```bash
# See what's stored
security dump-keychain | grep envious-social

# Read a specific token
security find-generic-password -s envious-social -a x-access-token -w
```

## License

MIT
