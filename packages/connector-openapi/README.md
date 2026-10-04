# @mcpolyglot/connector-openapi

OpenAPI connector for [mcpolyglot](https://github.com/ishay60/mcpolyglot). Lets an agent call a REST API described by an OpenAPI 3 spec, and nothing outside it.

```ts
{
  id: 'billing',
  kind: 'openapi',
  spec: './openapi.yaml', // file or http(s) URL, JSON or YAML
  baseUrl: 'https://api.example.com/v1',
  auth: { type: 'bearer', token: '${env:BILLING_TOKEN}' },
  allowMethods: ['GET'], // default: GET, HEAD, OPTIONS
}
```

## Tools exposed

- `<id>.list_operations` — operationId, method, path and summary of every callable operation.
- `<id>.describe_operation` — one operation's parameters and request body schema.
- `<id>.call` — call an operation by `operationId` with `path`, `query` and a JSON `body`.

All three need the `http:call` scope.

## What an agent cannot do

1. Call an operation that isn't in the spec, or whose method isn't in `allowMethods`. Those operations aren't listed either.
2. Reach another host. Every request goes to `baseUrl`; the spec's `servers` are ignored, path parameters are encoded (`..` is rejected), and redirects are refused.
3. Send parameters the spec doesn't declare, or any header. Credentials come from config only.
4. Pull an unbounded response: the body is read up to the source's `maxBytes`, then cut.

## Limits

- Header and cookie parameters are not supported.
- Request bodies are JSON only.
- `$ref`s are resolved one level deep; nested refs in a body schema are returned as written.
- `health` reports that the spec loaded; it does not ping the API.

MIT licensed.
