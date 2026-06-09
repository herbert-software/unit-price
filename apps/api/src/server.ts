// HTTP server entry for @unit-price/api (walking skeleton).
// Builds the production app (lazy AI-SDK port: clean titles parse via tier1
// without OPENROUTER_API_KEY) and serves it over Node's http. Port from $PORT,
// default 8787.
import { serve } from '@hono/node-server';
import { buildApp } from './index.js';

const port = Number(process.env.PORT ?? 8787);
const app = buildApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
});
