// Lógica de despensa y recetas. NO sabe nada de MCP: se prueba sola (npm run test:store)
// y MCP queda como la "puerta de entrada" a estas funciones.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type UnidadBase = "g" | "ml" | "pza";

export interface ItemDespensa { nombre: string; cantidad: number; unidad: UnidadBase }
export interface IngredienteReceta { nombre: string; cantidad: number; unidad: UnidadBase }
export interface Receta { nombre: string; minutos: number; porciones: number; ingredientes: IngredienteReceta[]; pasos: string[] }

export type Resultado<T> = ({ ok: true } & T) | { ok: false; error: string };

const ARCHIVO_DESPENSA = () => resolve(process.env.DESPENSA_FILE ?? "data/despensa.json");
const ARCHIVO_RECETAS = () => resolve(process.env.RECETAS_FILE ?? "data/recetas.json");

// ---------- Persistencia ----------
function leerDespensa(): ItemDespensa[] {
  const ruta = ARCHIVO_DESPENSA();
  if (!existsSync(ruta)) return [];
  const datos = JSON.parse(readFileSync(ruta, "utf-8"));
  return Array.isArray(datos.items) ? datos.items : [];
}

function guardarDespensa(items: ItemDespensa[]): void {
  const ruta = ARCHIVO_DESPENSA();
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(ruta, JSON.stringify({ items }, null, 2) + "\n", "utf-8");
}

function leerRecetas(): Receta[] {
  const ruta = ARCHIVO_RECETAS();
  if (!existsSync(ruta)) throw new Error(`No se encontró el catálogo de recetas: ${ruta}`);
  const datos = JSON.parse(readFileSync(ruta, "utf-8"));
  return Array.isArray(datos.recetas) ? datos.recetas : [];
}

// ---------- Normalización ----------
const quitarAcentos = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const limpiar = (s: string) => quitarAcentos(s.trim().toLowerCase()).replace(/\s+/g, " ");
const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Clave canónica de un ingrediente: sin acentos, minúsculas y en singular.
 * "Huevos" -> "huevo", "frijoles" -> "frijol", "chiles" -> "chile", "arroces" -> "arroz".
 * Se prueba contra los nombres que ya conocemos (recetas y despensa) para elegir la forma correcta.
 */
function clave(nombre: string, conocidos: Set<string>): string {
  const n = limpiar(nombre);
  const candidatos = [n];
  if (n.endsWith("ces")) candidatos.push(n.slice(0, -3) + "z");
  if (n.endsWith("es")) candidatos.push(n.slice(0, -2));
  if (n.endsWith("s")) candidatos.push(n.slice(0, -1));
  for (const c of candidatos) if (conocidos.has(c)) return c;
  if (n.endsWith("ces")) return n.slice(0, -3) + "z";
  if (n.endsWith("s") && n.length > 3) return n.slice(0, -1);
  return n;
}

function conocidos(items: ItemDespensa[], recetas: Receta[]): Set<string> {
  const s = new Set<string>();
  for (const i of items) s.add(limpiar(i.nombre));
  for (const r of recetas) for (const i of r.ingredientes) s.add(limpiar(i.nombre));
  return s;
}

/** Nombre con el que se guarda un ingrediente nuevo: el del catálogo (con acentos) o el del usuario en singular. */
function nombreCanonico(texto: string, k: string, recetas: Receta[]): string {
  for (const r of recetas) for (const i of r.ingredientes) if (limpiar(i.nombre) === k) return i.nombre;
  const t = texto.trim().toLowerCase().normalize("NFC").replace(/\s+/g, " ");
  const l = limpiar(texto);
  if (l.endsWith("ces") && k.endsWith("z")) return t.slice(0, -3) + "z";
  const quitar = l.length - k.length;
  return quitar > 0 ? t.slice(0, t.length - quitar) : t;
}

// Unidades aceptadas -> unidad base y factor de conversión
const UNIDADES: Record<string, { base: UnidadBase; factor: number }> = {
  g: { base: "g", factor: 1 }, gr: { base: "g", factor: 1 }, gramo: { base: "g", factor: 1 }, gramos: { base: "g", factor: 1 },
  kg: { base: "g", factor: 1000 }, kilo: { base: "g", factor: 1000 }, kilos: { base: "g", factor: 1000 },
  kilogramo: { base: "g", factor: 1000 }, kilogramos: { base: "g", factor: 1000 },
  ml: { base: "ml", factor: 1 }, mililitro: { base: "ml", factor: 1 }, mililitros: { base: "ml", factor: 1 },
  l: { base: "ml", factor: 1000 }, lt: { base: "ml", factor: 1000 }, litro: { base: "ml", factor: 1000 }, litros: { base: "ml", factor: 1000 },
  pza: { base: "pza", factor: 1 }, pz: { base: "pza", factor: 1 }, pieza: { base: "pza", factor: 1 }, piezas: { base: "pza", factor: 1 },
  unidad: { base: "pza", factor: 1 }, unidades: { base: "pza", factor: 1 }, lata: { base: "pza", factor: 1 }, latas: { base: "pza", factor: 1 },
};
const MENSAJE_UNIDADES = "Unidades válidas: g, kg (peso), ml, l (líquidos) y pza (piezas, como huevos o latas).";

function nombreValido(n: unknown, campo = "El ingrediente"): string | null {
  if (typeof n !== "string" || n.trim() === "") return `${campo} es obligatorio.`;
  if (n.trim().length > 40) return `${campo} no puede tener más de 40 caracteres.`;
  if (!/^[\p{L} ]+$/u.test(n.trim())) return `${campo} '${n}' no es válido: usa solo letras y espacios (ejemplo: huevo, aceite de oliva).`;
  return null;
}

// ---------- Herramienta 1: actualizar despensa ----------
export interface EntradaActualizar { operacion: string; ingrediente: string; cantidad: number; unidad: string }

export function actualizarDespensa(e: EntradaActualizar) {
  if (e.operacion !== "agregar" && e.operacion !== "usar")
    return { ok: false as const, error: `La operación '${e.operacion}' no es válida. Usa 'agregar' (compré, tengo) o 'usar' (gasté, cociné con).` };
  const errNombre = nombreValido(e.ingrediente);
  if (errNombre) return { ok: false as const, error: errNombre };

  if (typeof e.cantidad !== "number" || !Number.isFinite(e.cantidad)) return { ok: false as const, error: "La cantidad debe ser un número válido." };
  if (e.cantidad <= 0) return { ok: false as const, error: `La cantidad debe ser mayor que 0 (recibido: ${e.cantidad}).` };
  if (e.cantidad > 100000) return { ok: false as const, error: "La cantidad excede el máximo permitido (100,000)." };
  if (Math.abs(e.cantidad * 1000 - Math.round(e.cantidad * 1000)) > 1e-6)
    return { ok: false as const, error: "La cantidad admite como máximo 3 decimales." };

  const u = UNIDADES[limpiar(String(e.unidad ?? ""))];
  if (!u) return { ok: false as const, error: `La unidad '${e.unidad}' no es válida. ${MENSAJE_UNIDADES}` };

  const cantidad = r3(e.cantidad * u.factor);
  const items = leerDespensa();
  const recetas = leerRecetas();
  const claves = conocidos(items, recetas);
  const k = clave(e.ingrediente, claves);
  const idx = items.findIndex((i) => clave(i.nombre, claves) === k);
  const nombre = idx >= 0 ? items[idx].nombre : nombreCanonico(e.ingrediente, k, recetas);

  if (idx >= 0 && items[idx].unidad !== u.base)
    return { ok: false as const, error: `'${nombre}' se guarda en ${items[idx].unidad}, no se puede combinar con '${e.unidad}' (${u.base}). Usa una unidad de la misma clase.` };

  if (e.operacion === "agregar") {
    let existencia: number;
    if (idx >= 0) { items[idx].cantidad = r3(items[idx].cantidad + cantidad); existencia = items[idx].cantidad; }
    else { items.push({ nombre, cantidad, unidad: u.base }); existencia = cantidad; }
    guardarDespensa(items);
    return { ok: true as const, operacion: "agregar", ingrediente: nombre, cambio: cantidad, unidad: u.base, existenciaActual: existencia };
  }

  // operacion === "usar"
  if (idx < 0) return { ok: false as const, error: `No tienes '${e.ingrediente.trim()}' en la despensa.` };
  const actual = items[idx].cantidad;
  if (cantidad > actual + 1e-9)
    return { ok: false as const, error: `No alcanza: solo tienes ${actual} ${u.base} de '${nombre}' y quieres usar ${cantidad} ${u.base}.` };
  const restante = r3(actual - cantidad);
  if (restante <= 0) items.splice(idx, 1);
  else items[idx].cantidad = restante;
  guardarDespensa(items);
  return { ok: true as const, operacion: "usar", ingrediente: nombre, cambio: cantidad, unidad: u.base, existenciaActual: Math.max(restante, 0) };
}

// ---------- Herramienta 2: consultar despensa ----------
export function consultarDespensa(f: { ingrediente?: string; limite?: number }) {
  const limite = f.limite ?? 20;
  if (!Number.isInteger(limite) || limite < 1 || limite > 100)
    return { ok: false as const, error: "El límite debe ser un entero entre 1 y 100." };
  if (f.ingrediente !== undefined && f.ingrediente !== "") {
    const err = nombreValido(f.ingrediente);
    if (err) return { ok: false as const, error: err };
  }
  const items = leerDespensa();
  const claves = conocidos(items, leerRecetas());
  const k = f.ingrediente ? clave(f.ingrediente, claves) : "";
  const filtrados = items
    .filter((i) => !k || clave(i.nombre, claves) === k)
    .sort((a, b) => limpiar(a.nombre).localeCompare(limpiar(b.nombre)));
  const mostrados = filtrados.slice(0, limite).map((i) => ({ ingrediente: i.nombre, cantidad: i.cantidad, unidad: i.unidad }));
  return {
    ok: true as const,
    total: filtrados.length,
    mostrados: mostrados.length,
    items: mostrados,
    ...(k && filtrados.length === 0 ? { mensaje: `No tienes '${f.ingrediente}' en la despensa.` } : {}),
    ...(items.length === 0 ? { mensaje: "La despensa está vacía." } : {}),
  };
}

// ---------- Herramienta 3: sugerir recetas ----------
export interface FiltrosRecetas { solo_completas?: boolean; max_minutos?: number; ingrediente?: string; limite?: number }

export function sugerirRecetas(f: FiltrosRecetas) {
  const limite = f.limite ?? 5;
  if (!Number.isInteger(limite) || limite < 1 || limite > 20)
    return { ok: false as const, error: "El límite debe ser un entero entre 1 y 20." };
  if (f.max_minutos !== undefined && (!Number.isInteger(f.max_minutos) || f.max_minutos < 5 || f.max_minutos > 600))
    return { ok: false as const, error: "max_minutos debe ser un entero entre 5 y 600." };
  if (f.ingrediente !== undefined && f.ingrediente !== "") {
    const err = nombreValido(f.ingrediente);
    if (err) return { ok: false as const, error: err };
  }

  const items = leerDespensa();
  const recetas = leerRecetas();
  const claves = conocidos(items, recetas);
  const stock = new Map<string, ItemDespensa>();
  for (const i of items) stock.set(clave(i.nombre, claves), i);
  const k = f.ingrediente ? clave(f.ingrediente, claves) : "";

  const evaluadas = recetas
    .filter((r) => !f.max_minutos || r.minutos <= f.max_minutos)
    .filter((r) => !k || r.ingredientes.some((i) => clave(i.nombre, claves) === k))
    .map((r) => {
      const faltantes: { ingrediente: string; falta: number; unidad: UnidadBase }[] = [];
      for (const ing of r.ingredientes) {
        const tiene = stock.get(clave(ing.nombre, claves));
        const disponible = tiene && tiene.unidad === ing.unidad ? tiene.cantidad : 0;
        if (disponible + 1e-9 < ing.cantidad) faltantes.push({ ingrediente: ing.nombre, falta: r3(ing.cantidad - disponible), unidad: ing.unidad });
      }
      const puedeCocinarse = faltantes.length === 0;
      return {
        receta: r.nombre,
        minutos: r.minutos,
        porciones: r.porciones,
        ingredientesDisponibles: `${r.ingredientes.length - faltantes.length} de ${r.ingredientes.length}`,
        puedeCocinarse,
        faltantes,
        ...(puedeCocinarse ? { pasos: r.pasos } : {}),
        _puntaje: (r.ingredientes.length - faltantes.length) / r.ingredientes.length,
      };
    })
    .filter((r) => !f.solo_completas || r.puedeCocinarse)
    .sort((a, b) => Number(b.puedeCocinarse) - Number(a.puedeCocinarse) || b._puntaje - a._puntaje || a.minutos - b.minutos);

  const resultado = evaluadas.slice(0, limite).map(({ _puntaje, ...resto }) => resto);
  return {
    ok: true as const,
    nota: "Se asume que siempre hay sal, agua y aceite.",
    total: evaluadas.length,
    mostradas: resultado.length,
    recetas: resultado,
    ...(evaluadas.length === 0 ? { mensaje: "No hay recetas que cumplan esos filtros con tu despensa actual." } : {}),
  };
}

// ---------- Herramienta 4: cocinar una receta ----------
/** Busca una receta por nombre: coincidencia exacta o parcial ("omelette" -> "Omelette de queso"). */
function buscarReceta(texto: string, recetas: Receta[]): Resultado<{ receta: Receta }> {
  const buscado = limpiar(texto);
  if (buscado.length < 3) return { ok: false, error: "Escribe al menos 3 letras del nombre de la receta." };
  const exactas = recetas.filter((r) => limpiar(r.nombre) === buscado);
  const candidatas = exactas.length === 1 ? exactas : recetas.filter((r) => limpiar(r.nombre).includes(buscado) || buscado.includes(limpiar(r.nombre)));
  if (candidatas.length === 1) return { ok: true, receta: candidatas[0] };
  if (candidatas.length === 0)
    return { ok: false, error: `No existe la receta '${texto.trim()}'. Recetas disponibles: ${recetas.map((r) => r.nombre).join(", ")}.` };
  return { ok: false, error: `'${texto.trim()}' coincide con varias recetas: ${candidatas.map((r) => r.nombre).join(", ")}. Indica cuál.` };
}

export function cocinarReceta(e: { receta: string; veces?: number }) {
  const errNombre = nombreValido(e.receta, "La receta");
  if (errNombre) return { ok: false as const, error: errNombre };
  const veces = e.veces ?? 1;
  if (!Number.isInteger(veces) || veces < 1 || veces > 10)
    return { ok: false as const, error: "'veces' debe ser un entero entre 1 y 10." };

  const recetas = leerRecetas();
  const b = buscarReceta(e.receta, recetas);
  if (!b.ok) return b;
  const receta = b.receta;

  const items = leerDespensa();
  const claves = conocidos(items, recetas);

  // 1) Verificar TODO antes de descontar nada (la operación es atómica)
  const plan = receta.ingredientes.map((ing) => {
    const necesario = r3(ing.cantidad * veces);
    const idx = items.findIndex((i) => clave(i.nombre, claves) === clave(ing.nombre, claves));
    const disponible = idx >= 0 && items[idx].unidad === ing.unidad ? items[idx].cantidad : 0;
    return { ing, idx, necesario, disponible };
  });
  const faltan = plan.filter((p) => p.disponible + 1e-9 < p.necesario);
  if (faltan.length > 0) {
    const detalle = faltan.map((p) => `${p.ing.nombre} (faltan ${r3(p.necesario - p.disponible)} ${p.ing.unidad})`).join(", ");
    return { ok: false as const, error: `No alcanza para cocinar '${receta.nombre}' ${veces} ${veces === 1 ? "vez" : "veces"}: ${detalle}. No se descontó nada.` };
  }

  // 2) Descontar
  const descontado = plan.map((p) => {
    const item = items[p.idx];
    item.cantidad = r3(item.cantidad - p.necesario);
    return { ingrediente: item.nombre, cantidad: p.necesario, unidad: p.ing.unidad, restante: Math.max(item.cantidad, 0) };
  });
  guardarDespensa(items.filter((i) => i.cantidad > 1e-9));
  return {
    ok: true as const,
    receta: receta.nombre,
    veces,
    porciones: receta.porciones * veces,
    descontado,
    pasos: receta.pasos,
  };
}
