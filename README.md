# Asistente de despensa y recetas con MCP y LLM local

Práctica de Ingeniería Web (ITC). Un chat de terminal usa un LLM local (Ollama, `qwen3.5:4b`) que decide cuándo
llamar a herramientas expuestas por un **servidor MCP** propio, por HTTP.

```
Usuario → cliente/chat → LLM local → llamada MCP → herramienta → LLM local → respuesta
```

## Qué hace

Administra la despensa de una persona (qué ingredientes tiene y cuánto) y sugiere recetas de un catálogo local
según lo que hay disponible, indicando qué falta para cocinar las demás.

| Herramienta | Parámetros | Función |
|---|---|---|
| `actualizar_despensa` | `operacion` (`agregar`/`usar`), `ingrediente`, `cantidad`, `unidad` | Suma o descuenta un ingrediente |
| `consultar_despensa` | `ingrediente?`, `limite?` | Muestra existencias |
| `sugerir_recetas` | `solo_completas?`, `max_minutos?`, `ingrediente?`, `limite?` | Recetas que se pueden cocinar, con faltantes y pasos |
| `cocinar_receta` | `receta`, `veces?` | Descuenta de la despensa los ingredientes que lleva una receta (las cantidades las pone el servidor, no el modelo) |

**Validaciones (en el servidor):** operación solo `agregar`/`usar`; cantidad numérica, > 0, máximo 3 decimales y
máximo 100,000; `cocinar_receta` acepta nombres parciales ("omelette"), rechaza nombres ambiguos o inexistentes, `veces` entre 1 y 10 y es **atómica**: si falta cualquier ingrediente no descuenta nada y explica qué falta; unidades `g, kg, ml, l, pza` (y alias como gramos, kilos, litros, piezas); nombre solo con letras;
no se puede usar más de lo que hay ni un ingrediente que no existe; no se mezclan unidades de distinta clase
(leche en ml no se descuenta en g); `max_minutos` entre 5 y 600; límites acotados. Los errores salen con `isError: true`
y un mensaje claro.

**Detalles de la lógica:** `kg` y `l` se convierten a `g` y `ml`; "huevos", "Huevo" y "huevos" son el mismo ingrediente
(plurales y acentos normalizados); se asume que siempre hay sal, agua y aceite; las recetas se ordenan primero las que
ya se pueden cocinar y luego por porcentaje de ingredientes disponibles.

**Datos:** `data/despensa.json` (despensa inicial; `data/despensa.seed.json` es la copia para restaurarla) y
`data/recetas.json` (catálogo de 14 recetas).

## Requisitos

- Node.js 20 o superior
- [Ollama](https://ollama.com) actualizado (Qwen3.5 requiere una versión reciente) y el modelo:

```bash
ollama pull qwen3.5:4b
```

## Instalación y ejecución

```bash
npm install
cp config.example.json config.json     # opcional; edítalo para cambiar modelo o URLs
```

**Terminal 1: servidor MCP**
```bash
npm run server
```
Verifica en el navegador `http://localhost:5000/` (el endpoint MCP es `http://localhost:5000/mcp`; abrirlo con el
navegador da "Método no permitido" porque MCP usa POST).
Host y puerto: `HOST=0.0.0.0 PORT=6000 npm run server` (PowerShell: `$env:PORT=6000; npm run server`).

**Terminal 2: chat**
```bash
npm run chat
```
Comandos: `/nuevo` (conversación nueva), `salir`.
Ejemplos: `Compré 6 huevos y 1 kilo de arroz` · `¿Qué tengo en la despensa?` · `¿Qué puedo cocinar en menos de 15 minutos?` ·
`Usé 2 huevos` · `¿Qué me falta para hacer hotcakes?` · `Acabo de hacer quesadillas`

## Configuración

Prioridad: **argumentos CLI > variables de entorno > config.json > valores por defecto**.

| Valor | CLI | Variable de entorno | config.json |
|---|---|---|---|
| URL del servidor MCP | `--mcp-url` | `MCP_URL` | `mcp.url` |
| URL base del LLM | `--llm-url` | `LLM_BASE_URL` | `llm.baseUrl` |
| Ruta de chat del LLM | `--chat-path` | `LLM_CHAT_PATH` | `llm.chatPath` |
| Modelo | `--model` | `LLM_MODEL` | `llm.model` |
| Razonamiento (`think`) | `--think true\|false\|auto` | `LLM_THINK` | `llm.think` |
| Temperatura | `--temperature` | `LLM_TEMPERATURE` | `llm.temperature` |

Otras opciones: `--config ruta.json`, `--debug` (imprime el cuerpo de cada petición al LLM).
Ejemplo: `npm run chat -- --model qwen3.5:9b --mcp-url http://192.168.1.10:5000/mcp`

`think` está en `false` por defecto: Qwen3.5 es un modelo con "razonamiento" y desactivarlo hace las respuestas
mucho más rápidas con un modelo de 4B. Si usas un modelo sin soporte de razonamiento y Ollama se queja de ese
parámetro, ejecuta con `--think auto` para no enviarlo.

Al arrancar, el cliente muestra la configuración efectiva (sin secretos).

## Cómo funciona (flujo por consulta)

1. Al iniciar, el cliente se conecta al MCP y descubre las herramientas con `listTools()`.
2. Envía a Ollama (`POST /api/chat`) la conversación y las herramientas en formato `tools`.
3. Si el modelo responde con `tool_calls`, el **cliente** ejecuta la llamada real con `callTool()` y muestra
   nombre, argumentos y resultado. Si pide varias herramientas a la vez (por ejemplo, un ingrediente por cada uno
   de los que compraste), las ejecuta todas.
4. Guarda el mensaje del asistente y agrega cada resultado como mensaje `role: "tool"`.
5. Hace una segunda llamada al LLM para que redacte la respuesta final.
6. Si el modelo pide más herramientas, repite desde el paso 3 (máximo 6 vueltas).

Ninguna regla `if/else` reconoce frases del usuario: el modelo decide si llama a una herramienta y con qué argumentos.

## Estructura

```
src/store.ts        Lógica y validaciones (sin MCP; npm run test:store)
src/server.ts       Servidor MCP por HTTP (express + SDK oficial)
src/client.ts       Chat de terminal + ciclo de herramientas con Ollama
src/config.ts       Carga de configuración
data/               despensa.json, despensa.seed.json, recetas.json
config.example.json / .env.example
```

## Evidencias

1. Servidor MCP iniciado y accesible en su URL: _captura_
2. Cliente mostrando modelo, URL del LLM y URL del servidor MCP: _captura_
3. Cliente descubriendo herramientas MCP: _captura_
4. Conversación con tool call, resultado MCP y respuesta final (ej. "Compré 6 huevos y 1 kilo de arroz", "¿Qué puedo cocinar?" y "Acabo de hacer quesadillas"): _captura_
5. Error controlado (ej. "Acabo de hacer hotcakes" sin harina, "Usé 5 litros de leche" cuando solo hay 1, o "Compré -3 huevos"): _captura_

## Pruebas rápidas

```bash
npm run test:store    # 34 casos de lógica y validaciones, sin MCP ni LLM
npm run typecheck
```
