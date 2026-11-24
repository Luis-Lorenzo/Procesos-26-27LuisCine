import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";

import { crearAplicacion } from "../Servidor/api.js";
import { DatosUsuarios } from "../Servidor/datos.js";
import { Sesiones } from "../Servidor/sesiones.js";
import {
  MENSAJE_SOLICITUD_RECUPERACION,
  Recuperaciones,
  RecuperacionesMemoria
} from "../Servidor/recuperaciones.js";
import { crearRegistroActividad } from "../Servidor/actividad.js";

const PASSWORD = "Mi frase secreta para CineMatch";
const PASSWORD_NUEVA = "Una frase nueva y distinta";

async function conApi(comprobar, { conServicio = true } = {}) {
  const datos = new DatosUsuarios();
  const sesiones = new Sesiones();
  let ahora = 1000000;
  const repositorio = new RecuperacionesMemoria(datos, sesiones, () => ahora);
  const correos = [];
  const registros = [];
  const correo = {
    async enviarRecuperacion(mensaje) {
      if (mensaje.email.startsWith("smtp")) {
        throw Object.assign(new Error("SECRETO SMTP"), { code: "EAUTH" });
      }
      correos.push(mensaje);
    }
  };
  const recuperaciones = conServicio
    ? new Recuperaciones({
      repositorio,
      correo,
      urlPublica: "https://cinematch.example",
      registrarActividad: crearRegistroActividad({
        escribir: linea => registros.push(JSON.parse(linea))
      })
    })
    : null;
  const app = crearAplicacion({
    datos,
    sesiones,
    recuperaciones,
    cookieSegura: false,
    registrarActividad: crearRegistroActividad({
      escribir: linea => registros.push(JSON.parse(linea))
    })
  });

  app.servidor.listen(0, "127.0.0.1");
  await once(app.servidor, "listening");

  const base = `http://127.0.0.1:${app.servidor.address().port}`;

  function pedir(ruta, {
    metodo = "POST",
    cuerpo,
    bruto,
    headers = {},
    proteccion = true
  } = {}) {
    const cabeceras = {
      ...(proteccion ? { "X-CineMatch": "1" } : {}),
      ...headers
    };

    if (
      (cuerpo !== undefined || bruto !== undefined) &&
      !Object.hasOwn(headers, "Content-Type")
    ) {
      cabeceras["Content-Type"] = "application/json";
    }

    return fetch(base + ruta, {
      method: metodo,
      headers: cabeceras,
      body: bruto ?? (cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined)
    });
  }

  const token = () => {
    const enlace = new URL(correos.at(-1).enlace);
    return new URLSearchParams(enlace.hash.slice(1)).get("recuperar");
  };

  try {
    await comprobar({
      app,
      base,
      datos,
      sesiones,
      repositorio,
      correos,
      registros,
      pedir,
      token,
      avanzar: ms => { ahora += ms; }
    });
  } finally {
    app.servidor.closeAllConnections();
    await new Promise(resolve => app.servidor.close(resolve));
  }
}

async function crearCuenta(app, {
  email = "prueba@example.com",
  confirmado = true
} = {}) {
  const usuario = await app.logica.registrar({
    nombre: "Prueba",
    email,
    password: PASSWORD
  });

  if (confirmado) await app.logica.confirmar(usuario.id);

  return usuario;
}

test("API recuperación: métodos, cabecera, JSON, query y servicio ausente", async () => {
  await conApi(async ({ pedir }) => {
    for (const metodo of ["GET", "PUT", "DELETE", "PATCH"]) {
      const respuesta = await pedir("/api/password/solicitar", { metodo });
      assert.equal(respuesta.status, 405);
      assert.equal(respuesta.headers.get("allow"), "POST");
    }

    assert.equal((await pedir("/api/password/solicitar", {
      cuerpo: { email: "prueba@example.com" },
      proteccion: false
    })).status, 403);
    assert.equal((await pedir("/api/password/solicitar?email=x", {
      cuerpo: { email: "prueba@example.com" }
    })).status, 400);
    assert.equal((await pedir("/api/password/solicitar", {
      cuerpo: { email: "prueba@example.com" },
      headers: { "Content-Type": "text/plain" }
    })).status, 415);
    assert.equal((await pedir("/api/password/solicitar", { bruto: "{" })).status, 400);
    assert.equal((await pedir("/api/password/solicitar", {
      cuerpo: { email: "prueba@example.com", extra: true }
    })).status, 400);
    assert.equal((await pedir("/api/password/restablecer", {
      cuerpo: { token: "0".repeat(64), password: PASSWORD_NUEVA }
    })).status, 400);
  });

  await conApi(async ({ pedir }) => {
    const respuesta = await pedir("/api/password/solicitar", {
      cuerpo: { email: "prueba@example.com" }
    });
    assert.equal(respuesta.status, 503);
  }, { conServicio: false });
});

test("API recuperación: email malformado devuelve 400", async () => {
  await conApi(async ({ pedir }) => {
    const respuesta = await pedir("/api/password/solicitar", {
      cuerpo: { email: "no-es-un-correo" }
    });
    assert.equal(respuesta.status, 400);
    assert.equal((await respuesta.json()).codigo, "EMAIL_INVALIDO");
  });
});

test("API recuperación: mismo 202 genérico sin revelar estado ni token", async () => {
  await conApi(async ({ app, pedir, correos, registros, token }) => {
    const local = await crearCuenta(app);
    const pendiente = await app.logica.registrar({
      nombre: "Pendiente",
      email: "pendiente@example.com",
      password: PASSWORD
    });
    const eliminada = await crearCuenta(app, { email: "eliminada@example.com" });
    await app.logica.eliminar(eliminada.id);
    const google = await app.logica.autenticarGoogle({
      sub: "google-api-recuperacion",
      email: "google@example.com",
      nombre: "Google",
      emailVerificado: true
    });
    await crearCuenta(app, { email: "smtp@example.com" });

    const casos = [
      local.email,
      "ausente@example.com",
      pendiente.email,
      eliminada.email,
      google.email,
      local.email,
      "smtp@example.com"
    ];

    for (const email of casos) {
      const respuesta = await pedir("/api/password/solicitar", {
        cuerpo: { email }
      });
      assert.equal(respuesta.status, 202);
      assert.equal(respuesta.headers.get("set-cookie"), null);
      assert.deepEqual(await respuesta.json(), {
        mensaje: MENSAJE_SOLICITUD_RECUPERACION
      });
    }

    assert.equal(correos.length, 1);
    const enviado = token();
    assert.match(enviado, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(registros).includes(enviado), false);
    assert.equal(JSON.stringify(registros).includes(local.email), false);
  });
});

test("API recuperación: restablecer sin login automático, revoca sesión y no consume con contraseña inválida", async () => {
  await conApi(async ({ app, base, pedir, token }) => {
    const usuario = await crearCuenta(app);

    const login = await pedir("/api/login", {
      cuerpo: { email: usuario.email, password: PASSWORD }
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    assert.equal((await pedir("/api/password/solicitar", {
      cuerpo: { email: usuario.email }
    })).status, 202);
    const recuperacion = token();

    const corta = await pedir("/api/password/restablecer", {
      cuerpo: { token: recuperacion, password: "corta" }
    });
    assert.equal(corta.status, 400);
    assert.equal((await corta.json()).codigo, "PASSWORD_INVALIDA");

    const exito = await pedir("/api/password/restablecer", {
      cuerpo: { token: recuperacion, password: PASSWORD_NUEVA }
    });
    assert.equal(exito.status, 200);
    assert.equal(exito.headers.get("set-cookie"), null);
    assert.deepEqual(await exito.json(), {
      mensaje: "Contraseña actualizada. Inicia sesión con tu nueva contraseña."
    });

    assert.equal((await fetch(`${base}/api/sesion`, {
      headers: { Cookie: cookie }
    })).status, 401);
    assert.equal((await pedir("/api/login", {
      cuerpo: { email: usuario.email, password: PASSWORD }
    })).status, 401);
    assert.equal((await pedir("/api/login", {
      cuerpo: { email: usuario.email, password: PASSWORD_NUEVA }
    })).status, 200);

    const replay = await pedir("/api/password/restablecer", {
      cuerpo: { token: recuperacion, password: PASSWORD_NUEVA }
    });
    assert.equal(replay.status, 400);
    assert.equal((await replay.json()).codigo, "RECUPERACION_INVALIDA");
  });
});

test("API recuperación: token inválido, campos extra y query no cambian la contraseña", async () => {
  await conApi(async ({ app, pedir }) => {
    const usuario = await crearCuenta(app);

    const falso = await pedir("/api/password/restablecer", {
      cuerpo: { token: "0".repeat(64), password: PASSWORD_NUEVA }
    });
    assert.equal(falso.status, 400);
    assert.equal((await falso.json()).codigo, "RECUPERACION_INVALIDA");

    assert.equal((await pedir("/api/password/restablecer?token=x", {
      cuerpo: { token: "0".repeat(64), password: PASSWORD_NUEVA }
    })).status, 400);

    assert.equal((await pedir("/api/password/restablecer", {
      cuerpo: { token: "0".repeat(64), password: PASSWORD_NUEVA, extra: true }
    })).status, 400);

    assert.equal((await pedir("/api/password/restablecer", {
      cuerpo: { token: "0".repeat(64), password: PASSWORD_NUEVA },
      proteccion: false
    })).status, 403);

    assert.equal((await pedir("/api/login", {
      cuerpo: { email: usuario.email, password: PASSWORD }
    })).status, 200);
  });
});
