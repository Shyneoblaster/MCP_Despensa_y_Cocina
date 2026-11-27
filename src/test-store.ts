// Prueba de la lógica SIN MCP. Usa una despensa temporal para no tocar tus datos.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DESPENSA_FILE = join(mkdtempSync(join(tmpdir(), "despensa-")), "d.json");
const { actualizarDespensa: act, consultarDespensa: cons, sugerirRecetas: sug, cocinarReceta: coc } = await import("./store.js");

let fallos = 0;
function check(nombre: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK   " : "FALLA"} ${nombre}`);
  if (!cond) { fallos++; console.log("      ", JSON.stringify(extra)); }
}

// Agregar y normalizar
const a = act({ operacion: "agregar", ingrediente: "Huevos", cantidad: 6, unidad: "piezas" });
check("agrega 6 huevos (plural/pieza -> huevo/pza)", a.ok && a.existenciaActual === 6 && a.unidad === "pza", a);
const b = act({ operacion: "agregar", ingrediente: "huevo", cantidad: 2, unidad: "pza" });
check("'huevo' y 'Huevos' son el mismo ingrediente (suma 8)", b.ok && b.existenciaActual === 8, b);
const c = act({ operacion: "agregar", ingrediente: "arroz", cantidad: 1, unidad: "kg" });
check("1 kg de arroz se guarda como 1000 g", c.ok && c.existenciaActual === 1000 && c.unidad === "g", c);
const d = act({ operacion: "agregar", ingrediente: "Frijoles", cantidad: 300, unidad: "gramos" });
check("'Frijoles' se reconoce como frijol", d.ok, d);
act({ operacion: "agregar", ingrediente: "leche", cantidad: 1, unidad: "l" });
act({ operacion: "agregar", ingrediente: "queso", cantidad: 100, unidad: "g" });
act({ operacion: "agregar", ingrediente: "mantequilla", cantidad: 50, unidad: "g" });

// Usar
const u = act({ operacion: "usar", ingrediente: "huevos", cantidad: 3, unidad: "pza" });
check("usa 3 huevos (quedan 5)", u.ok && u.existenciaActual === 5, u);
check("usar más de lo que hay da error", !act({ operacion: "usar", ingrediente: "huevo", cantidad: 99, unidad: "pza" }).ok);
check("usar algo que no existe da error", !act({ operacion: "usar", ingrediente: "caviar", cantidad: 1, unidad: "g" }).ok);
check("unidad incompatible (leche en g) da error", !act({ operacion: "usar", ingrediente: "leche", cantidad: 100, unidad: "g" }).ok);

// Validaciones de entrada
check("cantidad negativa da error", !act({ operacion: "agregar", ingrediente: "sal", cantidad: -1, unidad: "g" }).ok);
check("cantidad 0 da error", !act({ operacion: "agregar", ingrediente: "sal", cantidad: 0, unidad: "g" }).ok);
check("4 decimales da error", !act({ operacion: "agregar", ingrediente: "sal", cantidad: 1.2345, unidad: "g" }).ok);
check("unidad inválida (tazas) da error", !act({ operacion: "agregar", ingrediente: "sal", cantidad: 1, unidad: "tazas" }).ok);
check("ingrediente con números da error", !act({ operacion: "agregar", ingrediente: "123", cantidad: 1, unidad: "g" }).ok);
check("ingrediente vacío da error", !act({ operacion: "agregar", ingrediente: " ", cantidad: 1, unidad: "g" }).ok);
check("operación inválida da error", !act({ operacion: "tirar", ingrediente: "sal", cantidad: 1, unidad: "g" }).ok);

// Consultar
const q = cons({ ingrediente: "huevos" });
check("consulta filtra por ingrediente", q.ok && q.total === 1 && q.items[0].cantidad === 5, q);
const q2 = cons({ ingrediente: "caviar" });
check("consulta de ingrediente ausente devuelve mensaje", q2.ok && q2.total === 0 && !!q2.mensaje, q2);
check("límite inválido da error", !cons({ limite: 0 }).ok);

// Sugerir
const s1 = sug({ solo_completas: true });
check("sugiere omelette (huevo+queso+mantequilla)", s1.ok && s1.recetas.some((r) => r.receta === "Omelette de queso" && r.puedeCocinarse && !!r.pasos), s1);
const s2 = sug({ ingrediente: "huevos", limite: 20 });
check("filtro por ingrediente solo trae recetas con huevo", s2.ok && s2.recetas.length > 0 && s2.recetas.every((r) => /huevo|omelette|hotcakes/i.test(r.receta)), s2);
const s3 = sug({ ingrediente: "harina" });
check("receta con faltantes muestra qué falta (hotcakes sin harina)", s3.ok && s3.recetas[0]?.faltantes.some((f) => f.ingrediente === "harina" && f.falta === 150), s3);
const s4 = sug({ max_minutos: 10, solo_completas: true });
check("max_minutos filtra por tiempo", s4.ok && s4.recetas.every((r) => r.minutos <= 10), s4);
check("max_minutos inválido da error", !sug({ max_minutos: 2 }).ok);
check("ingrediente inválido da error", !sug({ ingrediente: "123" }).ok);

// Cocinar receta
const k1 = coc({ receta: "omelette" });
check("cocina 'omelette' (nombre parcial) y descuenta 3 huevo, 50 g queso, 10 g mantequilla",
  k1.ok && k1.receta === "Omelette de queso" && k1.descontado.length === 3 && k1.descontado.find((d) => d.ingrediente === "queso")?.restante === 50, k1);
const antes = cons({ ingrediente: "huevo" });
const k2 = coc({ receta: "Omelette de queso", veces: 2 });
const despues = cons({ ingrediente: "huevo" });
check("sin ingredientes suficientes da error y lista lo que falta", !k2.ok && /faltan/.test(k2.error), k2);
check("el error NO descuenta nada (atómico)", antes.ok && despues.ok && antes.items[0].cantidad === despues.items[0].cantidad, [antes, despues]);
check("receta ambigua ('arroz') da error", !coc({ receta: "arroz" }).ok);
check("receta inexistente da error con lista", (() => { const r = coc({ receta: "pizza" }); return !r.ok && /Recetas disponibles/.test(r.error); })());
check("veces 0 da error", !coc({ receta: "omelette", veces: 0 }).ok);
check("veces decimal da error", !coc({ receta: "omelette", veces: 1.5 }).ok);
check("nombre con números da error", !coc({ receta: "123" }).ok);
act({ operacion: "agregar", ingrediente: "tortillas", cantidad: 8, unidad: "pza" });
const k3 = coc({ receta: "quesadillas" });
check("quesadillas descuenta 4 tortillas y 120 g de queso solo si alcanza (queso 50 g -> error)", !k3.ok, k3);
act({ operacion: "agregar", ingrediente: "queso", cantidad: 100, unidad: "g" });
const k4 = coc({ receta: "quesadillas" });
check("con 150 g de queso cocina quesadillas", k4.ok && k4.descontado.find((d) => d.ingrediente === "tortilla")?.restante === 4, k4);

console.log(fallos === 0 ? "\nTodas las pruebas pasaron." : `\n${fallos} prueba(s) fallaron.`);
process.exit(fallos ? 1 : 0);
