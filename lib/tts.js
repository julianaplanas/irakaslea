// Voz de la profesora: euskera y castellano. Mismo esquema que Euskara Praktika:
// GOOGLE_TTS_KEY > AZURE_TTS_KEY > Edge (gratis, sin clave, menos fiable). Cada frase se genera una vez y se guarda.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const provider = process.env.GOOGLE_TTS_KEY ? "google" : process.env.AZURE_TTS_KEY ? "azure" : "edge";
const VOICES = {
  google: { eu: process.env.GOOGLE_TTS_VOICE || "eu-ES-Standard-A", es: process.env.GOOGLE_TTS_VOICE_ES || "" },
  azure: { eu: process.env.TTS_VOICE || "eu-ES-AinhoaNeural", es: process.env.TTS_VOICE_ES || "es-ES-ElviraNeural" },
  edge: { eu: process.env.TTS_VOICE || "eu-ES-AinhoaNeural", es: process.env.TTS_VOICE_ES || "es-ES-ElviraNeural" },
};
const voiceFor = lang => VOICES[provider][lang === "es" ? "es" : "eu"];

async function synthGoogle(text, lang) {
  const voice = lang === "es"
    ? (VOICES.google.es ? { languageCode: "es-ES", name: VOICES.google.es } : { languageCode: "es-ES", ssmlGender: "FEMALE" })
    : { languageCode: "eu-ES", name: VOICES.google.eu };
  const r = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize?key=" + encodeURIComponent(process.env.GOOGLE_TTS_KEY), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: { text }, voice, audioConfig: { audioEncoding: "MP3", speakingRate: lang === "es" ? 1.0 : 0.9 } }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.audioContent) throw new Error("Google TTS " + r.status);
  return Buffer.from(d.audioContent, "base64");
}

const esc = s => s.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
async function synthAzure(text, lang) {
  const region = process.env.AZURE_TTS_REGION || "westeurope";
  const xmlLang = lang === "es" ? "es-ES" : "eu-ES";
  const body = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}"><voice name="${voiceFor(lang)}"><prosody rate="${lang === "es" ? "0%" : "-10%"}">${esc(text)}</prosody></voice></speak>`;
  const r = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": process.env.AZURE_TTS_KEY, "Content-Type": "application/ssml+xml", "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "irakaslea" },
    body,
  });
  if (!r.ok) throw new Error("Azure TTS " + r.status);
  return Buffer.from(await r.arrayBuffer());
}

async function synthEdge(text, lang) {
  const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");
  const t = new MsEdgeTTS();
  await t.setMetadata(voiceFor(lang), OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Edge TTS: tiempo agotado")), 15000);
    try {
      const { audioStream } = t.toStream(text, { rate: lang === "es" ? 1 : 0.9 });
      audioStream.on("data", d => chunks.push(d));
      audioStream.on("end", () => { clearTimeout(timer); resolve(); });
      audioStream.on("close", () => { clearTimeout(timer); resolve(); });
      audioStream.on("error", e => { clearTimeout(timer); reject(e); });
    } catch (e) { clearTimeout(timer); reject(e); }
  });
  try { t.close(); } catch (e) {}
  if (!chunks.length) throw new Error("Edge TTS devolvió audio vacío");
  return Buffer.concat(chunks);
}

function makeHandler(audioDir) {
  fs.mkdirSync(audioDir, { recursive: true });
  const inflight = new Map();
  return async (req, res) => {
    const text = String(req.query.text || "").trim().slice(0, 400);
    const lang = req.query.lang === "es" ? "es" : "eu";
    if (!text) return res.status(400).end();
    const file = path.join(audioDir, crypto.createHash("sha1").update(provider + "|" + voiceFor(lang) + "|" + lang + "|" + text).digest("hex") + ".mp3");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (fs.existsSync(file)) return res.sendFile(file);
    try {
      const synth = provider === "google" ? synthGoogle : provider === "azure" ? synthAzure : synthEdge;
      if (!inflight.has(file)) inflight.set(file, synth(text, lang).then(buf => { fs.writeFileSync(file, buf); return buf; }).finally(() => inflight.delete(file)));
      res.type("audio/mpeg").send(await inflight.get(file));
    } catch (e) {
      console.error("TTS:", e.message);
      res.status(503).json({ error: "Audio no disponible" });
    }
  };
}

module.exports = { makeHandler, provider };
