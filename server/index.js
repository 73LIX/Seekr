'use strict';
const { createApp } = require('./app');

async function main() {
  const app = createApp();
  const addr = await app.listen();
  const ai = await app.ai.health().catch(() => null);
  console.log(`Treasure Hunt running on http://${addr.address === '0.0.0.0' ? 'localhost' : addr.address}:${addr.port}`);
  console.log(`  data dir : ${app.cfg.dataDir}`);
  console.log(`  images   : ${app.imagesAvailable ? 'sharp OK' : 'sharp NOT installed - photo checks disabled (run npm install)'}`);
  if (ai) console.log(`  AI       : ${ai.provider}${ai.model ? ` / ${ai.model}` : ''} - ${ai.ok ? 'ready' : 'not ready'} - ${ai.detail}`);
  if (!app.cfg.publicUrl) console.log('  note     : PUBLIC_URL is not set; QR codes will use the address the organizer browses from.');

  let stopping = false;
  const stop = async (sig) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${sig} received - shutting down`);
    const t = setTimeout(() => process.exit(1), 8000);
    t.unref();
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
