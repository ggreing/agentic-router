# confkit

Layered configuration for our services. Layers are merged in order, later wins:

1. `defaults` (a plain object in code)
2. `sources` — INI documents (`[section]`, `key = value`, `#`/`;` comments)
3. `env` — environment variables with a prefix (`APP_DB__HOST` -> `db.host`)

```ts
import { loadConfig, parseDuration } from './src/index.ts';

const config = loadConfig({
  defaults: { port: 3000, db: { host: 'localhost' } },
  sources: [iniText],
  env: process.env,
  envPrefix: 'APP_',
});
parseDuration('1m30s'); // 90000
```

INI values are coerced (`true`/`false`, numbers); environment values stay strings.

Run the tests with `npm test` (Node 24+, TypeScript runs natively via type stripping).
