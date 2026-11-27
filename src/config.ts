// Configuración externa. Prioridad: argumentos CLI > variables de entorno > config.json > valores por defecto.
import { existsSync, readFileSync } from "node:fs";

export interface Config {
  mcpUrl: string;
  llmBaseUrl: string;
  llmChatPath: string;
  model: string;
  think: boolean | undefined; // razonamiento de modelos con 'thinking' (Qwen3.5, etc.)
  temperature: number;
  debug: boolean;
  origen: string; // de dónde salió el archivo de config (para mostrarlo)
}

function aBooleano(v: unknown): boolean | undefined {
  if (v === undefined) return false; // por defecto: razonamiento desactivado (más rápido con modelos pequeños)
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (["true", "1", "si", "sí", "on"].includes(v.toLowerCase())) return true;
    if (["false", "0", "no", "off"].includes(v.toLowerCase())) return false;
    // "auto" / "default": no se envía el parámetro y el modelo usa su comportamiento por defecto
    if (["auto", "default"].includes(v.toLowerCase())) return undefined;
  }
  return undefined;
}

function argumento(nombre: string): string | undefined {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function cargarConfig(): Config {
  const rutaArchivo = argumento("config") ?? process.env.CONFIG_FILE ?? "config.json";
  let archivo: any = {};
  let origen = "valores por defecto (no se encontró config.json)";
  if (existsSync(rutaArchivo)) {
    try {
      archivo = JSON.parse(readFileSync(rutaArchivo, "utf-8"));
      origen = rutaArchivo;
    } catch (e) {
      throw new Error(`No se pudo leer ${rutaArchivo}: ${(e as Error).message}`);
    }
  }
  return {
    mcpUrl: argumento("mcp-url") ?? process.env.MCP_URL ?? archivo?.mcp?.url,
    llmBaseUrl: (argumento("llm-url") ?? process.env.LLM_BASE_URL ?? archivo?.llm?.baseUrl).replace(/\/+$/, ""),
    llmChatPath: argumento("chat-path") ?? process.env.LLM_CHAT_PATH ?? archivo?.llm?.chatPath,
    model: argumento("model") ?? process.env.LLM_MODEL ?? archivo?.llm?.model,
    think: aBooleano(argumento("think") ?? process.env.LLM_THINK ?? archivo?.llm?.think),
    temperature: Number(argumento("temperature") ?? process.env.LLM_TEMPERATURE ?? archivo?.llm?.temperature ?? 0.2),
    debug: process.argv.includes("--debug") || process.env.DEBUG === "1",
    origen,
  };
}
