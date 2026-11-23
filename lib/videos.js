// Preparación de la clase: busca vídeos en YouTube para la lección y deja que el modelo elija el que mejor encaja.
// Usa la YouTube Data API v3 (YOUTUBE_API_KEY; si no, prueba con GOOGLE_TTS_KEY si ese proyecto tiene la API activada).
const claude = require("./claude");

const key = () => process.env.YOUTUBE_API_KEY || process.env.GOOGLE_TTS_KEY || "";
const enabled = () => !!key() && claude.enabled();

const isoMinutes = d => { const m = String(d || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/); return m ? (+m[1] || 0) * 60 + (+m[2] || 0) + (+m[3] || 0) / 60 : 99; };

async function yt(path, params) {
  const url = `https://www.googleapis.com/youtube/v3/${path}?` + new URLSearchParams({ ...params, key: key() });
  const r = await fetch(url);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("YouTube " + r.status + ": " + JSON.stringify(d.error && d.error.message || d).slice(0, 200));
  return d;
}

function queries(lesson, mod) {
  const words = lesson.pairs.slice(0, 3).map(p => p[0]).join(" ");
  return [
    `euskara ikasi ${lesson.eu}`,
    `aprender euskera ${lesson.title}`,
    `euskera ${words}`,
    mod && mod.en ? `learn basque ${mod.en}` : null,
  ].filter(Boolean);
}

// Devuelve { url, title, note } o null si ningún vídeo sirve.
async function findVideo(lesson, mod, exclude = []) {
  if (!enabled()) return null;
  const seen = new Map();
  for (const q of queries(lesson, mod)) {
    try {
      const d = await yt("search", { part: "snippet", q, type: "video", videoEmbeddable: "true", maxResults: "8", safeSearch: "strict" });
      for (const it of d.items || []) if (it.id && it.id.videoId && !exclude.includes(it.id.videoId)) seen.set(it.id.videoId, it.snippet);
    } catch (e) { console.error("Vídeos:", e.message); if (/40[03]/.test(e.message)) return null; }
  }
  if (!seen.size) return null;
  const det = await yt("videos", { part: "contentDetails,snippet", id: [...seen.keys()].slice(0, 50).join(",") });
  const cands = (det.items || [])
    .map(v => ({ id: v.id, title: v.snippet.title, channel: v.snippet.channelTitle, lang: v.snippet.defaultAudioLanguage || v.snippet.defaultLanguage || "", desc: String(v.snippet.description || "").slice(0, 250), min: Math.round(isoMinutes(v.contentDetails.duration) * 10) / 10 }))
    .filter(v => v.min >= 0.5 && v.min <= 15);
  if (!cands.length) return null;

  const pickRes = await claude.askJSON({
    system: "Eres Irati, profesora de euskera. Eliges material para tu clase. Devuelve SOLO JSON.",
    messages: [{ role: "user", content: `Clase: «${lesson.eu}» — ${lesson.title} (${lesson.desc}). Alumna adulta, nivel A1-A2, aprende desde el castellano.
Vocabulario: ${lesson.pairs.map(p => p[0]).join(", ")}

Candidatos de YouTube:
${cands.map((c, i) => `${i + 1}. [${c.id}] "${c.title}" — ${c.channel} — ${c.min} min — idioma: ${c.lang || "?"} — ${c.desc}`).join("\n")}

Elige UN vídeo que enseñe o muestre en uso el tema de esta clase, en euskera batua (o explicado en castellano/inglés), apto para adultos. Descarta canciones infantiles salvo que sean claramente útiles, vídeos de otros idiomas, y lo que no tenga relación clara con el tema. Si ninguno encaja de verdad, devuelve null.
Formato: {"id": "videoId o null", "title": "título corto en castellano", "note": "1 frase para la alumna: en qué fijarse al verlo"}` }],
    maxTokens: 300, temperature: 0.2,
  });
  if (!pickRes || !pickRes.id || !cands.some(c => c.id === pickRes.id)) return null;
  return { url: `https://www.youtube.com/watch?v=${pickRes.id}`, title: pickRes.title || cands.find(c => c.id === pickRes.id).title, note: pickRes.note || "" };
}

module.exports = { findVideo, enabled };
