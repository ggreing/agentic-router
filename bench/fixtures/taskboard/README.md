# taskboard

A small in-memory task management service. No HTTP server: handlers are plain
functions that take a request-like object and return `{ status, body }`, so a
router (or a test) can call them directly.

```
src/
  models/     Task / User types and input validation
  repo/       in-memory repositories (Map-backed)
  service/    business rules: create, assign, status transitions
  handlers/   request -> response adapters, error mapping
  app.ts      createApp(): wires everything together
```

```ts
import { createApp } from './src/index.ts';

const app = createApp({ users: [{ id: 'u1', name: 'Ada', email: 'ada@example.com', active: true }] });
const res = app.handlers.createTask({ body: { title: 'Write docs' } });
// res.status === 201, res.body is the created Task
app.handlers.updateStatus({ params: { id: res.body.id }, body: { status: 'in_progress' } });
```

Error responses look like `{ error: string, details?: string[] }` with status
400 (validation), 404 (not found) or 409 (conflict).

Run the tests with `npm test` (Node 24+, TypeScript runs natively via type stripping).
