// Convierte una lección de Euskara Praktika en una clase de ~60 minutos con actividades variadas.
// Todo el euskera de los ejercicios sale del material ya revisado; Claude solo añade los "extras"
// (situaciones de role-play, cápsula cultural, consigna de escritura y deberes), que se generan una vez y se guardan.
const C = require("./content");
const claude = require("./claude");

const BLOCKS = [
  { key: "warmup", name: "Beroketa", es: "Calentamiento", min: 5 },
  { key: "review", name: "Errepasoa", es: "Repaso", min: 7 },
  { key: "input", name: "Gai berria", es: "Tema nuevo", min: 12 },
  { key: "practice", name: "Praktika", es: "Práctica", min: 15 },
  { key: "break", name: "Atsedena", es: "Pausa", min: 3 },
  { key: "free", name: "Mintzatu", es: "Habla tú", min: 12 },
  { key: "wrap", name: "Amaiera", es: "Cierre", min: 6 },
];

// Aleatorio determinista por lección, para que la clase sea la misma si recargas.
function rng(seedStr) {
  let h = 2166136261;
  for (const c of seedStr) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h += 0x6D2B79F5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const shuffle = (arr, r) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = (arr, n, r) => shuffle(arr, r).slice(0, n);
const wordCount = s => s.split(/\s+/).filter(Boolean).length;
const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function options(answer, pool, r, n = 4) {
  const others = shuffle([...new Set(pool.filter(x => x !== answer))], r).slice(0, n - 1);
  return shuffle([answer, ...others], r);
}

function gapItems(lesson, r, pool) {
  const terms = lesson.pairs.map(p => p[0]).filter(t => !/[?!]/.test(t)).sort((a, b) => b.length - a.length);
  const items = [];
  for (const [eu, es] of shuffle(pool || lesson.sentences, r)) {
    const term = terms.find(t => new RegExp(`(^|[\\s¿¡"«(])${escRe(t)}([\\s.,!?»)]|$)`, "i").test(eu));
    if (!term) continue;
    const re = new RegExp(escRe(term), "i");
    const found = eu.match(re)[0];
    items.push({ text: eu.replace(re, "___"), answer: found, es, options: options(found, terms.filter(t => t.toLowerCase() !== found.toLowerCase()).concat(found), r, 3) });
    if (items.length >= 5) break;
  }
  return items;
}

function slidesFor(lesson) {
  const slides = [];
  slides.push({ title: lesson.eu, subtitle: lesson.title, emoji: lesson.emoji, body: lesson.desc, pattern: lesson.pattern });
  for (const t of lesson.tips || []) slides.push({ title: t.t, body: t.b });
  if (lesson.grid) slides.push({ title: lesson.grid.title, table: { cols: ["", ...lesson.grid.cols], rows: lesson.grid.rows } });
  for (const g of C.grammarFor(lesson.id).slice(0, 2)) {
    slides.push({ title: g.eu, subtitle: g.title, emoji: g.emoji, body: g.summary, table: g.table, examples: (g.examples || []).slice(0, 4) });
  }
  return slides;
}

const EXTRAS_VERSION = 2;

// Deberes por defecto: tres partes, cada una con su propio espacio.
function fallbackHomework(lesson) {
  return { parts: [
    { kind: "translate", instr: "Traduce al euskera", items: lesson.sentences.slice(-4).map(s => s[1]) },
    { kind: "write", instr: `Escribe un mini diálogo (4-6 líneas) usando lo de «${lesson.eu}». Puedes partir de este: «${(lesson.dialogue[0] || [])[1] || lesson.sentences[0][0]}»` },
    { kind: "record", instr: "Lee en voz alta tu diálogo y grábate.", text: "" },
  ] };
}

function fallbackExtras(lesson) {
  const scene = (lesson.scene && lesson.scene.title) || lesson.title;
  return {
    _fallback: true,
    version: EXTRAS_VERSION,
    warmup: { situation: "Charla corta de bienvenida, como al llegar a clase.", goal: "Saludar, decir qué tal estás y repasar lo de la clase anterior.", starter: "Kaixo! Zer moduz zaude gaur?" },
    roleplay: { situation: `${scene}. Usa el tema de la clase: ${lesson.title}.`, goal: `Usar en una conversación real: ${lesson.desc}`, starter: (lesson.dialogue[0] || [])[1] || "Kaixo!" },
    culture: null,
    reading: null,
    listening: null,
    writing: { prompt: `Completa y adapta este diálogo a ti (3-4 líneas).`, model: lesson.dialogue.map(d => d[1]).join("\n") },
    homework: fallbackHomework(lesson),
  };
}

async function generateExtras(lesson) {
  if (!claude.enabled()) return fallbackExtras(lesson);
  const mod = C.moduleOf(lesson.id) || {};
  const prev = C.prevLesson(lesson.id);
  const level = (mod.id || 1) >= 9 ? "A2" : "A1";
  const material = {
    modulo: `${mod.id} ${mod.eu} (${mod.es})`, leccion: `${lesson.eu} — ${lesson.title}`, descripcion: lesson.desc,
    vocabulario: lesson.pairs.map(p => p[0] + " = " + p[1]), frases: lesson.sentences.map(s => s[0] + " = " + s[1]),
    estructura: lesson.pattern, dialogo: lesson.dialogue.map(d => d[1]), escena: lesson.scene && lesson.scene.title,
    clase_anterior: prev ? `${prev.eu} — ${prev.title}` : null,
  };
  const system = claude.TEACHER + `\nAhora preparas material para una clase. Devuelve SOLO JSON válido.`;
  const prompt = `Material de la clase (nivel ${level}):\n${JSON.stringify(material, null, 1)}

Regla clave: todo el euskera que escribas usa SOLO el vocabulario y las estructuras de esta lección y anteriores. Frases cortas y sencillas.

Devuelve este JSON (textos para la alumna en castellano salvo lo marcado como euskera):
{
 "warmup": {"situation": "charla inicial de 1-2 frases que conecte con la clase anterior", "goal": "qué tiene que practicar", "starter": "primera frase de Irati, en euskera, muy sencilla"},
 "roleplay": {"situation": "situación realista y concreta en Euskal Herria para practicar el tema (lugar, quién es Irati en la escena)", "goal": "qué tiene que conseguir la alumna", "starter": "primera frase de Irati en euskera"},
 "listening": {"intro": "1 frase: quiénes hablan y dónde", "lines": [["A", "frase en euskera", "traducción"], "... 8-10 líneas, dos personas (A y B), situación distinta a la del diálogo del material"], "questions": [{"q": "pregunta en castellano sobre lo que se oye", "options": ["3 opciones en castellano"], "answer": "la correcta, idéntica a una opción"}, "... 3 preguntas"]},
 "reading": {"title": "título en euskera", "text": "texto de 60-90 palabras en euskera (un mensaje, una nota, una presentación o un correo) que use el tema de hoy", "glossary": [["palabra del texto que no esté en el vocabulario", "traducción"]], "questions": [{"q": "pregunta en castellano", "options": ["3 opciones"], "answer": "la correcta"}, "... 3 preguntas"]},
 "culture": {"title": "título corto", "body": "3-4 frases sobre una costumbre, lugar, expresión o dato vasco relacionado con el tema; solo datos seguros", "eu_word": "palabra o expresión vasca relacionada (o vacío)"},
 "writing": {"prompt": "consigna para escribir 3-4 frases que la alumna PUEDA escribir con lo que sabe (si el vocabulario es poco, que adapte un diálogo modelo a su vida)", "model": "texto modelo en euskera de 3-4 líneas que pueda imitar, separadas por \\n"},
 "homework": {"parts": [
   {"kind": "translate", "instr": "Traduce al euskera", "items": ["4-5 frases en castellano que se puedan traducir con lo visto"]},
   {"kind": "write", "instr": "consigna de una redacción corta (40-60 palabras, o un diálogo de 6 líneas en las primeras lecciones) con pautas claras"},
   {"kind": "record", "instr": "qué leer en voz alta y grabar", "text": "texto en euskera de 2-4 frases para leer en voz alta"}
 ]}
}`;
  try {
    const ex = await claude.askJSON({ system, messages: [{ role: "user", content: prompt }], maxTokens: 3500 });
    return { ...fallbackExtras(lesson), ...ex, _fallback: false, version: EXTRAS_VERSION };
  } catch (e) {
    console.error("Extras:", e.message);
    return fallbackExtras(lesson);
  }
}

// Asegura que el desorden no coincide con el orden original.
function scramble(words, r) {
  if (words.length < 2) return words.map((w, k) => ({ w, k }));
  for (let t = 0; t < 10; t++) { const o = shuffle(words.map((w, k) => ({ w, k })), r); if (o.some((x, i) => x.k !== i)) return o; }
  return words.map((w, k) => ({ w, k })).reverse();
}

// Deberes: admite el formato viejo (texto con 1) 2) 3)) y lo convierte en partes.
function homeworkParts(hw, lesson) {
  if (hw && Array.isArray(hw.parts) && hw.parts.length) return hw.parts;
  if (hw && hw.brief) {
    const lines = String(hw.brief).split(/\n+/).map(x => x.trim()).filter(Boolean);
    if (lines.length >= 2) return lines.map(l => ({ kind: /voz alta|gr[aá]ba/i.test(l) ? "record" : /traduc/i.test(l) ? "translate" : "write", instr: l.replace(/^\d+[).]\s*/, "") }));
  }
  return fallbackHomework(lesson).parts;
}

// Construye la clase. extras: objeto de generateExtras; ctx: { weak, homework, videos }
function buildClass(lesson, extras, ctx = {}) {
  const r = rng(lesson.id);
  const prev = C.prevLesson(lesson.id);
  const mod = C.moduleOf(lesson.id) || {};
  const A = [];
  const add = (block, type, intro, data = {}) => A.push({ id: `${block}-${A.length + 1}`, block, type, intro, ...data });
  // Banco de frases: las de la lección + las del diálogo (sin repetir). Si no alcanzan, se reutilizan.
  const seenEu = new Set();
  const sentences = [...lesson.sentences, ...lesson.dialogue.map(d => [d[1], d[2]])].filter(([eu]) => { const k = eu.toLowerCase(); if (seenEu.has(k)) return false; seenEu.add(k); return true; });
  const used = new Set();
  const take = (pool, n, filter = () => true) => {
    let out = pick(pool.filter(x => !used.has(x[0]) && filter(x)), n, r);
    if (out.length < n) out = out.concat(pick(pool.filter(x => used.has(x[0]) && filter(x) && !out.includes(x)), n - out.length, r));
    out.forEach(x => used.add(x[0])); return out;
  };

  // 1. Calentamiento
  add("warmup", "roleplay", `«Kaixo!» Soy Irati. Hoy toca «${lesson.eu}»: ${lesson.title.toLowerCase()}. Antes, una charla corta para calentar: 4 turnos, contesta como puedas.`,
    { ...extras.warmup, turns: 4 });

  // 2. Repaso
  if (ctx.homework && ctx.homework.correction) add("review", "feedback", "Tu tarea de la semana pasada ya está corregida. Mira lo principal.", { homework: ctx.homework });
  const reviewPairs = [...(ctx.weak || []).map(w => [w.eu, w.es, "🔁"]), ...(prev ? pick(prev.pairs, 6, r) : [])].slice(0, 6);
  if (reviewPairs.length >= 3) add("review", "memory", prev ? `Repasamos «${prev.eu}» con un juego de parejas.` : "Un juego de parejas para arrancar.", { pairs: reviewPairs });

  // 3. Tema nuevo
  add("input", "scene", `Mira esta escena: «${((lesson.scene && lesson.scene.title) || lesson.eu).split(" · ")[0]}». Toca cada frase para escucharla. Intenta entenderla antes de ver la traducción.`,
    { title: lesson.scene && lesson.scene.title, emoji: lesson.scene && lesson.scene.emoji, lines: lesson.dialogue });
  add("input", "slides", "Ahora te explico cómo funciona.", { slides: slidesFor(lesson) });
  add("input", "cards", "Las palabras de hoy. Toca cada tarjeta: la oyes y ves qué significa.", { pairs: lesson.pairs });
  add("input", "match", "Ahora sin traducción: une cada palabra con su dibujo.", { pairs: pick(lesson.pairs.filter(p => p[2]), 6, r), emojiOnly: true });
  for (const v of (ctx.videos || []).slice(0, 1)) add("input", "video", "Un vídeo con euskera real. No hace falta entenderlo todo: quédate con lo que reconoces.", { videoId: v.id, url: v.url, title: v.title, note: v.note });
  if (extras.listening && extras.listening.lines && extras.listening.lines.length) {
    add("input", "listening", "Sigamos entrenando el oído. Escucha la conversación sin leerla y contesta. Puedes oírla las veces que quieras.",
      { context: extras.listening.intro, lines: extras.listening.lines, questions: extras.listening.questions });
  }

  // 4. Práctica: sobre todo escribir
  const orderItems = take(sentences, 4, s => wordCount(s[0]) >= 3 && wordCount(s[0]) <= 8);
  if (orderItems.length) add("practice", "order", "Ordena las piezas para formar la frase.", { items: orderItems.map(([eu, es]) => ({ eu, es, tiles: scramble(eu.replace(/[.!?]+$/, "").split(/\s+/), r) })) });
  const gaps = gapItems(lesson, r, sentences);
  if (gaps.length >= 2) add("practice", "gap", "Escribe la palabra que falta. Si te atascas, pide una pista.", { items: gaps });
  const drills = C.grammarFor(lesson.id).flatMap(g => g.drills || []).slice(0, 5);
  if (drills.length) add("practice", "transform", "Transforma la frase como te pido. Escríbela entera.", { items: drills });
  const trans = take(sentences, 5);
  if (trans.length < 5) trans.push(...pick(lesson.pairs.filter(p => !trans.some(t => t[0] === p[0])), 5 - trans.length, r).map(p => [p[0], p[1]]));
  if (trans.length) add("practice", "translate", "Traduce al euskera. Escribe la frase entera.", { items: trans.map(([eu, es]) => ({ eu, es })) });
  add("practice", "mcq", "Solo con el oído: escucha y elige qué significa.", {
    listen: true,
    items: pick(sentences, 4, r).map(([eu, es]) => ({ q: eu, qLang: "eu", answer: es, options: options(es, sentences.map(s => s[1]), r) })),
  });
  let dict = take(sentences, 5, s => wordCount(s[0]) <= 7);
  if (dict.length < 5) dict = dict.concat(pick(lesson.pairs.filter(p => !/[?!]/.test(p[0])), 5 - dict.length, r).map(p => [p[0], p[1]]));
  if (dict.length) add("practice", "dictation", "Dictado: escucha y escribe lo que oyes. Puedes repetir el audio.", { items: dict.map(([eu, es]) => ({ eu, es })) });

  // 5. Pausa
  if (extras.culture && extras.culture.body) add("break", "culture", "Pausa de dos minutos. Te cuento algo.", { ...extras.culture });

  // 6. Habla tú
  if (extras.reading && extras.reading.text) add("free", "reading", "Un texto corto para leer. Lee primero sin ayuda; toca las palabras subrayadas si las necesitas. Luego, preguntas.",
    { title: extras.reading.title, text: extras.reading.text, glossary: extras.reading.glossary, questions: extras.reading.questions });
  add("free", "roleplay", "Ahora, una situación real: 6 turnos. Contesta en euskera como puedas; si te atascas, escríbeme en castellano y te ayudo.", { ...extras.roleplay, turns: 6 });
  add("free", "write", "Ahora escribe tú. Tienes un modelo y las palabras de hoy para ayudarte. Te lo corrijo al momento.", { prompt: extras.writing.prompt, model: extras.writing.model, bank: lesson.pairs.map(p => p[0]) });
  add("free", "repeat", "Pronunciación: escucha, repite en voz alta y grábate para compararte.", { items: pick(lesson.pairs, 6, r).map(p => p[0]) });

  // 7. Cierre
  add("wrap", "speed", "Ronda rápida: 60 segundos, todas las que puedas.", { pairs: lesson.pairs, seconds: 60 });
  add("wrap", "summary", "Esto es lo que te llevas de hoy.", { pattern: lesson.pattern, words: lesson.pairs.slice(0, 8), tip: (lesson.tips[0] || {}).t });
  add("wrap", "homework", "Y los deberes para la próxima clase. Me los entregas en la pestaña «Etxeko lanak».", { parts: homeworkParts(extras.homework, lesson) });

  return {
    lesson: { id: lesson.id, eu: lesson.eu, title: lesson.title, emoji: lesson.emoji, module: mod.id, moduleEu: mod.eu, level: (mod.id || 1) >= 9 ? "A2" : "A1" },
    material: { pairs: lesson.pairs, sentences: lesson.sentences, pattern: lesson.pattern, desc: lesson.desc },
    blocks: BLOCKS,
    activities: A,
  };
}

module.exports = { buildClass, generateExtras, homeworkParts, BLOCKS, EXTRAS_VERSION };
