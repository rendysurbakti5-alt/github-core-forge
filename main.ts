// The forge's lifecycle entry: bind an ephemeral port, register it with the suite's env
// service, serve until the env service reports done, then shut down cleanly.

import { createApp } from './app.ts';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl === undefined || envUrl === '') {
    console.error('MAKEFUN_ENV_URL is not set');
    process.exit(1);
  }

  const { server } = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  const port = address.port;

  // Register with the env service; a 409 means a previous attempt already registered.
  let delay = 250;
  for (;;) {
    try {
      const res = await fetch(new URL('/register', envUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.status === 200 || res.status === 409) break;
      if (res.status === 400 || res.status === 405) {
        console.error(`registration failed: HTTP ${res.status}`);
        process.exit(1);
      }
    } catch {
      // The env service may not be listening yet; keep retrying.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }

  // Poll until the suite is done, then exit so the harness can collect the transcript.
  for (;;) {
    await sleep(250);
    try {
      const res = await fetch(new URL('/done', envUrl));
      if (res.ok) {
        const body = (await res.json()) as { done?: boolean };
        if (body.done === true) break;
      }
    } catch {
      // Keep waiting.
    }
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
