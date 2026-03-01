# Deployment

## Quick Start (Local)

```bash
bun install
echo "AUTH_PASSWORD=yourpassword" > .env
pm2 start ecosystem.config.cjs
```

Open `http://localhost:3000`.

## Docker

```bash
docker build -t hopcode .
docker run -p 3000:3000 -e AUTH_PASSWORD=yourpassword hopcode
```

## Remote Access with Cloudflare Tunnel

The simplest way to access Hopcode from your phone:

```bash
# Install cloudflared
# https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

# Start with tunnel
AUTH_PASSWORD=yourpassword npx tsx src/server-node.ts --tunnel
```

This prints a public HTTPS URL you can open from any device. The connection is password-protected.

## Production Setup with pm2

```bash
# Install pm2 globally
bun install -g pm2

# Start both services
pm2 start ecosystem.config.cjs

# Save process list (auto-start on reboot)
pm2 save
pm2 startup
```

### Useful pm2 Commands

```bash
pm2 status              # Check service status
pm2 logs                # View logs
pm2 restart hopcode-ui  # Restart UI only (sessions survive)
pm2 restart all         # Restart everything
```

## Reverse Proxy (Nginx)

If running behind Nginx, ensure WebSocket upgrade is configured:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_PASSWORD` | *(required)* | Login password |
| `PORT` | `3000` | UI service port |
| `SHELL_CMD` | `bash` | Shell to spawn |
| `VOLCANO_APP_ID` | — | Volcano Engine app ID (voice) |
| `VOLCANO_TOKEN` | — | Volcano Engine token (voice) |
| `VOLCANO_ASR_RESOURCE_ID` | `volc.bigasr.sauc.duration` | ASR resource ID |
