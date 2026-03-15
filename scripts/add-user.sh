#!/bin/bash
# Add a new Hopcode user with Claude CLI access
# Usage: ./add-user.sh <username> <password>
#
# This script:
# 1. Creates a Linux user with home directory
# 2. Sets up Claude CLI permissions (all tools allowed, destructive ops denied)
# 3. Creates ~/coding directory for Easy Mode projects
# 4. Adds the user to users.json
# 5. Grants minimal sudo (nginx reload only)
#
# Must be run as root.

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <username> <password>"
  echo "Example: $0 xu Hopcode2026!"
  exit 1
fi

USERNAME="$1"
PASSWORD="$2"
HOPCODE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
USERS_JSON="$HOPCODE_DIR/users.json"

if [ "$(id -u)" -ne 0 ]; then
  echo "Error: must run as root"
  exit 1
fi

# 1. Create Linux user (skip if exists)
if id "$USERNAME" &>/dev/null; then
  echo "Linux user '$USERNAME' already exists, skipping creation"
else
  useradd -m -s /bin/bash "$USERNAME"
  echo "$USERNAME:$PASSWORD" | chpasswd
  echo "Created Linux user: $USERNAME"
fi

# 2. Set up Claude CLI permissions
CLAUDE_DIR="/home/$USERNAME/.claude"
mkdir -p "$CLAUDE_DIR"

cat > "$CLAUDE_DIR/settings.json" << 'SETTINGS'
{
  "permissions": {
    "allow": [
      "Read",
      "Edit",
      "Write",
      "Grep",
      "Glob",
      "WebFetch",
      "WebSearch",
      "Bash"
    ],
    "deny": [
      "Bash(rm -rf *)",
      "Bash(git push --force *)",
      "Bash(git reset --hard *)",
      "Bash(shutdown *)",
      "Bash(reboot *)",
      "Bash(mkfs *)",
      "Bash(userdel *)",
      "Bash(passwd *)",
      "Bash(chown *)"
    ]
  }
}
SETTINGS

chown -R "$USERNAME:$USERNAME" "$CLAUDE_DIR"
echo "Claude CLI permissions configured"

# 3. Create coding directory
CODING_DIR="/home/$USERNAME/coding"
mkdir -p "$CODING_DIR"
chown "$USERNAME:$USERNAME" "$CODING_DIR"
echo "Created ~/coding directory"

# 4. Minimal sudo — only nginx reload (needed for some deploy workflows)
SUDOERS_FILE="/etc/sudoers.d/$USERNAME"
if [ ! -f "$SUDOERS_FILE" ]; then
  cat > "$SUDOERS_FILE" << SUDOERS
$USERNAME ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t
$USERNAME ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx
SUDOERS
  chmod 440 "$SUDOERS_FILE"
  visudo -c -q || { echo "Error: invalid sudoers syntax"; rm -f "$SUDOERS_FILE"; exit 1; }
  echo "Sudo rules configured"
fi

# 5. Add to users.json
if [ -f "$USERS_JSON" ]; then
  # Check if user already exists
  if grep -q "\"$USERNAME\"" "$USERS_JSON"; then
    echo "User '$USERNAME' already in users.json, skipping"
  else
    # Insert before the last closing brace
    # Use python for reliable JSON manipulation
    python3 -c "
import json, sys
with open('$USERS_JSON') as f:
    users = json.load(f)
users['$USERNAME'] = {'password': '$PASSWORD', 'linuxUser': '$USERNAME'}
with open('$USERS_JSON', 'w') as f:
    json.dump(users, f, indent=2)
    f.write('\n')
"
    echo "Added '$USERNAME' to users.json"
  fi
else
  echo "Warning: $USERS_JSON not found. Create it manually."
fi

echo ""
echo "Done! User '$USERNAME' is ready."
echo "  - Login: username=$USERNAME, password=$PASSWORD"
echo "  - Home: /home/$USERNAME"
echo "  - Coding: /home/$USERNAME/coding"
echo "  - Claude: all tools allowed, destructive ops denied"
echo ""
echo "Restart Hopcode to pick up the new user:"
echo "  pm2 restart hopcode-ui"
