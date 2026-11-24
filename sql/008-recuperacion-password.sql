BEGIN;

-- Un registro por cuenta. Tras consumir el token se conservan los contadores.
CREATE TABLE IF NOT EXISTS recuperaciones_password (
  usuario_id TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE,
  caduca_en TIMESTAMPTZ,
  enviado_en TIMESTAMPTZ NOT NULL,
  ventana_inicio TIMESTAMPTZ NOT NULL,
  cantidad INTEGER NOT NULL CHECK (cantidad > 0)
);

CREATE INDEX IF NOT EXISTS recuperaciones_password_caducidad_idx
  ON recuperaciones_password(caduca_en);

COMMIT;
