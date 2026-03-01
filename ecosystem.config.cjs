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
  ],
};
