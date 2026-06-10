// drizzle-kit config — sqlite dialect (Cloudflare D1 in production).
//
// Local generate/migrate run against a SQLite file (gitignored; override
// with DB_FILE). In production the D1 binding is injected by the Worker and
// migrations are applied via wrangler against that binding — drizzle-kit
// never talks to D1 directly from here.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DB_FILE ?? 'file:./.local/dev.sqlite',
  },
});
