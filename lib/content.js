// Carga el currículo de Euskara Praktika (data/lessons.js, copiado del repo euskera-app).
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const file = path.join(__dirname, "..", "data", "lessons.js");
const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(file, "utf8"), sandbox);
const W = sandbox.window;

const MODULES = W.MODULES || [];
const LESSONS = (W.LESSONS || []).filter(l => !String(l.id).startsWith("lg")); // fuera las lecciones de Gabonak (módulo especial)
const GRAMMAR = W.GRAMMAR || [];

const byId = Object.fromEntries(LESSONS.map(l => [l.id, l]));
const moduleOf = id => MODULES.find(m => m.id === (byId[id] || {}).module);
const grammarFor = id => GRAMMAR.filter(g => (g.lessons || []).includes(id));
const prevLesson = id => { const i = LESSONS.findIndex(l => l.id === id); return i > 0 ? LESSONS[i - 1] : null; };
const nextLesson = id => { const i = LESSONS.findIndex(l => l.id === id); return i >= 0 && i < LESSONS.length - 1 ? LESSONS[i + 1] : null; };

module.exports = { MODULES, LESSONS, GRAMMAR, byId, moduleOf, grammarFor, prevLesson, nextLesson };
