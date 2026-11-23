# Irakaslea

Clase de euskera de una hora con **Irati**, una profesora IA con cara. Prototipo personal.

Cada clase sale de una lección de Euskara Praktika (`data/lessons.js`) y sigue siempre la misma estructura de 7 bloques
(calentamiento, repaso, tema nuevo, práctica, pausa, habla tú, cierre) con unas 16–18 actividades de formatos distintos:
conversación, parejas de memoria, escena con audio, diapositivas, tarjetas, vídeo, test, unir, ordenar, huecos,
transformaciones, test de oído, dictado, cápsula cultural, escritura corregida, pronunciación, ronda rápida, resumen y deberes.

Todo el euskera de los ejercicios sale del material ya revisado. Claude solo pone la parte en vivo (conversaciones,
corrección de textos y deberes, ficha de la alumna) y los extras de cada clase, que se generan una vez y se guardan.

## Variables de entorno (Railway)

| Variable | Para qué |
| --- | --- |
| `ANTHROPIC_API_KEY` | Conversación, corrección y extras de cada clase |
| `APP_PASSWORD` | Contraseña para entrar (sin ella, la app queda abierta) |
| `APP_SECRET` | Cadena larga aleatoria para firmar la sesión |
| `GOOGLE_TTS_KEY` o `AZURE_TTS_KEY` (+ `AZURE_TTS_REGION`) | Voz de Irati. Puede ser la misma clave que en Euskara Praktika. Sin clave usa Edge, que puede fallar |
| `DB_PATH` | `/data/irakaslea.db` con un volumen montado en `/data` |
| `CLAUDE_MODEL` | Opcional. Por defecto `claude-sonnet-5-5` |

## Actualizar el currículo

`npm run sync-lessons` descarga la última `lessons.js` de Euskara Praktika.
