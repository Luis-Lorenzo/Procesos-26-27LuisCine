import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { DatosUsuarios } from "../Servidor/datos.js";
import { LogicaUsuarios } from "../Servidor/logica.js";
import { Sesiones } from "../Servidor/sesiones.js";
import {
  Recuperaciones,
  RecuperacionesMemoria,
  hashRecuperacion
} from "../Servidor/recuperaciones.js";
import { crearRegistroActividad } from "../Servidor/actividad.js";

const PASSWORD = "Mi frase secreta para CineMatch";
const PASSWORD_NUEVA = "Una frase nueva y distinta";
const PASSWORD_OTRA = "Otra frase también distinta";

function preparar() {
  const datos = new DatosUsuarios();
  const logica = new LogicaUsuarios(datos);
  let ahora = 10000000;
  const sesiones = new Sesiones({ reloj: () => ahora });
  const repositorio = new RecuperacionesMemoria(
    datos,
    sesiones,
    () => ahora
  );
  const correos = [];
  const registros = [];
  const servicio = new Recuperaciones({
    repositorio,
    correo: {
      enviarRecuperacion: async correo => { correos.push(correo); }
    },
    urlPublica: "https://cinematch.example",
    registrarActividad: crearRegistroActividad({
      escribir: linea => registros.push(JSON.parse(linea))
    })
  });

  return {
    datos,
    logica,
    sesiones,
    repositorio,
    servicio,
    correos,
    registros,
    avanzar: ms => { ahora += ms; },
    token: () => {
      const enlace = new URL(correos.at(-1).enlace);
      return new URLSearchParams(enlace.hash.slice(1)).get("recuperar");
    }
  };
}

async function crearCuenta(p, {
  email = "prueba@example.com",
  password = PASSWORD,
  confirmado = true
} = {}) {
  const usuario = await p.logica.registrar({
    nombre: "Prueba",
    email,
    password
  });

  if (confirmado) await p.logica.confirmar(usuario.id);

  return usuario;
}

async function crearCuentaDirecta(p, email) {
  return p.datos.crearConHash({
    id: randomUUID(),
    nombre: "Prueba",
    email,
    rol: "usuario",
    confirmado: true,
    eliminado: false
  }, "hash-ficticio");
}

test("solicitar envía enlace con token solo en hash y restablecer cambia la contraseña", async () => {
  const p = preparar();
  const usuario = await crearCuenta(p);
  const sesionAnterior = p.sesiones.crear(usuario.id);

  assert.ok(p.sesiones.obtener(sesionAnterior));
  assert.equal(await p.servicio.solicitar(" PRUEBA@example.com "), true);

  const token = p.token();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal(p.repositorio.registros.get(usuario.id).hash, hashRecuperacion(token));
  assert.equal(JSON.stringify([...p.repositorio.registros]).includes(token), false);
  assert.equal(JSON.stringify(p.registros).includes(token), false);

  assert.equal(await p.servicio.restablecer(token, PASSWORD_NUEVA), true);

  await assert.rejects(
    p.logica.autenticar({ email: usuario.email, password: PASSWORD }),
    { codigo: "CREDENCIALES_INVALIDAS" }
  );
  const activo = await p.logica.autenticar({
    email: usuario.email,
    password: PASSWORD_NUEVA
  });
  assert.equal(activo.id, usuario.id);
  assert.equal(activo.rol, "usuario");
  assert.equal(p.sesiones.obtener(sesionAnterior), null);
  await assert.rejects(
    p.servicio.restablecer(token, PASSWORD_OTRA),
    { codigo: "RECUPERACION_INVALIDA" }
  );
  assert.equal(JSON.stringify(p.registros).includes(token), false);
});

test("reenviar invalida el token anterior y respeta los 60 segundos", async () => {
  const p = preparar();
  const usuario = await crearCuenta(p);

  assert.equal(await p.servicio.solicitar(usuario.email), true);
  const anterior = p.token();
  assert.equal(await p.servicio.solicitar(usuario.email), false);

  p.avanzar(60000);
  assert.equal(await p.servicio.solicitar(usuario.email), true);
  const nuevo = p.token();
  assert.notEqual(nuevo, anterior);

  await assert.rejects(
    p.servicio.restablecer(anterior, PASSWORD_NUEVA),
    { codigo: "RECUPERACION_INVALIDA" }
  );
  assert.equal(await p.servicio.restablecer(nuevo, PASSWORD_NUEVA), true);
});

test("el token caduca exactamente a los 30 minutos y el consumo simultáneo solo triunfa una vez", async () => {
  const p = preparar();
  const usuario = await crearCuenta(p);
  await p.servicio.solicitar(usuario.email);
  const token = p.token();

  p.avanzar(30 * 60 * 1000 - 1);
  assert.equal(await p.repositorio.esValido(hashRecuperacion(token)), true);
  p.avanzar(1);
  assert.equal(await p.repositorio.esValido(hashRecuperacion(token)), false);
  await assert.rejects(
    p.servicio.restablecer(token, PASSWORD_NUEVA),
    { codigo: "RECUPERACION_INVALIDA" }
  );

  const concurrente = preparar();
  const cuenta = await crearCuenta(concurrente);
  await concurrente.servicio.solicitar(cuenta.email);
  const unico = concurrente.token();

  const resultados = await Promise.allSettled([
    concurrente.servicio.restablecer(unico, PASSWORD_NUEVA),
    concurrente.servicio.restablecer(unico, PASSWORD_OTRA)
  ]);

  assert.equal(resultados.filter(resultado => resultado.status === "fulfilled").length, 1);
  await assert.rejects(
    concurrente.servicio.restablecer(unico, PASSWORD_NUEVA),
    { codigo: "RECUPERACION_INVALIDA" }
  );
});

test("una contraseña inválida no consume el token y un token inventado no calcula scrypt", async () => {
  const p = preparar();
  const usuario = await crearCuenta(p);
  await p.servicio.solicitar(usuario.email);
  const token = p.token();

  await assert.rejects(
    p.servicio.restablecer(token, "corta"),
    { codigo: "PASSWORD_INVALIDA" }
  );
  assert.equal(await p.repositorio.esValido(hashRecuperacion(token)), true);
  assert.equal(await p.servicio.restablecer(token, PASSWORD_NUEVA), true);

  let hashesCalculados = 0;
  const sinScrypt = new Recuperaciones({
    repositorio: p.repositorio,
    correo: { enviarRecuperacion: async () => {} },
    urlPublica: "https://cinematch.example",
    crearHash: async () => { hashesCalculados++; return "hash-inventado"; }
  });

  await assert.rejects(
    sinScrypt.restablecer("0".repeat(64), PASSWORD_NUEVA),
    { codigo: "RECUPERACION_INVALIDA" }
  );
  assert.equal(hashesCalculados, 0);
});

test("inexistentes, pendientes, eliminadas y cuentas solo Google no reciben correo", async () => {
  const p = preparar();
  await crearCuenta(p, { email: "pendiente@example.com", confirmado: false });
  const eliminada = await crearCuenta(p, { email: "eliminada@example.com" });
  await p.logica.eliminar(eliminada.id);
  const google = await p.logica.autenticarGoogle({
    sub: "google-recuperacion",
    email: "google@example.com",
    nombre: "Google",
    emailVerificado: true
  });

  for (const email of [
    "ausente@example.com",
    "pendiente@example.com",
    "eliminada@example.com",
    "google@example.com"
  ]) {
    assert.equal(await p.servicio.solicitar(email), false);
  }

  assert.equal(p.correos.length, 0);
  assert.equal(p.datos.passwords.has(google.id), false);
});

test("se aplican cinco envíos por cuenta y hora y cien envíos globales por hora", async () => {
  const p = preparar();
  const usuario = await crearCuentaDirecta(p, "limite@example.com");

  assert.equal(await p.servicio.solicitar(usuario.email), true);
  assert.equal(await p.servicio.solicitar(usuario.email), false);

  for (let i = 1; i < 5; i++) {
    p.avanzar(60000);
    assert.equal(await p.servicio.solicitar(usuario.email), true);
  }

  p.avanzar(60000);
  assert.equal(await p.servicio.solicitar(usuario.email), false);
  p.avanzar(3600000);
  assert.equal(await p.servicio.solicitar(usuario.email), true);

  const global = preparar();
  for (let i = 0; i < 101; i++) {
    await crearCuentaDirecta(global, `global-${i}@example.com`);
    assert.equal(await global.servicio.solicitar(`global-${i}@example.com`), i < 100);
  }
  assert.equal(global.correos.length, 100);
});

test("un fallo SMTP no cambia la contraseña ni filtra secretos en los registros", async () => {
  const p = preparar();
  const usuario = await crearCuenta(p);
  const hashOriginal = await p.datos.buscarHashPassword(usuario.id);

  p.servicio.correo.enviarRecuperacion = async () => {
    throw Object.assign(new Error("SECRETO token password"), { code: "EAUTH" });
  };

  assert.equal(await p.servicio.solicitar(usuario.email), false);
  assert.equal(await p.datos.buscarHashPassword(usuario.id), hashOriginal);
  assert.equal(p.registros.at(-1).codigo, "EAUTH");
  assert.equal(JSON.stringify(p.registros).includes("SECRETO"), false);

  p.avanzar(60000);
  p.servicio.correo.enviarRecuperacion = async correo => p.correos.push(correo);
  assert.equal(await p.servicio.solicitar(usuario.email), true);
  assert.equal(await p.servicio.restablecer(p.token(), PASSWORD_NUEVA), true);
});

test("una cuenta eliminada o un token rotado no restablecen la contraseña", async () => {
  const p = preparar();
  const usuario = await crearCuenta(p);
  await p.servicio.solicitar(usuario.email);
  const token = p.token();

  await p.logica.eliminar(usuario.id);
  assert.equal(await p.repositorio.esValido(hashRecuperacion(token)), false);
  await assert.rejects(
    p.servicio.restablecer(token, PASSWORD_NUEVA),
    { codigo: "RECUPERACION_INVALIDA" }
  );

  const otro = preparar();
  const cuenta = await crearCuenta(otro);
  await otro.servicio.solicitar(cuenta.email);
  const viejo = otro.token();
  otro.avanzar(60000);
  await otro.servicio.solicitar(cuenta.email);
  const nuevo = otro.token();

  await assert.rejects(
    otro.servicio.restablecer(viejo, PASSWORD_NUEVA),
    { codigo: "RECUPERACION_INVALIDA" }
  );
  assert.equal(await otro.servicio.restablecer(nuevo, PASSWORD_NUEVA), true);
});
