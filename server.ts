/**
 * Minimal dev server mounting the AI service handlers (issue #33).
 *
 *   npm run dev            # http://localhost:8787 (AI_PORT to change)
 *
 * Uses the mock provider when HF_TOKEN is unset — set it for real inference.
 * NOT for production: no auth, no TLS, single process. Put a real framework
 * (Next.js/Workers) in front for deployment.
 */

import { createServer } from 'node:http';
import { createAiService } from './src/services/ai/index.js';

const service = createAiService();
const port = Number.parseInt(process.env.AI_PORT ?? '8787', 10);

const routes: Record<string, (req: Request) => Promise<Response>> = {
  '/ai/tutor': service.handlers.tutor,
  '/ai/grammar': service.handlers.grammar,
  '/ai/vocabulary': service.handlers.vocabulary,
  '/ai/quiz': service.handlers.quiz,
  '/ai/writing': service.handlers.writing,
  '/ai/translate': service.handlers.translate,
  '/ai/transcribe': service.handlers.transcribe,
  '/ai/synthesize': service.handlers.synthesize,
  '/ai/embed': service.handlers.embed,
  '/ai/ask': service.handlers.ask,
  '/ai/recommend': service.handlers.recommend,
  '/ai/report': service.handlers.report,
  '/ai/usage': service.handlers.usage,
};

function toRequest(req: import('node:http').IncomingMessage, body: Buffer): Request {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0;
  return new Request(url, {
    method,
    headers,
    ...(hasBody ? { body: new Uint8Array(body) } : {}),
  });
}

const server = createServer((req, res) => {
  void (async () => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const request = toRequest(req, Buffer.concat(chunks));
      const handler = routes[new URL(request.url).pathname];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown route' } }));
        return;
      }
      const response = await handler(request);
      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headers[k] = v;
      });
      res.writeHead(response.status, headers);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: 'INTERNAL', message: err instanceof Error ? err.message : 'error' },
        }),
      );
    }
  })();
});

server.on('error', (err) => {
  if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    console.error(`Port ${port} already in use — another dev server is running, or set AI_PORT.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, '127.0.0.1', () => {
  console.log(`AI dev server → http://127.0.0.1:${port}`);
  console.log(`provider: ${service.providerName} | corpus: ${process.env.AI_CORPUS_INDEX ?? '(none)'}`);
  console.log('routes:', Object.keys(routes).join(', '));
});
