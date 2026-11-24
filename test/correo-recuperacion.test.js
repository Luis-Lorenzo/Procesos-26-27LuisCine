import test from "node:test";
import assert from "node:assert/strict";

import { crearCorreo } from "../Servidor/correo.js";

test("el adaptador de recuperación envía solo el enlace y mantiene la confirmación", async () => {
  const mensajes = [];
  const env = {
    SMTP_USER: "emisor@gmail.com",
    SMTP_PASSWORD: "abcd efgh ijkl mnop",
    APP_URL: "http://localhost:3000"
  };
  const correo = crearCorreo(env, () => ({
    sendMail: async mensaje => {
      mensajes.push(mensaje);
      return { accepted: [mensaje.to.address] };
    }
  }));

  await correo.enviarRecuperacion({
    email: "destino@example.com",
    enlace: "http://localhost:3000/#recuperar=" + "a".repeat(64)
  });

  assert.equal(mensajes.length, 1);
  const recuperacion = mensajes[0];
  assert.equal(recuperacion.to.address, "destino@example.com");
  assert.equal(recuperacion.from.address, env.SMTP_USER);
  assert.match(recuperacion.subject, /Restablece tu contraseña/);
  assert.match(recuperacion.text, /#recuperar=/);
  assert.match(recuperacion.text, /30 minutos/);
  assert.equal(recuperacion.text.includes("abcd"), false);
  assert.equal(recuperacion.text.toLowerCase().includes("password"), false);

  await correo.enviar({
    email: "destino@example.com",
    enlace: "http://localhost:3000/#confirmar=" + "b".repeat(64)
  });

  assert.equal(mensajes.length, 2);
  assert.match(mensajes[1].subject, /Confirma tu cuenta/);
  assert.match(mensajes[1].text, /#confirmar=/);
});

test("un rechazo del transporte de recuperación se propaga sin aceptar el correo", async () => {
  const correo = crearCorreo({
    SMTP_USER: "emisor@gmail.com",
    SMTP_PASSWORD: "abcd efgh ijkl mnop",
    APP_URL: "http://localhost:3000"
  }, () => ({
    sendMail: async () => ({ accepted: [] })
  }));

  await assert.rejects(
    correo.enviarRecuperacion({
      email: "destino@example.com",
      enlace: "http://localhost:3000/#recuperar=" + "c".repeat(64)
    }),
    /CORREO_NO_ENVIADO/
  );
});
