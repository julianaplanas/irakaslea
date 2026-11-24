// Llamadas al modelo vía OpenRouter. Sin OPENROUTER_API_KEY la app funciona igual, pero sin las partes en vivo.
const MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-5.5";
const enabled = () => !!process.env.OPENROUTER_API_KEY;

async function call({ system, messages, maxTokens, temperature }) {
  const r = await fetch(process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + process.env.OPENROUTER_API_KEY,
      "HTTP-Referer": process.env.APP_URL || "https://irakaslea.up.railway.app",
      "X-Title": "Irakaslea",
    },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, temperature, messages: [{ role: "system", content: system }, ...messages] }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error("OpenRouter " + r.status + ": " + JSON.stringify(d.error || d).slice(0, 300));
  const ch = (d.choices && d.choices[0]) || {};
  const c = ch.message && ch.message.content;
  const text = (Array.isArray(c) ? c.map(p => p.text || "").join("") : String(c || "")).trim();
  return { text, finish: ch.finish_reason || ch.native_finish_reason, usage: d.usage };
}

// Margen amplio de tokens: algunos modelos gastan parte en razonar antes de contestar.
// Si la respuesta llega vacía o cortada, se reintenta una vez con el doble.
async function ask({ system, messages, maxTokens = 1200, temperature = 0.7 }) {
  if (!enabled()) throw new Error("Falta OPENROUTER_API_KEY");
  let budget = maxTokens + 2000;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await call({ system, messages, maxTokens: budget, temperature });
    if (r.text && r.finish !== "length") return r.text;
    console.error(`OpenRouter: respuesta ${r.text ? "cortada" : "vacía"} (finish=${r.finish}, usage=${JSON.stringify(r.usage)})`);
    if (r.text && attempt === 1) return r.text;
    budget *= 2;
  }
  throw new Error("El modelo devolvió una respuesta vacía");
}

function parseJSON(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = m ? m[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(raw);
}

// Pide JSON y lo extrae aunque venga envuelto en ```json. Si no es válido, pide que lo corrija una vez.
async function askJSON(opts) {
  const sys = opts.system + "\nDevuelve JSON válido. Dentro de los textos NO uses comillas dobles: usa «comillas latinas».";
  const text = await ask({ ...opts, system: sys, temperature: opts.temperature ?? 0.4 });
  try { return parseJSON(text); }
  catch (e) {
    console.error("JSON inválido, reintento:", e.message);
    const fixed = await ask({ system: "Corriges JSON. Devuelve SOLO el JSON corregido y válido, sin comentarios.", messages: [{ role: "user", content: text }], maxTokens: opts.maxTokens || 1200, temperature: 0 });
    return parseJSON(fixed);
  }
}

// Personalidad y reglas comunes de la profesora.
const TEACHER = `Eres Irati, profesora de euskera (euskara batua) de una alumna adulta hispanohablante.
Eres una profesora IA y lo dices si te preguntan. Cálida, con humor suave, directa.
- Explicas en castellano; usas euskera para saludos, consignas y ejemplos, sin pasar del nivel de la clase.
- Usa SOLO batua estándar y preferentemente las palabras y estructuras del material de la clase que se te da.
- Si dudas de una forma, no la inventes: dilo y márcala como «a comprobar».
- Mensajes cortos (máximo 3 frases), pensados para leer en el móvil.
- Corriges así: forma correcta + la regla en una frase. Como mucho 2 correcciones por mensaje.
- Las palabras o frases en euskera van siempre entre «comillas latinas».`;

module.exports = { ask, askJSON, enabled, TEACHER, MODEL };
