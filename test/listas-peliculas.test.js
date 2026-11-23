import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";

import { crearAplicacion } from "../Servidor/api.js";
import { DatosUsuarios } from "../Servidor/datos.js";
import { Sesiones } from "../Servidor/sesiones.js";
import { PreferenciasPlataformas } from "../Servidor/preferencias-plataformas.js";
import { ListasPeliculas, ErrorListas } from "../Servidor/listas-peliculas.js";
import {
  contarNuevasDisponibles,
  dividirListas,
  textoAlertaDisponibilidad
} from "../Cliente/listas.js";

test("ListasPeliculas: guarda, mueve entre estados, detecta nueva disponibilidad y elimina", async () => {
  const datos = new DatosUsuarios();
  const usuarioId = randomUUID();
  await datos.guardar({
    id: usuarioId,
    nombre: "Ana",
    email: "ana@example.invalid",
    confirmado: true,
    eliminado: false,
    rol: "usuario"
  });

  const listas = new ListasPeliculas(datos);
  const guardado = await listas.guardar(usuarioId, {
    peliculaId: 550,
    estado: "quiero_ver",
    titulo: "El club de la lucha",
    anio: 1999,
    cartel: "https://image.tmdb.org/t/p/w500/cartel.jpg"
  });

  assert.equal(guardado.peliculaId, 550);
  assert.equal(guardado.estado, "quiero_ver");
  assert.equal(guardado.disponibleEnPlataformas, false);
  assert.equal(guardado.recienDisponible, false);

  const actualizada = await listas.actualizarDisponibilidad(usuarioId, 550, {
    disponibleEnPlataformas: true,
    plataformasCoincidentes: [{ id: 8, nombre: "Netflix", logo: null }]
  });
  assert.equal(actualizada.disponibleEnPlataformas, true);
  assert.equal(actualizada.recienDisponible, true);
  assert.equal(actualizada.plataformasCoincidentes[0].nombre, "Netflix");

  const movida = await listas.guardar(usuarioId, {
    peliculaId: 550,
    estado: "vistas",
    titulo: "El club de la lucha",
    anio: 1999,
    cartel: null
  });
  assert.equal(movida.estado, "vistas");

  const { elementos } = await listas.listar(usuarioId);
  assert.equal(elementos.length, 1);

  await listas.eliminar(usuarioId, 550);
  assert.equal((await listas.listar(usuarioId)).elementos.length, 0);
  await assert.rejects(() => listas.eliminar(usuarioId, 550), ErrorListas);
});

test("Cliente/listas.js: divide listas, cuenta nuevas disponibles y formatea alerta", () => {
  const elementos = [
    {
      peliculaId: 1,
      estado: "quiero_ver",
      disponibleEnPlataformas: true,
      recienDisponible: true,
      plataformasCoincidentes: [{ id: 8, nombre: "Netflix" }]
    },
    {
      peliculaId: 2,
      estado: "vistas",
      disponibleEnPlataformas: false,
      recienDisponible: false,
      plataformasCoincidentes: []
    }
  ];

  const { quieroVer, vistas } = dividirListas(elementos);
  assert.equal(quieroVer.length, 1);
  assert.equal(vistas.length, 1);
  assert.equal(contarNuevasDisponibles(elementos), 1);
  assert.equal(textoAlertaDisponibilidad(elementos[0]), "¡Nueva en tus plataformas!: Netflix");
});

test("API listas: protege rutas, guarda películas y detecta alertas al comprobar disponibilidad", async () => {
  const datos = new DatosUsuarios();
  const sesiones = new Sesiones();
  const preferencias = new PreferenciasPlataformas(datos);
  const usuarioId = randomUUID();
  await datos.guardar({
    id: usuarioId,
    nombre: "Luis",
    email: "luis@example.invalid",
    confirmado: true,
    eliminado: false,
    rol: "usuario"
  });
  const token = await sesiones.crear(usuarioId);
  const cookie = `cinematch_sesion=${token}`;

  let suscripcionActual = [];
  const disponibilidad = {
    async obtener(id) {
      return {
        id: Number(id),
        region: "ES",
        suscripcion: suscripcionActual
      };
    }
  };

  const { servidor } = crearAplicacion({
    datos,
    sesiones,
    preferencias,
    disponibilidad,
    cookieSegura: false
  });

  servidor.listen(0, "127.0.0.1");
  await once(servidor, "listening");
  const base = `http://127.0.0.1:${servidor.address().port}`;

  try {
    const sinSesion = await fetch(`${base}/api/listas`);
    assert.equal(sinSesion.status, 401);

    const guardar = await fetch(`${base}/api/listas/603`, {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "X-CineMatch": "1",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        estado: "quiero_ver",
        titulo: "Matrix",
        anio: 1999
      })
    });
    assert.equal(guardar.status, 200);
    const { elemento } = await guardar.json();
    assert.equal(elemento.disponibleEnPlataformas, false);

    // Ahora la película pasa a estar incluida en una plataforma del usuario.
    suscripcionActual = [{ id: 8, nombre: "Netflix", logo: null, incluida: true }];
    const comprobar = await fetch(`${base}/api/listas/comprobar`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CineMatch": "1"
      }
    });
    assert.equal(comprobar.status, 200);
    const resultado = await comprobar.json();
    assert.equal(resultado.nuevasDisponibles, 1);
    assert.equal(resultado.elementos[0].recienDisponible, true);
    assert.equal(resultado.elementos[0].plataformasCoincidentes[0].nombre, "Netflix");

    const borrar = await fetch(`${base}/api/listas/603`, {
      method: "DELETE",
      headers: {
        Cookie: cookie,
        "X-CineMatch": "1"
      }
    });
    assert.equal(borrar.status, 204);
  } finally {
    servidor.closeAllConnections();
    await new Promise(resolve => servidor.close(resolve));
  }
});
