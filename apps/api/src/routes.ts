// Hono app + POST /parse route. Request/response bodies are Zod-validated.
// HTTP status semantics (parse-api spec):
//  - 4xx: invalid request body (missing/empty title, missing/non-numeric price)
//  - 5xx info-insufficient: tier2 transport failed AND tier1 had no shape at all
//  - 5xx config-error: runtime config error (distinguishable error code)
//  - 200: everything else, including determined-uncomputable (per100ml=null),
//         contracted-form, and low-confidence results.
import { Hono } from 'hono';
import { z } from 'zod';
import { ParsedSpecSchema, UnitPriceSchema, WarningsSchema, type RawProduct } from '@unit-price/core';
import { orchestrate } from './orchestrate.js';
import type { SpecParserLLM } from './llm.js';
import type { Bindings } from './bindings.js';
import { governanceMiddleware, type Governance } from './governance.js';

/** Request schema: title non-empty string, price a finite number, optional hint. */
export const ParseRequestSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
  price: z.number({ error: 'price must be a number' }).finite('price must be a finite number'),
  categoryHint: z.string().optional(),
});

/** Response schema (validated before send to keep the contract honest). */
export const ParseResponseSchema = z.object({
  spec: ParsedSpecSchema,
  unitPrice: UnitPriceSchema,
  confidence: z.number().min(0).max(1),
  warnings: WarningsSchema,
});

export interface AppDeps {
  /**
   * Factory that builds an LLM port from the per-request injected env. Building
   * per request (not a shared singleton) avoids isolate cross-request env
   * bleed: each request resolves config from its OWN `c.env`.
   */
  makeLlm: (env: Bindings) => SpecParserLLM;
  /**
   * Injectable access governance (auth / rate-limit / usage). Production injects
   * the real implementation; dev injects a pass-through no-op. Mounted as a
   * pre-middleware on /parse only — /health is exempt from the entire chain.
   */
  governance: Governance;
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  // /health is exempt from the entire governance chain (auth + rate + usage),
  // so liveness probes can hit it keyless and high-frequency.
  app.get('/health', (c) => c.json({ ok: true }));

  // Governance runs only on /parse, before the business handler. Order inside
  // the middleware: auth → rate-limit → usage → next().
  app.use('/parse', governanceMiddleware(deps.governance));

  app.post('/parse', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-request', message: 'request body must be valid JSON' }, 400);
    }

    const parsedReq = ParseRequestSchema.safeParse(body);
    if (!parsedReq.success) {
      return c.json(
        {
          error: 'invalid-request',
          message: 'request body failed validation',
          issues: parsedReq.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }

    const input: RawProduct = parsedReq.data;
    // Build the LLM port from THIS request's injected env (no cross-request
    // bleed). The factory's lazy parser only resolves config if tier2 is reached.
    const llm = deps.makeLlm(c.env);
    const outcome = await orchestrate(input, llm);

    if (outcome.kind === 'config-error') {
      // Distinguishable 5xx: runtime configuration error (no confidence body).
      return c.json({ error: 'config-error', message: outcome.message }, 500);
    }
    if (outcome.kind === 'insufficient') {
      // Distinguishable 5xx: information insufficient — can't even judge
      // computability (tier2 transport failed + tier1 had no shape).
      return c.json({ error: 'insufficient-information', message: outcome.message }, 503);
    }

    // Validate the response shape before returning (contract enforcement).
    const validated = ParseResponseSchema.safeParse(outcome.response);
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 200);
  });

  return app;
}
