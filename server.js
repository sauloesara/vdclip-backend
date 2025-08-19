// server.js (JavaScript simples, sem TypeScript)
// Funciona no Render com ffmpeg instalado via apt.txt

import express from 'express';
import cors from 'cors';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ytdl from 'ytdl-core';
import OpenAI from 'openai';

const app = express();
app.use(cors());
app.use(express.json({ limit: '20mb' }));

const PORT = process.env.PORT || 3000;
const PUB = path.resolve('./public');
fs.mkdirSync(PUB, { recursive: true });
app.use('/public', express.static(PUB));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// util: transformar segundos em SRT timecode
function tc(s) {
  const ms = Math.floor((s % 1) * 1000);
  const t = new Date(Math.floor(s) * 1000).toISOString().substring(11, 19);
  return `${t},${String(ms).padStart(3, '0')}`;
}
function srtBlock(i, a, b, text) { return `${i}\n${tc(a)} --> ${tc(b)}\n${text}\n\n`; }
function buildSRT(text, totalSec) {
  const lines = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  const slice = totalSec / Math.max(1, lines.length);
  let out = '', acc = 0, i = 1;
  for (const ln of lines) { out += srtBlock(i++, acc, acc + slice, ln.trim()); acc += slice; }
  return out;
}

app.get('/health', (req, res) => res.json({ ok: true }));

// Strict Mode: upload de arquivo local (alternativa legal)
app.post('/upload-media', express.raw({ type: 'application/octet-stream', limit: '200mb' }), async (req, res) => {
  try {
    const buf = req.body;
    const tmp = path.join(PUB, `upload-${Date.now()}.tmp`);
    fs.writeFileSync(tmp, buf);
    const wav = tmp.replace('.tmp', '.wav');
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', ['-y', '-i', tmp, '-ac', '1', '-ar', '16000', wav]);
      ff.on('close', c => c === 0 ? resolve() : reject(new Error('ffmpeg failed')));
    });
    const tr = await openai.audio.transcriptions.create({ file: fs.createReadStream(wav), model: 'whisper-1', language: 'pt' });
    res.json({ text: tr.text, wav: `/public/${path.basename(wav)}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Ingest YouTube (Owner/Consent)
app.post('/ingest-youtube', async (req, res) => {
  try {
    const { url, mode = 'owner', language = 'pt', max_clips = 5, clip_len_sec = 60 } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url required' });
    if (mode === 'strict') return res.status(400).json({ error: 'Strict mode: use /upload-media com o arquivo local.' });

    const videoId = ytdl.getURLVideoID(url);
    const info = await ytdl.getInfo(videoId);
    const title = info.videoDetails.title;

    // Extrair áudio com permissão do titular
    const wav = path.join(PUB, `${videoId}.wav`);
    await new Promise((resolve, reject) => {
      const audio = ytdl(url, { quality: 'highestaudio' });
      const ff = spawn('ffmpeg', ['-y', '-i', 'pipe:0', '-ac', '1', '-ar', '16000', wav]);
      audio.pipe(ff.stdin);
      ff.on('close', c => c === 0 ? resolve() : reject(new Error('ffmpeg failed')));
    });

    // Transcrever
    const tr = await openai.audio.transcriptions.create({ file: fs.createReadStream(wav), model: 'whisper-1', language });
    const transcript = tr.text || '';

    // Minerar cortes (usa LLM)
    const r = await openai.responses.create({
      model: 'gpt-4o-mini',
      input: [
        { role: 'system', content: 'Extraia até N clipes virais de ~60s com start/end em segundos, hook curto, headline e resumo do texto. Responda JSON: {clips: [{start,end,hook,headline,text}]}' },
        { role: 'user', content: JSON.stringify({ N: max_clips, clip_len_sec, transcript }) }
      ]
    });
    const raw = r.output_text || '{}';
    let plan; try { plan = JSON.parse(raw); } catch { plan = { clips: [] }; }

    const outDir = path.join(PUB, videoId);
    fs.mkdirSync(outDir, { recursive: true });
    const clips = [];
    (plan.clips || []).slice(0, max_clips).forEach((c, i) => {
      const total = Math.min(clip_len_sec, Math.max(5, (c.end - c.start) || clip_len_sec));
      const srt = buildSRT(c.text || transcript, total);
      const p = path.join(outDir, `c${i + 1}.srt`);
      fs.writeFileSync(p, srt, 'utf8');
      clips.push({ ...c, srt: `/public/${videoId}/c${i + 1}.srt` });
    });

    fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify({ meta: { title, videoId }, clips }, null, 2));

    res.json({ videoId, title, clips, planUrl: `/public/${videoId}/plan.json` });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`VDCLIP backend on :${PORT}`));
