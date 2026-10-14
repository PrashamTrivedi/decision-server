-- MCP OAuth: dynamically registered public clients, single-use auth codes, opaque rotating tokens.
-- Codes and tokens are stored as SHA-256 hashes, never in plaintext.
CREATE TABLE oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,                -- JSON array, matched exactly
  created_at    INTEGER NOT NULL              -- epoch ms
);

CREATE TABLE oauth_codes (
  code_hash      TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,               -- PKCE S256
  email          TEXT NOT NULL,               -- Access identity that approved
  expires_at     INTEGER NOT NULL             -- epoch ms
);
CREATE INDEX oauth_codes_exp ON oauth_codes (expires_at);

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,                   -- access | refresh
  client_id  TEXT NOT NULL,
  email      TEXT NOT NULL,
  expires_at INTEGER NOT NULL                 -- epoch ms
);
CREATE INDEX oauth_tokens_exp ON oauth_tokens (expires_at);
