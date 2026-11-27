// Servidor MCP por HTTP con 4 herramientas de despensa y recetas.
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { actualizarDespensa, consultarDespensa, sugerirRecetas, cocinarReceta } from "./store.js";

// Host y puerto configurables por variables de entorno (requisito del documento)
function envRequerida(nombre: string): string {
  const valor = process.env[nombre]?.trim();
  if (!valor) {
    throw new Error(`Falta la variable de entorno ${nombre}. Defínela en .env o en la terminal.`);
  }
  return valor;
}

const HOST = envRequerida("HOST");
const PORT = Number(envRequerida("PORT"));
if (!Number.isInteger(PORT) || PORT <= 0) {
  throw new Error(`PORT inválido: "${process.env.PORT}". Debe ser un número entero positivo.`);
}

/** Convierte el resultado de la lógica en el formato de respuesta de MCP. */
function respuesta(r: { ok: boolean }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(r) }],
    isError: !r.ok, // true = la herramienta falló; el LLM leerá el mensaje y se lo explicará al usuario
  };
}

function crearServidor(): McpServer {
  const server = new McpServer({ name: "despensa-recetas", version: "1.0.0" });

  // Herramienta 1: actualizar la despensa
  server.registerTool(
    "actualizar_despensa",
    {
      description:
        "Agrega o descuenta un ingrediente de la despensa del usuario. " +
        "Usa operacion 'agregar' cuando el usuario compró, recibió o tiene un ingrediente, y 'usar' cuando lo gastó o cocinó con él. " +
        "Si el usuario menciona varios ingredientes, llama a esta herramienta una vez por cada uno. " +
        "Úsala solo cuando el usuario indique las cantidades; si dice que cocinó o preparó una receta, usa cocinar_receta.",
      inputSchema: {
        operacion: z.enum(["agregar", "usar"]).describe("'agregar' suma al inventario; 'usar' descuenta del inventario"),
        ingrediente: z.string().describe("Nombre del ingrediente en singular o plural. Ejemplos: huevo, arroz, leche"),
        cantidad: z.number().describe("Cantidad numérica, mayor que 0. Ejemplo: 6"),
        unidad: z.string().describe("Unidad: g, kg, ml, l o pza (piezas). Ejemplos: '6 huevos' -> cantidad 6, unidad pza; '1 kilo de arroz' -> cantidad 1, unidad kg"),
      },
    },
    async (args) => respuesta(actualizarDespensa(args))
  );

  // Herramienta 2: consultar la despensa
  server.registerTool(
    "consultar_despensa",
    {
      description:
        "Muestra los ingredientes que el usuario tiene en su despensa y sus cantidades. " +
        "Úsala para preguntas como '¿qué tengo?', '¿cuántos huevos me quedan?' o '¿tengo leche?'.",
      inputSchema: {
        ingrediente: z.string().optional().describe("Si se indica, solo muestra ese ingrediente. Ejemplo: huevo"),
        limite: z.number().optional().describe("Máximo de ingredientes a mostrar (1 a 100, por defecto 20)"),
      },
    },
    async (args) => respuesta(consultarDespensa(args))
  );

  // Herramienta 3: sugerir recetas
  server.registerTool(
    "sugerir_recetas",
    {
      description:
        "Sugiere recetas del catálogo local según lo que hay en la despensa. Indica si se puede cocinar ahora, " +
        "qué ingredientes faltan (y cuánto) y, si se puede cocinar, los pasos. " +
        "Úsala para '¿qué puedo cocinar?', '¿qué hago con huevo?', 'algo rápido' o '¿qué me falta para hacer hotcakes?'.",
      inputSchema: {
        solo_completas: z.boolean().optional().describe("true = solo recetas que ya se pueden cocinar con la despensa actual"),
        max_minutos: z.number().optional().describe("Tiempo máximo de preparación en minutos (5 a 600). Ejemplo: 15"),
        ingrediente: z.string().optional().describe("Solo recetas que lleven este ingrediente. Ejemplo: huevo"),
        limite: z.number().optional().describe("Máximo de recetas a devolver (1 a 20, por defecto 5)"),
      },
    },
    async (args) => respuesta(sugerirRecetas(args))
  );

  // Herramienta 4: cocinar una receta (descuenta de la despensa lo que la receta lleva)
  server.registerTool(
    "cocinar_receta",
    {
      description:
        "Registra que el usuario cocinó una receta del catálogo: el servidor descuenta de la despensa los ingredientes y cantidades " +
        "que lleva esa receta (no hace falta que el usuario diga cantidades). Si no alcanzan los ingredientes, no descuenta nada y explica qué falta. " +
        "Úsala para 'acabo de hacer quesadillas', 'cociné hotcakes' o 'preparé arroz'.",
      inputSchema: {
        receta: z.string().describe("Nombre de la receta, completo o parcial. Ejemplos: quesadillas, omelette, hotcakes"),
        veces: z.number().optional().describe("Cuántas veces se preparó la receta (1 a 10, por defecto 1)"),
      },
    },
    async (args) => respuesta(cocinarReceta(args))
  );

  return server;
}

const app = express();
app.use(express.json());

// Página simple para comprobar en el navegador que el servidor está vivo (evidencia 1)
app.get("/", (_req, res) => {
  res.json({
    servidor: "despensa-recetas",
    mcp: `http://${HOST}:${PORT}/mcp`,
    herramientas: ["actualizar_despensa", "consultar_despensa", "sugerir_recetas", "cocinar_receta"],
  });
});

// Modo sin sesión (stateless): cada petición crea su propio servidor y transporte
app.post("/mcp", async (req, res) => {
  const server = crearServidor();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("Error atendiendo petición MCP:", e);
    if (!res.headersSent)
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno del servidor" }, id: null });
  }
});

const noPermitido = (_req: express.Request, res: express.Response) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Método no permitido." }, id: null });
app.get("/mcp", noPermitido);
app.delete("/mcp", noPermitido);

app.listen(PORT, HOST, () => {
  console.log("Servidor MCP de despensa y recetas");
  console.log(`  URL MCP:   http://${HOST}:${PORT}/mcp`);
  console.log(`  Verificar: http://${HOST}:${PORT}/`);
  console.log(`  Despensa:  ${process.env.DESPENSA_FILE ?? "data/despensa.json"}`);
  console.log(`  Recetas:   ${process.env.RECETAS_FILE ?? "data/recetas.json"}`);
  console.log("  Herramientas: actualizar_despensa, consultar_despensa, sugerir_recetas, cocinar_receta");
});
