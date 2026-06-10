// Cloudflare Workers production entry. Exports the module-worker fetch handler
// the Workers runtime invokes with `(request, env, ctx)`.
//
// Runtime boundary: this entry is the runtime adapter only. It reuses the same
// runtime-agnostic app factory as the Node dev entry (`server.ts`) via
// `buildApp()`, differing ONLY in the injected governance.
//
// PUBLIC-ENDPOINT WIDE-OPEN GUARDRAIL: production MUST inject the REAL
// governance. `buildApp()` wires `createRealGovernance()`. This module MUST NOT
// import or reference the pass-through no-op governance — doing so would make
// the public API run with no auth / no rate-limit and the smoke tests would
// still pass, so the omission is enforced mechanically (grep + entry-level
// integration test in `worker.test.ts`).
import type { ExecutionContext } from '@cloudflare/workers-types';
import { buildApp } from './index.js';
import type { Bindings } from './bindings.js';

const app = buildApp();

export default {
  fetch: (request: Request, env: Bindings, ctx: ExecutionContext) =>
    app.fetch(request, env, ctx),
};
