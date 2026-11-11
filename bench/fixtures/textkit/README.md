# textkit

Small, dependency-free string helpers used across our internal tools.

| Function | Module |
| --- | --- |
| `slugify(text)` | `src/slugify.ts` |
| `truncate(text, maxLength, { ellipsis })` | `src/truncate.ts` |
| `wordWrap(text, width)` | `src/wrap.ts` |
| `camelCase`, `pascalCase`, `snakeCase`, `kebabCase`, `titleCase`, `splitWords` | `src/case.ts` |
| `interpolate(template, values, { strict })` | `src/template.ts` |
| `wordCount`, `charCount` | `src/count.ts` |

Everything is re-exported from `src/index.ts`.

Requires Node 24+ (TypeScript runs natively via type stripping). Run the tests with `npm test`.
