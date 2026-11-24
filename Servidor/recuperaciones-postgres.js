// Persistencia de recuperaciones compartida entre instancias de Cloud Run.
export class RecuperacionesPostgres {
  constructor(pool) {
    this.pool = pool;
  }

  async reservar(email, hash) {
    const cliente = await this.pool.connect();

    try {
      await cliente.query("BEGIN");

      const { rows: [usuario] } = await cliente.query(
        `SELECT id, email FROM usuarios
         WHERE email = $1 AND confirmado AND NOT eliminado
           AND password_hash IS NOT NULL
         FOR UPDATE`,
        [email]
      );

      if (!usuario) {
        await cliente.query("COMMIT");
        return null;
      }

      const { rowCount } = await cliente.query(`
        INSERT INTO recuperaciones_password
          (usuario_id, token_hash, caduca_en, enviado_en, ventana_inicio, cantidad)
        VALUES ($1, $2, clock_timestamp() + INTERVAL '30 minutes',
          clock_timestamp(), clock_timestamp(), 1)
        ON CONFLICT (usuario_id) DO UPDATE SET
          token_hash = EXCLUDED.token_hash,
          caduca_en = EXCLUDED.caduca_en,
          enviado_en = EXCLUDED.enviado_en,
          ventana_inicio = CASE
            WHEN recuperaciones_password.ventana_inicio <= clock_timestamp() - INTERVAL '1 hour'
            THEN clock_timestamp()
            ELSE recuperaciones_password.ventana_inicio END,
          cantidad = CASE
            WHEN recuperaciones_password.ventana_inicio <= clock_timestamp() - INTERVAL '1 hour'
            THEN 1
            ELSE recuperaciones_password.cantidad + 1 END
        WHERE recuperaciones_password.enviado_en <= clock_timestamp() - INTERVAL '60 seconds'
          AND (recuperaciones_password.ventana_inicio <= clock_timestamp() - INTERVAL '1 hour'
            OR recuperaciones_password.cantidad < 5)
        RETURNING usuario_id`,
        [usuario.id, hash]
      );

      if (!rowCount) {
        await cliente.query("COMMIT");
        return null;
      }

      // Cupo global compartido con las confirmaciones; cuenta también fallos SMTP.
      const limite = await cliente.query(`
        UPDATE limite_correo SET
          cantidad = CASE
            WHEN ventana_inicio <= clock_timestamp() - INTERVAL '1 hour' THEN 1
            ELSE cantidad + 1 END,
          ventana_inicio = CASE
            WHEN ventana_inicio <= clock_timestamp() - INTERVAL '1 hour' THEN clock_timestamp()
            ELSE ventana_inicio END
        WHERE id = 1
          AND (ventana_inicio <= clock_timestamp() - INTERVAL '1 hour' OR cantidad < 100)
        RETURNING id`
      );

      if (!limite.rowCount) {
        await cliente.query("ROLLBACK");
        return null;
      }

      await cliente.query("COMMIT");
      return usuario;
    } catch (error) {
      await cliente.query("ROLLBACK");
      throw error;
    } finally {
      cliente.release();
    }
  }

  async esValido(hash) {
    const { rowCount } = await this.pool.query(
      `SELECT 1 FROM recuperaciones_password r
       JOIN usuarios u ON u.id = r.usuario_id
       WHERE r.token_hash = $1
         AND r.caduca_en > clock_timestamp()
         AND u.confirmado AND NOT u.eliminado
         AND u.password_hash IS NOT NULL`,
      [hash]
    );

    return rowCount > 0;
  }

  async consumir(hash, nuevoPasswordHash) {
    const cliente = await this.pool.connect();

    try {
      await cliente.query("BEGIN");

      const { rows: [registro] } = await cliente.query(
        "SELECT usuario_id FROM recuperaciones_password WHERE token_hash = $1",
        [hash]
      );

      if (!registro) {
        await cliente.query("COMMIT");
        return false;
      }

      // Bloquear primero la cuenta serializa consumos concurrentes.
      const { rows: [usuario] } = await cliente.query(
        `SELECT id, confirmado, eliminado, password_hash
         FROM usuarios WHERE id = $1 FOR UPDATE`,
        [registro.usuario_id]
      );

      if (
        !usuario ||
        !usuario.confirmado ||
        usuario.eliminado ||
        !usuario.password_hash
      ) {
        await cliente.query("COMMIT");
        return false;
      }

      // Revalidar y anular el token bajo el bloqueo de la cuenta.
      const token = await cliente.query(
        `UPDATE recuperaciones_password
         SET token_hash = NULL, caduca_en = NULL
         WHERE usuario_id = $1 AND token_hash = $2
           AND caduca_en > clock_timestamp()
         RETURNING usuario_id`,
        [usuario.id, hash]
      );

      if (!token.rowCount) {
        await cliente.query("COMMIT");
        return false;
      }

      await cliente.query(
        "UPDATE usuarios SET password_hash = $2 WHERE id = $1",
        [usuario.id, nuevoPasswordHash]
      );
      await cliente.query(
        "DELETE FROM sesiones WHERE usuario_id = $1",
        [usuario.id]
      );

      await cliente.query("COMMIT");
      return true;
    } catch (error) {
      await cliente.query("ROLLBACK");
      throw error;
    } finally {
      cliente.release();
    }
  }
}
