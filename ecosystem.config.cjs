module.exports = {
  apps: [
    {
      name: 'hopcode-pty',
      script: 'npx',
      args: 'tsx src/pty-service.ts',
      cwd: __dirname,
      autorestart: true,
      watch: false,
    },
    {
      name: 'hopcode-ui',
      script: 'npx',
      args: 'tsx src/server-node.ts',
      cwd: __dirname,
      autorestart: true,
      watch: false,
    },
    {
      name: 'browser-proxy',
      script: 'server.ts',
      interpreter: 'bun',
      cwd: '/root/browser-proxy',
      autorestart: true,
      watch: false,
    },
    {
      name: 'wechat-service',
      script: 'service.ts',
      interpreter: 'bun',
      cwd: '/root/wechat-service',
      autorestart: true,
      watch: false,
    },
  ],
};
