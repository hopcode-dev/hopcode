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
      env: {
        ANTHROPIC_BASE_URL: 'https://api.minimaxi.com/anthropic',
        ANTHROPIC_AUTH_TOKEN: 'sk-cp-FpuovQHjWZi3RPj28ugCMnh6r4jRvLIC16T_Cf-hHIFRF5y2DjPTlLyzvzaJaOqM-_yvIrJbyY1zID8VOYoVAVfmcrArGuFMEk_dGlO5ZcW4-bLgttTMVP8',
      },
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
