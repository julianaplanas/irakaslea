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

function gapItems(lesson, r) {
  const terms = lesson.pairs.map(p => p[0]).filter(t => !/[?!]/.test(t)).sort((a, b) => b.length - a.length);
  const items = [];
  for (const [eu, es] of shuffle(lesson.sentences, r)) {
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

function fallbackExtras(lesson) {
  const scene = (lesson.scene && lesson.scene.title) || lesson.title;
  return {
    warmup: { situation: "Charla corta de bienvenida, como al llegar a clase.", goal: "Saludar, decir qué tal estás y repasar lo de la clase anterior.", starter: "Kaixo! Zer moduz zaude gaur?" },
    roleplay: { situation: `${scene}. Usa el tema de la clase: ${lesson.title}.`, goal: `Usar en una conversación real: ${lesson.desc}`, starter: (lesson.dialogue[0] || [])[1] || "Kaixo!" },
    culture: null,
    writing: { prompt: `Escribe 3 o 4 frases sobre ti usando lo de hoy (${lesson.title}). Puedes inspirarte en: «${lesson.sentences[0][0]}»` },
    homework: { brief: `1) Escribe 5 frases propias sobre «${lesson.eu}» (${lesson.title}).\n2) Traduce al euskera: ${lesson.sentences.slice(-3).map(s => "«" + s[1] + "»").join(", ")}.\n3) Léelo en voz alta y grábate.` },
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

Devuelve este JSON (textos en castellano salvo lo marcado como euskera; el euskera solo con el vocabulario y estructuras del material o anteriores):
{
 "warmup": {"situation": "situación de charla inicial de 1-2 frases que conecte con la clase anterior", "goal": "qué tiene que practicar la alumna", "starter": "primera frase de Irati, en euskera, muy sencilla"},
 "roleplay": {"situation": "situación realista y concreta en Euskal Herria para practicar el tema de hoy (lugar, quién es Irati en la escena)", "goal": "qué tiene que conseguir la alumna", "starter": "primera frase de Irati en euskera"},
 "culture": {"title": "título corto", "body": "3-4 frases sobre una costumbre, lugar, expresión o dato vasco relacionado con el tema; solo datos que sepas con seguridad", "eu_word": "una palabra o expresión vasca relacionada (o vacío)"},
 "writing": {"prompt": "consigna para escribir 3-5 frases sobre su propia vida usando el tema"},
 "homework": {"brief": "deberes para la semana en 3 partes numeradas: ejercicio escrito con frases concretas a traducir o completar, una redacción corta (40-60 palabras) con consigna clara, y leer en voz alta. Usa saltos de línea."}
}`;
  try {
    const ex = await claude.askJSON({ system, messages: [{ role: "user", content: prompt }], maxTokens: 1500 });
    return { ...fallbackExtras(lesson), ...ex };
  } catch (e) {
    console.error("Extras:", e.message);
    return fallbackExtras(lesson);
  }
}

// Construye la clase. extras: objeto de generateExtras; ctx: { weak, homework, videos }
function buildClass(lesson, extras, ctx = {}) {
  const r = rng(lesson.id);
  const prev = C.prevLesson(lesson.id);
  const mod = C.moduleOf(lesson.id) || {};
  const A = [];
  const add = (block, type, intro, data = {}) => A.push({ id: `${block}-${A.length + 1}`, block, type, intro, ...data });

  // 1. Calentamiento
  add("warmup", "roleplay", `«Kaixo!» Soy Irati. Hoy toca «${lesson.eu}»: ${lesson.title.toLowerCase()}. Antes, charlamos un poco para calentar.`,
    { ...extras.warmup, turns: 4 });

  // 2. Repaso
  if (ctx.homework && ctx.homework.correction) {
    add("review", "feedback", "Tu tarea de la semana pasada ya está corregida. Mira lo principal.", { homework: ctx.homework });
  }
  const reviewPairs = [
    ...(ctx.weak || []).map(w => [w.eu, w.es, "🔁"]),
    ...(prev ? pick(prev.pairs, 6, r) : []),
  ].slice(0, 6);
  if (reviewPairs.length >= 3) add("review", "memory", prev ? `Repasamos «${prev.eu}» con un juego de parejas.` : "Un juego de parejas para arrancar.", { pairs: reviewPairs });

  // 3. Tema nuevo
  add("input", "scene", `Mira esta escena: «${((lesson.scene && lesson.scene.title) || lesson.eu).split(" · ")[0]}». Toca cada frase para escucharla. Intenta entenderla antes de ver la traducción.`,
    { title: lesson.scene && lesson.scene.title, emoji: lesson.scene && lesson.scene.emoji, lines: lesson.dialogue });
  add("input", "slides", "Ahora te explico cómo funciona.", { slides: slidesFor(lesson) });
  add("input", "cards", "Las palabras de hoy. Escucha cada una y dale la vuelta a la tarjeta.", { pairs: lesson.pairs });
  for (const v of (ctx.videos || []).slice(0, 1)) add("input", "video", "Un vídeo con euskera real. No hace falta entenderlo todo: quédate con lo que reconoces.", { url: v.url, title: v.title, note: v.note });

  // 4. Práctica controlada
  const mcqPairs = pick(lesson.pairs, 6, r);
  add("practice", "mcq", "¿Qué significa? Elige la respuesta.", {
    items: mcqPairs.map(p => ({ q: p[0], qLang: "eu", answer: p[1], options: options(p[1], lesson.pairs.map(x => x[1]), r) })),
  });
  add("practice", "match", "Une cada palabra con su dibujo.", { pairs: pick(lesson.pairs, 6, r) });
  const orderItems = pick(lesson.sentences.filter(s => wordCount(s[0]) >= 3 && wordCount(s[0]) <= 8), 4, r);
  if (orderItems.length) add("practice", "order", "Ordena las piezas para formar la frase.", { items: orderItems.map(([eu, es]) => ({ eu, es })) });
  const gaps = gapItems(lesson, r);
  if (gaps.length >= 2) add("practice", "gap", "Completa el hueco.", { items: gaps });
  const drills = C.grammarFor(lesson.id).flatMap(g => g.drills || []).slice(0, 5);
  if (drills.length) add("practice", "transform", "Transforma la frase como te pido. Escríbela entera.", { items: drills });
  add("practice", "mcq", "Ahora solo con el oído: escucha y elige qué significa.", {
    listen: true,
    items: pick(lesson.sentences, 4, r).map(([eu, es]) => ({ q: eu, qLang: "eu", answer: es, options: options(es, lesson.sentences.map(s => s[1]), r) })),
  });
  const dict = pick(lesson.sentences.filter(s => wordCount(s[0]) <= 6), 3, r);
  if (dict.length) add("practice", "dictation", "Dictado: escucha y escribe lo que oyes. Puedes repetir el audio.", { items: dict.map(([eu, es]) => ({ eu, es })) });

  // 5. Pausa
  if (extras.culture && extras.culture.body) add("break", "culture", "Pausa de dos minutos. Te cuento algo.", { ...extras.culture });

  // 6. Habla tú
  add("free", "roleplay", "Ahora, una situación real. Contesta en euskera como puedas; si te atascas, escríbeme en castellano y te ayudo.", { ...extras.roleplay, turns: 8 });
  add("free", "write", "Escribe sobre ti. Te lo corrijo al momento.", { prompt: extras.writing.prompt });
  add("free", "repeat", "Pronunciación: escucha, repite en voz alta y, si quieres, grábate para compararte.", { items: pick(lesson.pairs, 6, r).map(p => p[0]) });

  // 7. Cierre
  add("wrap", "speed", "Ronda rápida: 60 segundos, todas las que puedas.", { pairs: lesson.pairs, seconds: 60 });
  add("wrap", "summary", "Esto es lo que te llevas de hoy.", { pattern: lesson.pattern, words: lesson.pairs.slice(0, 8), tip: (lesson.tips[0] || {}).t });
  add("wrap", "homework", "Y los deberes para la próxima clase. Me los entregas en la pestaña «Etxeko lanak».", { brief: extras.homework.brief });

  return {
    lesson: { id: lesson.id, eu: lesson.eu, title: lesson.title, emoji: lesson.emoji, module: mod.id, moduleEu: mod.eu, level: (mod.id || 1) >= 9 ? "A2" : "A1" },
    material: { pairs: lesson.pairs, sentences: lesson.sentences, pattern: lesson.pattern, desc: lesson.desc },
    blocks: BLOCKS,
    activities: A,
  };
}

module.exports = { buildClass, generateExtras, BLOCKS };
