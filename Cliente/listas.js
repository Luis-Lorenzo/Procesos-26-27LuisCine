export function dividirListas(elementos = []) {
  const quieroVer = [];
  const vistas = [];
  for (const item of elementos) {
    if (item?.estado === "vistas") vistas.push(item);
    else if (item?.estado === "quiero_ver") quieroVer.push(item);
  }
  return { quieroVer, vistas };
}

export function contarNuevasDisponibles(elementos = []) {
  return elementos.filter(
    item => item?.estado === "quiero_ver" && Boolean(item?.recienDisponible)
  ).length;
}

export function textoAlertaDisponibilidad(elemento) {
  if (!elemento || !elemento.disponibleEnPlataformas) return "";
  const nombres = (elemento.plataformasCoincidentes ?? [])
    .map(p => p?.nombre)
    .filter(Boolean);
  const sufijo = nombres.length ? `: ${nombres.join(", ")}` : "";
  return elemento.recienDisponible
    ? `¡Nueva en tus plataformas!${sufijo}`
    : `Disponible en tus plataformas${sufijo}`;
}
