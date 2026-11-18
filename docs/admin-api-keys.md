# Managing API keys

All `/admin/keys` routes require the `ADMIN_TOKEN` configured by the operator.
The token can be sent in `X-Admin-Token` or as a bearer token.

`GET /admin/keys` returns the live keys by default. It returns key identifiers,
labels, scopes, rate and quota settings, creation time, expiry, last-used time
(`lastUsedAt`, null if the key has never authenticated) and revocation state; it
never returns the stored hash or plaintext key.

Pagination uses `limit` and `offset`. The default page size is 50 and the
maximum is 100. Set `revoked=true` to list revoked keys instead; the default
`revoked=false` view hides them.

```http
GET /admin/keys?limit=50&offset=0&revoked=false
X-Admin-Token: <admin-token>
```

The response contains a `keys` array and `pagination` metadata including the
total number of records matching the revoked filter.
