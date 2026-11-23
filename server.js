// Irakaslea — clase de euskera de una hora con Irati, profesora IA. Prototipo para una sola alumna.
const express = require("express");
const Database = require("better-sqlite3");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");

const C = require("./lib/content");
const claude = require("./lib/claude");
const tts = require("./lib/tts");
const { buildClass, generateExtras } = require("./lib/classBuilder");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "irakaslea.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS extras (lesson_id TEXT PRIMARY KEY, json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS classes (lesson_id TEXT PRIMARY KEY, started_at TEXT, finished_at TEXT, minutes INTEGER);
  CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id TEXT NOT NULL, activity_id TEXT NOT NULL, type TEXT NOT NULL, ok INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE IF NOT EXISTS misses (eu TEXT PRIMARY KEY, es TEXT NOT NULL, lesson_id TEXT, count INTEGER NOT NULL DEFAULT 1, last TEXT NOT NULL DEFAULT (datetime('now')), reviewed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS homework (lesson_id TEXT PRIMARY KEY, brief TEXT NOT NULL, answer TEXT, correction TEXT, submitted_at TEXT, corrected_at TEXT);
  CREATE TABLE IF NOT EXISTS videos (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT, note TEXT);
  CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY CHECK (id = 1), text TEXT NOT NULL DEFAULT '', updated_at TEXT);
  CREATE TABLE IF NOT EXISTS writings (id INTEGER PRIMARY KEY AUTOINCREMENT, lesson_id TEXT, prompt TEXT, text TEXT, correction TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
`);
db.prepare("INSERT OR IGNORE INTO notes (id, text) VALUES (1, '')").run();

const app = express();
app.use(express.json({ limit: "200kb" }));
app.use(cookieParser());

// ---------- acceso: una sola contraseña (APP_PASSWORD). Sin ella, abierto (para probar en local). ----------
const SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString("hex");
const sign = v => v + "." + crypto.createHmac("sha256", SECRET).update(v).digest("hex").slice(0, 32);
const authed = req => !process.env.APP_PASSWORD || req.cookies.irk === sign("ok");
app.post("/api/login", (req, res) => {
  const p = String((req.body || {}).password || "");
  const want = process.env.APP_PASSWORD || "";
  if (!want || (p.length === want.length && crypto.timingSafeEqual(Buffer.from(p), Buffer.from(want)))) {
    res.cookie("irk", sign("ok"), { httpOnly: true, sameSite: "lax", secure: !!process.env.RAILWAY_ENVIRONMENT, maxAge: 1000 * 60 * 60 * 24 * 180 });
    return res.json({ ok: true });
  }
  res.status(401).json({ error: "Contraseña incorrecta" });
});
app.use("/api", (req, res, next) => (authed(req) ? next() : res.status(401).json({ error: "login" })));

// ---------- datos ----------
const notes = () => db.prepare("SELECT text FROM notes WHERE id = 1").get().text;
const weakWords = (n = 4) => db.prepare("SELECT eu, es FROM misses WHERE reviewed = 0 ORDER BY count DESC, last DESC LIMIT ?").all(n);
const videosFor = id => {
  const l = C.byId[id];
  return db.prepare("SELECT url, title, note FROM videos WHERE lesson_id = ? OR lesson_id = ? ORDER BY id").all(id, "m" + (l ? l.module : ""));
};

async function getExtras(lesson) {
  const row = db.prepare("SELECT json FROM extras WHERE lesson_id = ?").get(lesson.id);
  if (row) return JSON.parse(row.json);
  const ex = await generateExtras(lesson);
  if (claude.enabled() && ex.culture) db.prepare("INSERT OR REPLACE INTO extras (lesson_id, json) VALUES (?, ?)").run(lesson.id, JSON.stringify(ex));
  return ex;
}

app.get("/api/state", (req, res) => {
  const done = Object.fromEntries(db.prepare("SELECT lesson_id, finished_at FROM classes").all().map(r => [r.lesson_id, r.finished_at]));
  const hw = db.prepare("SELECT lesson_id, submitted_at, corrected_at FROM homework").all();
  const next = C.LESSONS.find(l => !done[l.id]) || C.LESSONS[0];
  res.json({
    modules: C.MODULES.filter(m => C.LESSONS.some(l => l.module === m.id)).map(m => ({ id: m.id, eu: m.eu, es: m.es, town: m.town, level: m.id >= 9 ? "A2" : "A1" })),
    lessons: C.LESSONS.map(l => ({ id: l.id, module: l.module, eu: l.eu, title: l.title, emoji: l.emoji, done: !!done[l.id] })),
    next: next.id,
    homework: hw,
    claude: claude.enabled(),
    tts: tts.provider,
  });
});

app.get("/api/class/:id", async (req, res) => {
  const lesson = C.byId[req.params.id];
  if (!lesson) return res.status(404).json({ error: "No existe esa clase" });
  const done = new Set(db.prepare("SELECT lesson_id FROM classes WHERE finished_at IS NOT NULL").all().map(r => r.lesson_id));
  const next = C.LESSONS.find(l => !done.has(l.id));
  if (!done.has(lesson.id) && next && lesson.id !== next.id) return res.status(403).json({ error: `Primero termina «${next.eu}».` });
  const extras = await getExtras(lesson);
  const prev = C.prevLesson(lesson.id);
  const homework = prev ? db.prepare("SELECT * FROM homework WHERE lesson_id = ? AND corrected_at IS NOT NULL").get(prev.id) : null;
  if (homework) homework.correction = JSON.parse(homework.correction);
  const cls = buildClass(lesson, extras, { weak: weakWords(), homework, videos: videosFor(lesson.id) });
  db.prepare("INSERT INTO classes (lesson_id, started_at) VALUES (?, datetime('now')) ON CONFLICT(lesson_id) DO UPDATE SET started_at = COALESCE(started_at, excluded.started_at)").run(lesson.id);
  db.prepare("INSERT OR IGNORE INTO homework (lesson_id, brief) VALUES (?, ?)").run(lesson.id, extras.homework.brief);
  res.json(cls);
});

// Las respuestas de cada actividad: sirven para el repaso de la próxima clase.
app.post("/api/class/:id/result", (req, res) => {
  const { activityId, type, ok = 0, total = 0, misses = [] } = req.body || {};
  db.prepare("INSERT INTO results (lesson_id, activity_id, type, ok, total) VALUES (?, ?, ?, ?, ?)").run(req.params.id, String(activityId), String(type), ok | 0, total | 0);
  const up = db.prepare("INSERT INTO misses (eu, es, lesson_id) VALUES (?, ?, ?) ON CONFLICT(eu) DO UPDATE SET count = count + 1, last = datetime('now'), reviewed = 0");
  for (const m of misses.slice(0, 20)) if (m && m.eu) up.run(String(m.eu).slice(0, 200), String(m.es || "").slice(0, 200), req.params.id);
  const hits = (req.body || {}).hits || [];
  const rev = db.prepare("UPDATE misses SET reviewed = 1 WHERE eu = ?");
  for (const h of hits.slice(0, 20)) rev.run(String(h));
  res.json({ ok: true });
});

app.post("/api/class/:id/finish", async (req, res) => {
  const minutes = Math.round(Number((req.body || {}).minutes) || 0);
  db.prepare("UPDATE classes SET finished_at = datetime('now'), minutes = ? WHERE lesson_id = ?").run(minutes, req.params.id);
  res.json({ ok: true });
  // Actualiza la ficha de la alumna en segundo plano.
  if (!claude.enabled()) return;
  try {
    const lesson = C.byId[req.params.id];
    const rs = db.prepare("SELECT type, ok, total FROM results WHERE lesson_id = ? ORDER BY id DESC LIMIT 30").all(req.params.id);
    const writings = db.prepare("SELECT text, correction FROM writings WHERE lesson_id = ? ORDER BY id DESC LIMIT 3").all(req.params.id);
    const text = await claude.ask({
      system: "Eres Irati, profesora de euskera. Mantienes una ficha breve de tu alumna. Devuelve solo la ficha actualizada, en castellano, máximo 200 palabras, con secciones: Nivel y ritmo · Lo que domina · Errores frecuentes · Intereses y datos que ha contado · Próximos focos.",
      messages: [{ role: "user", content: `Ficha actual:\n${notes() || "(vacía)"}\n\nClase de hoy: ${lesson.eu} (${lesson.title}), ${minutes} min.\nResultados por actividad: ${JSON.stringify(rs)}\nPalabras falladas: ${JSON.stringify(weakWords(10))}\nEscritos corregidos: ${JSON.stringify(writings)}` }],
      maxTokens: 700, temperature: 0.3,
    });
    db.prepare("UPDATE notes SET text = ?, updated_at = datetime('now') WHERE id = 1").run(text);
  } catch (e) { console.error("Ficha:", e.message); }
});

// ---------- conversación con Irati (role-play) ----------
app.post("/api/chat", async (req, res) => {
  if (!claude.enabled()) return res.json({ text: "Ahora mismo no puedo conversar (falta la clave de OpenRouter). Salta esta actividad con «Jarraitu»." });
  const { lessonId, situation, goal, messages = [], turnsLeft = 3 } = req.body || {};
  const lesson = C.byId[lessonId];
  if (!lesson) return res.status(400).json({ error: "clase" });
  const system = `${claude.TEACHER}

Estás en una actividad de role-play dentro de la clase «${lesson.eu}» (${lesson.title}).
Situación: ${situation}
Objetivo de la alumna: ${goal}
Vocabulario de la clase: ${lesson.pairs.map(p => p[0]).join(", ")}
Frases modelo: ${lesson.sentences.map(s => s[0]).join(" / ")}
Ficha de la alumna: ${notes() || "(aún vacía)"}

Reglas del role-play:
- Haz tu papel en euskera, con frases muy cortas y del nivel de la clase. Una sola pregunta por turno.
- Si la alumna comete un error, después de tu respuesta añade UNA línea que empiece por "✏️" con la corrección en castellano.
- Si escribe en castellano o dice que no sabe, dale la frase en euskera que necesita y pídele que la escriba.
- Tras cada frase en euskera que digas, añade entre paréntesis la traducción solo si incluye algo que no esté en el vocabulario de la clase.
- Quedan ${turnsLeft} turnos. Si quedan 0, cierra la escena en euskera y añade una línea "⭐" en castellano con lo que ha hecho bien y una cosa a mejorar.`;
  const msgs = messages.slice(-16).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 1000) }));
  if (!msgs.length || msgs[0].role !== "user") msgs.unshift({ role: "user", content: "(Empieza la actividad.)" });
  try {
    res.json({ text: await claude.ask({ system, messages: msgs, maxTokens: 400 }) });
  } catch (e) { console.error("Chat:", e.message); res.status(502).json({ error: "Irati no responde ahora. Prueba otra vez." }); }
});

// ---------- escritura corregida al momento ----------
const CORRECT_SCHEMA = `{"corrected": "el texto corregido entero", "errors": [{"wrong": "fragmento", "right": "corrección", "why": "regla en una frase, en castellano"}], "good": "una cosa concreta que ha hecho bien", "next": "una sugerencia para mejorar"}`;
async function correct(lesson, prompt, text) {
  return claude.askJSON({
    system: claude.TEACHER + "\nCorriges un texto de tu alumna. Corrige solo errores reales; no reescribas su estilo. Si algo es correcto pero poco natural, menciónalo en next. Devuelve SOLO JSON.",
    messages: [{ role: "user", content: `Clase: ${lesson ? lesson.eu + " (" + lesson.title + ")" : "-"}\nConsigna: ${prompt}\nTexto de la alumna:\n${text}\n\nDevuelve: ${CORRECT_SCHEMA}` }],
    maxTokens: 1200,
  });
}
app.post("/api/write", async (req, res) => {
  if (!claude.enabled()) return res.status(503).json({ error: "Falta la clave de OpenRouter para corregir." });
  const { lessonId, prompt, text } = req.body || {};
  if (!String(text || "").trim()) return res.status(400).json({ error: "Escribe algo primero" });
  try {
    const c = await correct(C.byId[lessonId], prompt, String(text).slice(0, 3000));
    db.prepare("INSERT INTO writings (lesson_id, prompt, text, correction) VALUES (?, ?, ?, ?)").run(lessonId, prompt, text, JSON.stringify(c));
    res.json(c);
  } catch (e) { console.error("Write:", e.message); res.status(502).json({ error: "No he podido corregirlo ahora. Prueba otra vez." }); }
});

// ---------- deberes ----------
app.get("/api/homework", (req, res) => {
  res.json(db.prepare("SELECT * FROM homework ORDER BY rowid DESC").all().map(h => ({ ...h, correction: h.correction ? JSON.parse(h.correction) : null, lesson: C.byId[h.lesson_id] ? { eu: C.byId[h.lesson_id].eu, title: C.byId[h.lesson_id].title, emoji: C.byId[h.lesson_id].emoji } : null })));
});
app.post("/api/homework/:id", async (req, res) => {
  const h = db.prepare("SELECT * FROM homework WHERE lesson_id = ?").get(req.params.id);
  if (!h) return res.status(404).json({ error: "No hay deberes para esa clase" });
  const answer = String((req.body || {}).answer || "").slice(0, 6000);
  if (!answer.trim()) return res.status(400).json({ error: "Escribe tu respuesta" });
  db.prepare("UPDATE homework SET answer = ?, submitted_at = datetime('now') WHERE lesson_id = ?").run(answer, req.params.id);
  if (!claude.enabled()) return res.json({ ok: true, pending: true });
  try {
    const c = await correct(C.byId[req.params.id], h.brief, answer);
    db.prepare("UPDATE homework SET correction = ?, corrected_at = datetime('now') WHERE lesson_id = ?").run(JSON.stringify(c), req.params.id);
    res.json({ ok: true, correction: c });
  } catch (e) { console.error("Homework:", e.message); res.json({ ok: true, pending: true }); }
});

// ---------- vídeos (enlaces que pegas tú: INGURA, Ikasbil, YouTube…) ----------
app.get("/api/videos", (req, res) => res.json(db.prepare("SELECT * FROM videos ORDER BY lesson_id, id").all()));
app.post("/api/videos", (req, res) => {
  const { lessonId, url, title, note } = req.body || {};
  if (!/^https?:\/\//.test(String(url || ""))) return res.status(400).json({ error: "Pega un enlace que empiece por http" });
  db.prepare("INSERT INTO videos (lesson_id, url, title, note) VALUES (?, ?, ?, ?)").run(String(lessonId), url, title || "", note || "");
  res.json({ ok: true });
});
app.delete("/api/videos/:id", (req, res) => { db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id); res.json({ ok: true }); });

// ---------- ficha ----------
app.get("/api/notes", (req, res) => res.json({ text: notes(), weak: weakWords(15) }));
app.put("/api/notes", (req, res) => { db.prepare("UPDATE notes SET text = ?, updated_at = datetime('now') WHERE id = 1").run(String((req.body || {}).text || "").slice(0, 5000)); res.json({ ok: true }); });

// Rehacer los extras de una clase (si no te gusta la situación o la cápsula).
app.post("/api/class/:id/regenerate", (req, res) => { db.prepare("DELETE FROM extras WHERE lesson_id = ?").run(req.params.id); res.json({ ok: true }); });

app.get("/api/tts", tts.makeHandler(path.join(path.dirname(DB_PATH), "audio")));

app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Irakaslea en http://localhost:${PORT} · Claude: ${claude.enabled() ? claude.MODEL : "no"} · voz: ${tts.provider}`));
