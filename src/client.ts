// Cliente de chat (despensa y recetas): usuario -> cliente -> LLM local (Ollama) -> MCP -> LLM local -> usuario
import * as readline from "node:readline/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { cargarConfig, type Config } from "./config.js";

// ---- Tipos mínimos del formato de Ollama ----
interface ToolCall { function: { name: string; arguments: Record<string, unknown> | string } }
interface Mensaje { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_name?: string }

const MAX_ITERACIONES = 6; // evita ciclos infinitos si el modelo insiste en pedir herramientas

// ---- Utilidades de salida ----
const c = { dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m", red: "\x1b[31m", bold: "\x1b[1m", off: "\x1b[0m" };
const paso = (n: number, texto: string) => console.log(`${c.cyan}  [${n}] ${texto}${c.off}`);

function promptSistema(): string {
  return [
    "Eres un asistente de cocina que administra la despensa del usuario. Respondes siempre en español, de forma breve y clara.",
    "Para agregar o descontar ingredientes, ver la despensa, sugerir recetas o cocinar una receta debes usar las herramientas disponibles.",
    "Si el usuario dice que cocinó, preparó o hizo una receta, usa cocinar_receta (el servidor sabe las cantidades); no uses actualizar_despensa para eso.",
    "Si el usuario no indica cantidades exactas al agregar o usar ingredientes sueltos, NO las supongas ni uses todo lo que hay: pregúntaselas.",
    "Los datos de la despensa cambian en cualquier momento: ante CADA pregunta sobre existencias o recetas, llama de nuevo a la herramienta, aunque ya hayas consultado antes en la conversación. Nunca respondas con datos de mensajes anteriores.",
    "Si el usuario menciona varios ingredientes, llama a la herramienta una vez por cada ingrediente.",
    "Nunca inventes existencias, recetas, ingredientes ni cantidades: usa solo lo que devuelven las herramientas.",
    "No valides ni juzgues cantidades, unidades ni nombres tú mismo: siempre llama a la herramienta y deja que ella valide.",
    "Cuando una herramienta devuelva un error, repite su mensaje con tus palabras sin agregar datos, cálculos ni explicaciones propias, y di cómo corregirlo.",
    "Si el usuario solo conversa o saluda, responde sin usar herramientas.",
  ].join("\n");
}

// ---- Llamada al LLM local ----
async function llamarLLM(cfg: Config, messages: Mensaje[], tools: unknown[]): Promise<Mensaje> {
  const url = `${cfg.llmBaseUrl}${cfg.llmChatPath}`;
  const cuerpo: Record<string, unknown> = { model: cfg.model, messages, tools, stream: false, options: { temperature: cfg.temperature } };
  if (cfg.think !== undefined) cuerpo.think = cfg.think; // false = sin razonamiento
  if (cfg.debug) console.log(`${c.dim}[debug] POST ${url}\n${JSON.stringify(cuerpo, null, 2)}${c.off}`);
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(300_000), // la primera respuesta puede tardar mientras Ollama carga el modelo
    });
  } catch (e) {
    throw new Error(`No se pudo conectar al LLM en ${url}. ¿Está corriendo Ollama? (${(e as Error).message})`);
  }
  if (!resp.ok) {
    const detalle = await resp.text();
    throw new Error(`El LLM respondió ${resp.status}: ${detalle}. ¿Existe el modelo '${cfg.model}'? (ollama pull ${cfg.model})`);
  }
  const datos: any = await resp.json();
  if (!datos.message) throw new Error("Respuesta inesperada del LLM (sin 'message').");
  return datos.message as Mensaje;
}

/** Convierte el resultado de MCP en texto para el mensaje 'tool'. */
function textoDeResultado(res: any): string {
  const partes = Array.isArray(res.content) ? res.content.filter((p: any) => p.type === "text").map((p: any) => p.text) : [];
  return partes.join("\n") || "Sin resultado.";
}

function argumentosComoObjeto(args: Record<string, unknown> | string | undefined): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === "string") {
    try { return JSON.parse(args); } catch { return {}; }
  }
  return args;
}

/** Los modelos pequeños a veces mandan "500" (texto) donde el esquema pide número. Se corrige según el esquema MCP. */
function ajustarTipos(args: Record<string, unknown>, esquema: any): Record<string, unknown> {
  const props = esquema?.properties ?? {};
  const salida = { ...args };
  for (const [k, v] of Object.entries(salida)) {
    if (props[k]?.type === "boolean" && typeof v === "string" && ["true", "false"].includes(v.trim().toLowerCase())) {
      salida[k] = v.trim().toLowerCase() === "true";
      continue;
    }
    if ((props[k]?.type === "number" || props[k]?.type === "integer") && typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.replace(/[$,]/g, ""))))
      salida[k] = Number(v.replace(/[$,]/g, ""));
  }
  return salida;
}

// ---- Un turno completo: el ciclo de herramientas ----
async function responder(cfg: Config, mcp: Client, tools: unknown[], esquemas: Map<string, unknown>, historial: Mensaje[], pregunta: string): Promise<void> {
  historial.push({ role: "user", content: pregunta });

  for (let i = 1; i <= MAX_ITERACIONES; i++) {
    paso(2, `Enviando al LLM local (${cfg.model}) la conversación y ${tools.length} herramientas...`);
    const msg = await llamarLLM(cfg, historial, tools);
    historial.push(msg); // se conserva el mensaje del asistente (incluye sus tool_calls)

    const llamadas = msg.tool_calls ?? [];
    if (llamadas.length === 0) {
      console.log(`\n${c.green}${c.bold}Asistente:${c.off} ${msg.content.trim() || "(sin respuesta)"}\n`);
      return;
    }

    for (const llamada of llamadas) {
      const nombre = llamada.function.name;
      const args = ajustarTipos(argumentosComoObjeto(llamada.function.arguments), esquemas.get(nombre));
      paso(3, `El LLM solicitó la herramienta MCP: ${c.yellow}${nombre}${c.cyan}`);
      paso(4, `Llamando al servidor MCP (callTool)...`);
      console.log(`      Argumentos: ${JSON.stringify(args)}`);

      let texto: string;
      try {
        const res = await mcp.callTool({ name: nombre, arguments: args });
        texto = textoDeResultado(res);
        const etiqueta = res.isError ? `${c.red}Resultado MCP (ERROR controlado)` : `${c.green}Resultado MCP`;
        console.log(`      ${etiqueta}:${c.off} ${texto}`);
      } catch (e) {
        // Error de protocolo (herramienta inexistente, esquema inválido, servidor caído...)
        texto = JSON.stringify({ ok: false, error: `Fallo la llamada MCP: ${(e as Error).message}` });
        console.log(`      ${c.red}Resultado MCP (fallo):${c.off} ${texto}`);
      }
      paso(5, "Agregando el resultado al historial como mensaje 'tool'.");
      historial.push({ role: "tool", content: texto, tool_name: nombre });
    }
    paso(6, "Segunda llamada al LLM con el resultado para que formule la respuesta...");
  }
  console.log(`${c.red}Se alcanzó el máximo de ${MAX_ITERACIONES} iteraciones de herramientas. Reformula tu petición.${c.off}\n`);
}

// ---- Programa principal ----
async function main() {
  const cfg = cargarConfig();

  console.log(`${c.bold}Configuración efectiva${c.off}`);
  console.log(`  Modelo local:    ${cfg.model}`);
  console.log(`  Razonamiento:    ${cfg.think === undefined ? "por defecto del modelo" : cfg.think ? "activado" : "desactivado"}   Temperatura: ${cfg.temperature}`);
  console.log(`  API del LLM:     ${cfg.llmBaseUrl}${cfg.llmChatPath}`);
  console.log(`  Servidor MCP:    ${cfg.mcpUrl}`);
  console.log(`  Origen config:   ${cfg.origen}\n`);

  paso(1, "Conectando al servidor MCP y descubriendo herramientas (listTools)...");
  const mcp = new Client({ name: "chat-despensa", version: "1.0.0" });
  try {
    await mcp.connect(new StreamableHTTPClientTransport(new URL(cfg.mcpUrl)));
  } catch (e) {
    console.error(`${c.red}No se pudo conectar al servidor MCP en ${cfg.mcpUrl}. ¿Está corriendo 'npm run server'?\n${(e as Error).message}${c.off}`);
    process.exit(1);
  }
  const { tools } = await mcp.listTools();
  console.log("\nHerramientas MCP descubiertas:");
  for (const t of tools) console.log(`- ${t.name}: ${t.description}`);

  // Formato de herramientas que espera Ollama: casi un mapeo directo del esquema MCP
  const toolsOllama = tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema },
  }));

  const esquemas = new Map<string, unknown>(tools.map((t) => [t.name, t.inputSchema]));

  console.log(`\nEscribe tu mensaje. Comandos: ${c.bold}/nuevo${c.off} (conversación nueva), ${c.bold}salir${c.off}.`);
  console.log(`Ejemplos: "Compré 6 huevos y 1 kilo de arroz", "¿Qué puedo cocinar?", "Acabo de hacer quesadillas"\n`);

  let historial: Mensaje[] = [{ role: "system", content: promptSistema() }];
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  while (true) {
    let linea: string;
    try { linea = (await rl.question(`${c.bold}Tú:${c.off} `)).trim(); } catch { break; } // Ctrl+D / fin de entrada
    if (!linea) continue;
    if (["salir", "exit", "/salir"].includes(linea.toLowerCase())) break;
    if (linea === "/nuevo") {
      historial = [{ role: "system", content: promptSistema() }];
      console.log("Conversación nueva iniciada.\n");
      continue;
    }
    try {
      await responder(cfg, mcp, toolsOllama, esquemas, historial, linea);
    } catch (e) {
      console.log(`${c.red}Error: ${(e as Error).message}${c.off}\n`);
      historial.pop(); // evita dejar un mensaje de usuario sin respuesta
    }
  }
  rl.close();
  await mcp.close().catch(() => {});
  console.log("Hasta luego.");
}

main().catch((e) => { console.error(e); process.exit(1); });
