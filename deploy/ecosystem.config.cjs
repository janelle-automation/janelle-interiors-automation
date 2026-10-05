// PM2 process file for the self-hosted API (see deploy/README.md).
//
// ONE instance, on purpose: services/scheduler.ts runs inside the API
// process, and cluster mode would start a scheduler per instance.
module.exports = {
  apps: [
    {
      name: 'janelle-api',
      cwd: __dirname + '/..',
      script: 'apps/api/dist/index.js',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
        // Loopback only: nginx is the public face. Do not set PORT — env.ts
        // then binds 0.0.0.0, which would expose the API past nginx.
        API_HOST: '127.0.0.1',
        API_PORT: '4055',
      },
    },
  ],
};
