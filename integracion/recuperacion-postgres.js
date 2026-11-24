import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";

import { crearPool } from "../Servidor/conexion.js";
import { RecuperacionesPostgres } from "../Servidor/recuperaciones-postgres.js";

const hash = () => createHash("sha256").update(randomUUID()).digest("hex");
const tokenSesion = () =>
  createHash("sha256").update(randomBytes(32)).digest("hex");

async function insertarUsuario(pool, {
  id = randomUUID(),
  email = `${id}@example.invalid`,
  passwordHash = "hash-inicial",
  confirmado = true,
  eliminado = false
} = {}) {
  await pool.query(
    `INSERT INTO usuarios
      (id, nombre, email, confirmado, eliminado, password_hash)
     VALUES ($1, 'Prueba', $2, $3, $4, $5)`,
    [id, email, confirmado, eliminado, passwordHash]
  );
  return { id, email };
}

async function limpiar(pool, ids) {
  await pool.query("DELETE FROM usuarios WHERE id = ANY($1::text[])", [ids]);
}

test("PostgreSQL: recuperación persiste entre pools, caduca y consume una vez", async () => {
  const poolA = crearPool();
  const poolB = crearPool();
  const repoA = new RecuperacionesPostgres(poolA);
  const repoB = new RecuperacionesPostgres(poolB);
  const usuario = await insertarUsuario(poolA);
  const h1 = hash();
  const h2 = hash();

  try {
    assert.ok(await repoA.reservar(usuario.email, h1));
    assert.equal(await repoB.reservar(usuario.email, h2), null);
    assert.equal(await repoB.esValido(h1), true);

    let fila = (await poolB.query(
      "SELECT token_hash, cantidad FROM recuperaciones_password WHERE usuario_id = $1",
      [usuario.id]
    )).rows[0];
    assert.equal(fila.token_hash, h1);
    assert.equal(fila.cantidad, 1);
    assert.equal(fila.token_hash.includes(usuario.email), false);

    await poolB.query(
      `INSERT INTO sesiones (token_hash, usuario_id, caduca_en)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [tokenSesion(), usuario.id]
    );

    await poolA.query(
      `UPDATE recuperaciones_password
       SET enviado_en = clock_timestamp() - INTERVAL '61 seconds'
       WHERE usuario_id = $1`,
      [usuario.id]
    );

    assert.ok(await repoB.reservar(usuario.email, h2));
    assert.equal(await repoA.esValido(h1), false);
    assert.ok(await repoA.consumir(h2, "hash-nuevo"));

    fila = (await poolB.query(
      "SELECT token_hash, caduca_en, cantidad FROM recuperaciones_password WHERE usuario_id = $1",
      [usuario.id]
    )).rows[0];
    assert.equal(fila.token_hash, null);
    assert.equal(fila.caduca_en, null);
    assert.equal(fila.cantidad, 2);
    assert.equal(
      (await poolB.query(
        "SELECT password_hash FROM usuarios WHERE id = $1",
        [usuario.id]
      )).rows[0].password_hash,
      "hash-nuevo"
    );
    assert.equal(
      (await poolB.query(
        "SELECT count(*)::int AS total FROM sesiones WHERE usuario_id = $1",
        [usuario.id]
      )).rows[0].total,
      0
    );
    assert.equal(await repoB.esValido(h2), false);
    assert.equal(await repoA.consumir(h2, "otro-hash"), false);
  } finally {
    await limpiar(poolA, [usuario.id]);
    await poolA.end();
    await poolB.end();
  }
});

test("PostgreSQL: reservas y consumos concurrentes solo permiten uno", async () => {
  const poolA = crearPool();
  const poolB = crearPool();
  const repoA = new RecuperacionesPostgres(poolA);
  const repoB = new RecuperacionesPostgres(poolB);
  const usuario = await insertarUsuario(poolA);
  const h1 = hash();
  const h2 = hash();

  try {
    const reservas = await Promise.all([
      repoA.reservar(usuario.email, h1),
      repoB.reservar(usuario.email, h2)
    ]);
    assert.equal(reservas.filter(Boolean).length, 1);
    const ganador = h1 === (await poolA.query(
      "SELECT token_hash FROM recuperaciones_password WHERE usuario_id = $1",
      [usuario.id]
    )).rows[0].token_hash ? h1 : h2;

    const consumos = await Promise.all([
      repoA.consumir(ganador, "hash-a"),
      repoB.consumir(ganador, "hash-b")
    ]);
    assert.equal(consumos.filter(Boolean).length, 1);

    const final = (await poolA.query(
      "SELECT password_hash FROM usuarios WHERE id = $1",
      [usuario.id]
    )).rows[0].password_hash;
    assert.ok(["hash-a", "hash-b"].includes(final));
    assert.equal(await repoA.consumir(ganador, "hash-c"), false);
  } finally {
    await limpiar(poolA, [usuario.id]);
    await poolA.end();
    await poolB.end();
  }
});

test("PostgreSQL: rollback conserva token, contraseña y sesiones", async () => {
  const pool = crearPool();
  const repo = new RecuperacionesPostgres(pool);
  const usuario = await insertarUsuario(pool, { passwordHash: "hash-original" });
  const h = hash();

  try {
    assert.ok(await repo.reservar(usuario.email, h));
    await pool.query(
      `INSERT INTO sesiones (token_hash, usuario_id, caduca_en)
       VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [tokenSesion(), usuario.id]
    );

    const fallido = new RecuperacionesPostgres({
      async connect() {
        const cliente = await pool.connect();
        const consultar = cliente.query.bind(cliente);
        return {
          async query(texto, parametros) {
            if (/DELETE FROM sesiones/i.test(texto)) {
              throw new Error("fallo simulado");
            }
            return consultar(texto, parametros);
          },
          release: () => cliente.release()
        };
      }
    });

    await assert.rejects(
      fallido.consumir(h, "hash-fallido"),
      /fallo simulado/
    );

    assert.equal(await repo.esValido(h), true);
    assert.equal(
      (await pool.query(
        "SELECT password_hash FROM usuarios WHERE id = $1",
        [usuario.id]
      )).rows[0].password_hash,
      "hash-original"
    );
    assert.equal(
      (await pool.query(
        "SELECT count(*)::int AS total FROM sesiones WHERE usuario_id = $1",
        [usuario.id]
      )).rows[0].total,
      1
    );

    assert.ok(await repo.consumir(h, "hash-recuperado"));
  } finally {
    await limpiar(pool, [usuario.id]);
    await pool.end();
  }
});

test("PostgreSQL: aislamiento entre cuentas, caducidad y cuentas no elegibles", async () => {
  const pool = crearPool();
  const repo = new RecuperacionesPostgres(pool);
  const a = await insertarUsuario(pool);
  const b = await insertarUsuario(pool);
  const pendiente = await insertarUsuario(pool, { confirmado: false });
  const eliminada = await insertarUsuario(pool, { eliminado: true });
  const sinPassword = await insertarUsuario(pool, { passwordHash: null });
  const ha = hash();
  const hb = hash();

  try {
    assert.ok(await repo.reservar(a.email, ha));
    assert.ok(await repo.reservar(b.email, hb));

    assert.ok(await repo.consumir(ha, "hash-a"));
    assert.equal(await repo.esValido(hb), true);
    assert.ok(await repo.consumir(hb, "hash-b"));

    assert.equal(await repo.reservar(pendiente.email, hash()), null);
    assert.equal(await repo.reservar(eliminada.email, hash()), null);
    assert.equal(await repo.reservar(sinPassword.email, hash()), null);
    assert.equal(await repo.reservar("ausente@example.invalid", hash()), null);

    const c = await insertarUsuario(pool);
    const hc = hash();
    assert.ok(await repo.reservar(c.email, hc));
    await pool.query(
      `UPDATE recuperaciones_password
       SET caduca_en = clock_timestamp() - INTERVAL '1 second'
       WHERE usuario_id = $1`,
      [c.id]
    );
    assert.equal(await repo.esValido(hc), false);
    assert.equal(await repo.consumir(hc, "hash-c"), false);

    await limpiar(pool, [c.id]);
  } finally {
    await limpiar(pool, [a.id, b.id, pendiente.id, eliminada.id, sinPassword.id]);
    await pool.end();
  }
});

test("PostgreSQL: límite de 60 segundos y cinco envíos por cuenta y hora", async () => {
  const pool = crearPool();
  const repo = new RecuperacionesPostgres(pool);
  const usuario = await insertarUsuario(pool);
  let enviado = 0;

  try {
    for (let i = 0; i < 5; i++) {
      if (i > 0) {
        await pool.query(
          `UPDATE recuperaciones_password
           SET enviado_en = clock_timestamp() - INTERVAL '61 seconds'
           WHERE usuario_id = $1`,
          [usuario.id]
        );
      }

      assert.ok(await repo.reservar(usuario.email, hash()));
      enviado++;
    }

    await pool.query(
      `UPDATE recuperaciones_password
       SET enviado_en = clock_timestamp() - INTERVAL '61 seconds'
       WHERE usuario_id = $1`,
      [usuario.id]
    );
    assert.equal(await repo.reservar(usuario.email, hash()), null);
    assert.equal(enviado, 5);

    await pool.query(
      `UPDATE recuperaciones_password
       SET enviado_en = clock_timestamp() - INTERVAL '61 seconds',
           ventana_inicio = clock_timestamp() - INTERVAL '61 minutes'
       WHERE usuario_id = $1`,
      [usuario.id]
    );
    assert.ok(await repo.reservar(usuario.email, hash()));
  } finally {
    await limpiar(pool, [usuario.id]);
    await pool.end();
  }
});
