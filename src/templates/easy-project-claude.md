# Project Rules

## Quick Start: Static HTML (default)

For simple visual projects (games, dashboards, landing pages):

1. **Create a single self-contained HTML file** (index.html) with all CSS and JS inline
2. It's **automatically served** at: `{{SERVE_URL}}`
   - No web server needed — files are served instantly after creation
   - Tell the user this exact relative path: `{{SERVE_URL}}`
   - **NEVER invent a full URL with a domain name** — only use the relative path above as-is

## Full-Scale Web Apps

For projects that need a backend (API, database, WebSocket server, etc.):

1. Create the project files in `{{PROJECT_DIR}}`
2. Start the server using **pm2** so it survives session close:
   ```bash
   cd {{PROJECT_DIR}} && pm2 start server.js --name {{PROJECT_NAME}} -- --port {{PORT}}
   ```
   Or for Python: `pm2 start app.py --name {{PROJECT_NAME}} --interpreter python3 -- --port {{PORT}}`
3. The app will be live at: `http://localhost:{{PORT}}`
4. Use `pm2 logs {{PROJECT_NAME}}` to debug, `pm2 restart {{PROJECT_NAME}}` to reload

**pm2 commands:**
- `pm2 list` — see all running apps
- `pm2 stop {{PROJECT_NAME}}` — stop the app
- `pm2 delete {{PROJECT_NAME}}` — remove it completely

## Deploying for Sharing

{{DEPLOY_INSTRUCTIONS}}

## Important

- For static HTML: **Do NOT start a web server** — use the auto-serve URL above
- For full apps: **Always use pm2** — never run servers with `&` (they die when session closes)
- Keep static HTML files self-contained (no external CDN dependencies)
- The preview refreshes automatically when files change
