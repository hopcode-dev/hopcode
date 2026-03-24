# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Hopcode, please report it responsibly.

**Do not open a public issue.**

Instead, email **hopcode@pm.me** with:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest `master` | Yes |

## Security Considerations

Hopcode exposes a terminal over HTTP/WebSocket. When deploying:

- **Always set `AUTH_PASSWORD`** — there is no default password
- **Use HTTPS** — use Cloudflare Tunnel or a reverse proxy with TLS
- **Restrict network access** — bind to localhost or use a firewall if not using a tunnel
- **Keep dependencies updated** — run `bun update` regularly
