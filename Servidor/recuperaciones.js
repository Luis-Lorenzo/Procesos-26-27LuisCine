// Recuperación de contraseña local. El token nunca se guarda en claro.
import { createHash, randomBytes } from "node:crypto";
import { normalizarEmail } from "./logica.js";
import { generarHash as generarHashPassword } from "./passwords.js";

export const DURACION_RECUPERACION_MS = 30 * 60 * 1000;
export const VENTANA_CUENTA_MS = 60 * 60 * 1000;
export const ESPERA_REENVIO_MS = 60 * 1000;
export const MAXIMO_CUENTA_HORA = 5;
export const MAXIMO_GLOBAL_HORA = 100;
export const MENSAJE_SOLICITUD_RECUPERACION =
  "Si el correo corresponde a una cuenta local confirmada, recibirás un enlace para restablecer la contraseña. Revisa también spam. El enlace caduca en 30 minutos.";

export const hashRecuperacion = token =>
  createHash("sha256").update(token).digest("hex");

export class ErrorRecuperacion extends Error {
  constructor(codigo, mensaje, estado = 400) {
    super(mensaje);
    this.name = "ErrorRecuperacion";
    this.codigo = codigo;
    this.estado = estado;
  }
}

const CODIGOS_CORREO = new Set([
  "EAUTH", "ETIMEDOUT", "ECONNECTION", "ESOCKET", "EENVELOPE"
]);

export class Recuperaciones {
  constructor({
    repositorio,
    correo,
    urlPublica,
    registrarActividad = () => {},
    crearHash = generarHashPassword
  }) {
    Object.assign(this, { repositorio, correo, urlPublica, registrarActividad, crearHash });
  }

  async solicitar(email) {
    const normalizado = normalizarEmail(email);
    const token = randomBytes(32).toString("hex");
    const usuario = await this.repositorio.reservar(
      normalizado,
      hashRecuperacion(token)
    );

    if (!usuario) return false;

    const enlace = new URL("/", this.urlPublica);
    enlace.hash = `recuperar=${token}`;

    try {
      await this.correo.enviarRecuperacion({
        email: usuario.email,
        enlace: enlace.href
      });
      this.registrarActividad("recuperacion_enviada", {});
      return true;
    } catch (error) {
      this.registrarActividad("error_correo", {
        codigo: CODIGOS_CORREO.has(error?.code)
          ? error.code
          : "CORREO_NO_ENVIADO"
      });
      return false;
    }
  }

  async restablecer(token, password) {
    const invalido = () => new ErrorRecuperacion(
      "RECUPERACION_INVALIDA",
      "El enlace no es válido, ha caducado o ya se utilizó. Solicita uno nuevo."
    );

    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) {
      throw invalido();
    }

    const hash = hashRecuperacion(token);

    // Evita calcular scrypt con tokens inventados o ya invalidados.
    if (!await this.repositorio.esValido(hash)) throw invalido();

    let nuevoHash;

    try {
      nuevoHash = await this.crearHash(password);
    } catch (error) {
      if (
        typeof password !== "string" ||
        [...password].length < 8 ||
        [...password].length > 128
      ) {
        throw new ErrorRecuperacion(
          "PASSWORD_INVALIDA",
          "La contraseña debe tener entre 8 y 128 caracteres."
        );
      }

      throw error;
    }

    // El token puede haber caducado o consumido mientras se calculaba el hash.
    if (!await this.repositorio.consumir(hash, nuevoHash)) throw invalido();

    this.registrarActividad("password_restablecida", {});
    return true;
  }
}

// Adaptador en memoria: comparte usuarios, hashes y sesiones con la aplicación.
export class RecuperacionesMemoria {
  constructor(datos, sesiones, reloj = () => Date.now()) {
    this.datos = datos;
    this.sesiones = sesiones;
    this.reloj = reloj;
    this.registros = new Map();
    this.envios = [];
  }

  cuentaLocal(email) {
    const usuario = [...this.datos.usuarios.values()].find(
      candidato => !candidato.eliminado && candidato.email === email
    );

    if (
      !usuario ||
      !usuario.confirmado ||
      !this.datos.passwords.has(usuario.id)
    ) {
      return null;
    }

    return usuario;
  }

  async reservar(email, hash) {
    const ahora = this.reloj();
    this.envios = this.envios.filter(enviado => enviado > ahora - VENTANA_CUENTA_MS);

    const usuario = this.cuentaLocal(email);
    if (!usuario) return null;

    const previo = this.registros.get(usuario.id);
    const mismaVentana = previo && previo.ventanaInicio > ahora - VENTANA_CUENTA_MS;

    if (previo && previo.enviado > ahora - ESPERA_REENVIO_MS) return null;
    if (mismaVentana && previo.cantidad >= MAXIMO_CUENTA_HORA) return null;
    if (this.envios.length >= MAXIMO_GLOBAL_HORA) return null;

    this.registros.set(usuario.id, {
      hash,
      caduca: ahora + DURACION_RECUPERACION_MS,
      enviado: ahora,
      ventanaInicio: mismaVentana ? previo.ventanaInicio : ahora,
      cantidad: mismaVentana ? previo.cantidad + 1 : 1
    });
    this.envios.push(ahora);

    return { ...usuario };
  }

  async esValido(hash) {
    const ahora = this.reloj();

    for (const [usuarioId, registro] of this.registros) {
      if (registro.hash !== hash) continue;

      const usuario = this.datos.usuarios.get(usuarioId);

      return Boolean(
        registro.caduca > ahora &&
        usuario &&
        usuario.confirmado &&
        !usuario.eliminado &&
        this.datos.passwords.has(usuarioId)
      );
    }

    return false;
  }

  async consumir(hash, nuevoPasswordHash) {
    const ahora = this.reloj();

    for (const [usuarioId, registro] of this.registros) {
      if (registro.hash !== hash) continue;

      const usuario = this.datos.usuarios.get(usuarioId);

      if (
        registro.caduca <= ahora ||
        !usuario ||
        !usuario.confirmado ||
        usuario.eliminado ||
        !this.datos.passwords.has(usuarioId)
      ) {
        return false;
      }

      // Sin await entre mutaciones: ningún otro consumidor puede adelantarse.
      this.datos.passwords.set(usuarioId, nuevoPasswordHash);
      this.sesiones.eliminarDeUsuario(usuarioId);
      registro.hash = null;
      registro.caduca = 0;
      return true;
    }

    return false;
  }
}
