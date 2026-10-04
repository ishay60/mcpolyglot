---
'@mcpolyglot/connector-openapi': minor
'@mcpolyglot/cli': minor
---

New `@mcpolyglot/connector-openapi`: `kind: 'openapi'` sources now work. Exposes `<id>.list_operations`, `<id>.describe_operation` and `<id>.call` (scope `http:call`) for an OpenAPI 3 spec (JSON or YAML, file or URL). Only operations in the spec whose method is in `allowMethods` (default GET / HEAD / OPTIONS) can be called; requests are pinned to `baseUrl`, only declared path and query parameters are accepted, redirects are refused, and credentials come from config (`${env:...}` supported), never from the model.
