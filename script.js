/* ============================================================
   Reels Studio — منطق التطبيق بالكامل يعمل داخل المتصفح.
   لا يوجد أي سيرفر خلفي: الفيديو يُعالج محليًا عبر ffmpeg.wasm،
   والتحليل الذكي يتم عبر استدعاء API مباشرة من المتصفح بمفتاحك.
   ============================================================ */

const { FFmpeg } = FFmpegWASM;
const { fetchFile, toBlobURL } = FFmpegUtil;

let ffmpeg = null;
let ffmpegLoaded = false;

let currentFile = null;       // File المرفوع
let currentVideoURL = null;   // object URL للمعاينة
let transcriptSegments = [];  // نتيجة Whisper بعد التنظيم
let clips = [];                // { id, start, end, title, score, blob, url, segments }

// ---------- DOM ----------
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const urlInput = document.getElementById("urlInput");
const urlLoadBtn = document.getElementById("urlLoadBtn");
const fileInfo = document.getElementById("fileInfo");
const previewVideo = document.getElementById("previewVideo");
const fileName = document.getElementById("fileName");
const analyzeBtn = document.getElementById("analyzeBtn");
const analyzeBtnText = document.getElementById("analyzeBtnText");
const progressBox = document.getElementById("progressBox");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const clipsGrid = document.getElementById("clipsGrid");
const emptyState = document.getElementById("emptyState");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");

// Editor modal
const editorModal = document.getElementById("editorModal");
const modalClose = document.getElementById("modalClose");
const editorVideo = document.getElementById("editorVideo");
const editStart = document.getElementById("editStart");
const editEnd = document.getElementById("editEnd");
const editTranscript = document.getElementById("editTranscript");
const rerenderBtn = document.getElementById("rerenderBtn");
const downloadClipBtn = document.getElementById("downloadClipBtn");
const editorStatus = document.getElementById("editorStatus");
let activeClipId = null;

// ============================================================
// 1. تحميل ffmpeg.wasm
// ============================================================
async function ensureFFmpegLoaded() {
  if (ffmpegLoaded) return;
  setStatus("busy", "تحميل محرك المعالجة...");
  ffmpeg = new FFmpeg();
  const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
  });
  ffmpegLoaded = true;
  setStatus("ok", "جاهز");
}

function setStatus(kind, text) {
  statusDot.className = "status-dot" + (kind === "busy" ? " busy" : kind === "error" ? " error" : "");
  statusText.textContent = text;
}

function setProgress(pct, label) {
  progressBox.classList.remove("hidden");
  progressBar.style.width = `${pct}%`;
  progressLabel.textContent = label;
}

// ============================================================
// 2. رفع الملف / السحب والإفلات / الرابط المباشر
// ============================================================
dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("dragover"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("dragover");
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) handleFile(e.target.files[0]);
});

urlLoadBtn.addEventListener("click", async () => {
  const url = urlInput.value.trim();
  if (!url) return;
  try {
    setStatus("busy", "جاري تحميل الفيديو من الرابط...");
    const res = await fetch(url);
    if (!res.ok) throw new Error("تعذر الوصول للرابط (تحقق من إعدادات CORS في السيرفر المصدر)");
    const blob = await res.blob();
    const file = new File([blob], "video-from-url.mp4", { type: blob.type || "video/mp4" });
    handleFile(file);
  } catch (err) {
    alert("فشل تحميل الفيديو من الرابط: " + err.message + "\n\nملاحظة: روابط يوتيوب غير مدعومة من المتصفح مباشرة — فقط روابط MP4 مباشرة تسمح بـ CORS.");
    setStatus("error", "فشل تحميل الرابط");
  }
});

function handleFile(file) {
  currentFile = file;
  currentVideoURL = URL.createObjectURL(file);
  previewVideo.src = currentVideoURL;
  fileName.textContent = file.name;
  fileInfo.classList.remove("hidden");
  analyzeBtn.disabled = false;
}

// ============================================================
// 3. زر "تحليل واختيار أفضل اللحظات" — يشغّل خط الأنابيب كامل
// ============================================================
analyzeBtn.addEventListener("click", async () => {
  if (!currentFile) return;
  if (!CONFIG.OPENAI_API_KEY || CONFIG.OPENAI_API_KEY.includes("ضع_مفتاح")) {
    alert("الرجاء إضافة مفتاح OpenAI API في ملف config.js أولاً.");
    return;
  }

  analyzeBtn.disabled = true;
  try {
    await ensureFFmpegLoaded();

    // --- Stage 1: استخراج الصوت لتقليل الحجم قبل إرساله لـ Whisper ---
    setProgress(10, "استخراج الصوت من الفيديو...");
    const audioBlob = await extractAudio(currentFile);

    // --- Stage 2: تفريغ الصوت إلى نص عبر Whisper API ---
    setProgress(25, "تفريغ الصوت إلى نص (Whisper)...");
    const transcript = await transcribeAudio(audioBlob);
    transcriptSegments = transcript.segments;

    // --- Stage 3: تحليل النص واختيار أفضل اللحظات عبر LLM ---
    setProgress(45, "تحليل النص واختيار أفضل اللحظات...");
    const highlights = await detectHighlights(transcript);

    if (!highlights.length) {
      alert("لم يتم العثور على لحظات مناسبة في هذا الفيديو.");
      setProgress(0, "");
      progressBox.classList.add("hidden");
      analyzeBtn.disabled = false;
      return;
    }

    // --- Stage 4: قص + تحويل لعمودي + حرق الترجمة لكل مقطع ---
    clips = [];
    renderClipsGrid();
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      const pct = 50 + Math.round(((i + 1) / highlights.length) * 45);
      setProgress(pct, `معالجة المقطع ${i + 1} من ${highlights.length}...`);
      const clip = await renderClip(h, i);
      clips.push(clip);
      renderClipsGrid();
    }

    setProgress(100, "اكتمل!");
    setTimeout(() => progressBox.classList.add("hidden"), 1500);
  } catch (err) {
    console.error(err);
    alert("حدث خطأ: " + err.message);
    setStatus("error", "حدث خطأ");
  } finally {
    analyzeBtn.disabled = false;
  }
});

// ============================================================
// 4. استخراج الصوت عبر ffmpeg.wasm
// ============================================================
async function extractAudio(file) {
  const inputName = "input" + getExt(file.name);
  await ffmpeg.writeFile(inputName, await fetchFile(file));
  await ffmpeg.exec([
    "-i", inputName,
    "-vn", "-acodec", "libmp3lame", "-ar", "16000", "-ac", "1", "-b:a", "64k",
    "audio.mp3",
  ]);
  const data = await ffmpeg.readFile("audio.mp3");
  return new Blob([data.buffer], { type: "audio/mp3" });
}

function getExt(filename) {
  const m = filename.match(/\.[^.]+$/);
  return m ? m[0] : ".mp4";
}

// ============================================================
// 5. Whisper API — تفريغ الصوت مع توقيت كل كلمة
// ============================================================
async function transcribeAudio(audioBlob) {
  const form = new FormData();
  form.append("file", audioBlob, "audio.mp3");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  form.append("timestamp_granularities[]", "segment");

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${CONFIG.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error("فشل تفريغ الصوت: " + (await res.text()).slice(0, 200));
  const data = await res.json();

  // ترتيب الكلمات ضمن كل segment (نفس منطق الباك اند)
  const words = data.words || [];
  const segments = (data.segments || []).map((seg) => ({
    id: seg.id,
    start: seg.start,
    end: seg.end,
    text: seg.text.trim(),
    words: words.filter((w) => w.start >= seg.start && w.start < seg.end),
  }));

  return { language: data.language, full_text: data.text, segments };
}

// ============================================================
// 6. تحليل النص واختيار أفضل اللحظات (GPT / Claude)
// ============================================================
const SYSTEM_PROMPT = `أنت محرر فيديو محترف متخصص في المحتوى الفيروسي القصير (TikTok, Reels, Shorts).
ستُعطى نص فيديو مقسم لمقاطع زمنية (كل مقطع فيه start و end بالثواني و text).
اختر أفضل اللحظات القابلة لتصبح مقاطع قصيرة منفصلة، بالشروط التالية:

قواعد صارمة:
1. كل مقطع يجب أن يكون فكرة كاملة (لا يبدأ ولا ينتهي في منتصف جملة أو فكرة).
2. مدة كل مقطع بين ${"{MIN}"} و ${"{MAX}"} ثانية.
3. قيم start و end يجب أن تُطابق تمامًا توقيتات موجودة فعليًا في النص المُعطى.
4. لا تكرار أو تداخل بين المقاطع.
5. رتّب حسب virality_score (0-10).
6. أعد فقط JSON صالح (مصفوفة)، بدون أي نص إضافي أو markdown.

الشكل المطلوب:
[
  {"start": 12.4, "end": 42.1, "title": "عنوان جذاب قصير", "reason": "hook", "virality_score": 8.5, "rationale": "سبب مختصر"}
]`;

async function detectHighlights(transcript) {
  const compact = transcript.segments.map((s) => ({
    start: Math.round(s.start * 100) / 100,
    end: Math.round(s.end * 100) / 100,
    text: s.text,
  }));

  const system = SYSTEM_PROMPT
    .replace("{MIN}", CONFIG.MIN_CLIP_DURATION)
    .replace("{MAX}", CONFIG.MAX_CLIP_DURATION);

  const userPrompt = `النص:\n${JSON.stringify(compact)}\n\nأعد أفضل ${CONFIG.NUM_CLIPS} مقاطع كمصفوفة JSON فقط.`;

  let rawText;
  if (CONFIG.USE_ANTHROPIC_FOR_ANALYSIS) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CONFIG.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 3000,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) throw new Error("فشل التحليل عبر Claude: " + (await res.text()).slice(0, 200));
    const data = await res.json();
    rawText = data.content.map((b) => b.text || "").join("");
  } else {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${CONFIG.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system + "\n\nأعد الناتج داخل كائن JSON بمفتاح واحد اسمه clips يحتوي المصفوفة." },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) throw new Error("فشل التحليل عبر GPT: " + (await res.text()).slice(0, 200));
    const data = await res.json();
    rawText = data.choices[0].message.content;
  }

  rawText = rawText.trim().replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim();
  let parsed = JSON.parse(rawText);
  if (!Array.isArray(parsed)) parsed = parsed.clips || Object.values(parsed)[0] || [];

  // تحقق دفاعي: التزام بالمدة وعدم التداخل — لا نثق بمخرجات النموذج كليًا
  return validateHighlights(parsed);
}

function validateHighlights(candidates) {
  let valid = candidates.filter((c) => {
    const dur = c.end - c.start;
    return dur >= CONFIG.MIN_CLIP_DURATION && dur <= CONFIG.MAX_CLIP_DURATION && c.end > c.start;
  });
  valid.sort((a, b) => (b.virality_score || 0) - (a.virality_score || 0));
  const accepted = [];
  for (const c of valid) {
    const overlaps = accepted.some((a) => !(c.end <= a.start || c.start >= a.end));
    if (!overlaps) accepted.push(c);
  }
  return accepted;
}

// ============================================================
// 7. معالجة كل مقطع: قص -> تحويل عمودي 9:16 -> حرق الترجمة
// ============================================================
async function renderClip(highlight, index) {
  const clipId = "clip_" + Date.now() + "_" + index;
  const inputName = "input" + getExt(currentFile.name);

  // يُكتب مرة واحدة فقط إن لم يكن موجودًا (ffmpeg.wasm يحتفظ بنظام ملفات وهمي)
  const written = await ffmpeg.listDir("/").catch(() => []);
  const alreadyWritten = written.some?.((f) => f.name === inputName);
  if (!alreadyWritten) {
    await ffmpeg.writeFile(inputName, await fetchFile(currentFile));
  }

  const duration = highlight.end - highlight.start;
  const cutName = `${clipId}_cut.mp4`;
  const verticalName = `${clipId}_vertical.mp4`;
  const finalName = `${clipId}_final.mp4`;
  const srtName = `${clipId}.srt`;

  // --- قص المقطع ---
  await ffmpeg.exec([
    "-ss", String(highlight.start), "-i", inputName, "-t", String(duration),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22",
    "-c:a", "aac", cutName,
  ]);

  // --- تحويل 16:9 إلى 9:16 (قص مركزي) ---
  await ffmpeg.exec([
    "-i", cutName,
    "-vf", "scale=-2:1920,crop=1080:1920",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "copy",
    verticalName,
  ]);

  // --- توليد ملف SRT من الترانسكربت الخاص بهذا المقطع ---
  const clipSegments = transcriptSegments.filter(
    (s) => s.start >= highlight.start - 0.3 && s.end <= highlight.end + 0.3
  );
  const srtContent = buildSRT(clipSegments, highlight.start);
  await ffmpeg.writeFile(srtName, srtContent);

  // --- حرق الترجمة على الفيديو ---
  let finalFile;
  try {
    await ffmpeg.exec([
      "-i", verticalName,
      "-vf", `subtitles=${srtName}:force_style='FontName=Arial,FontSize=14,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Alignment=2,MarginV=80'`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "22", "-c:a", "copy",
      finalName,
    ]);
    finalFile = finalName;
  } catch (e) {
    // بعض نسخ ffmpeg.wasm لا تدعم فلتر subtitles (يحتاج libass) — نكمل بدون حرق ترجمة
    console.warn("تعذر حرق الترجمة (libass غير مدعوم في هذا الإصدار) — سيتم تسليم المقطع بدون ترجمة محروقة.", e);
    finalFile = verticalName;
  }

  const data = await ffmpeg.readFile(finalFile);
  const blob = new Blob([data.buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);

  return {
    id: clipId,
    start: highlight.start,
    end: highlight.end,
    title: highlight.title || "مقطع بدون عنوان",
    score: highlight.virality_score || 0,
    blob, url,
    segments: clipSegments,
    transcriptText: clipSegments.map((s) => s.text).join(" "),
  };
}

function srtTime(t) {
  const h = String(Math.floor(t / 3600)).padStart(2, "0");
  const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(t % 60)).padStart(2, "0");
  const ms = String(Math.round((t % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s},${ms}`;
}

function buildSRT(segments, clipStartOffset) {
  let out = "";
  let idx = 1;
  for (const seg of segments) {
    const start = Math.max(0, seg.start - clipStartOffset);
    const end = Math.max(0, seg.end - clipStartOffset);
    out += `${idx}\n${srtTime(start)} --> ${srtTime(end)}\n${seg.text}\n\n`;
    idx++;
  }
  return out;
}

// ============================================================
// 8. لوحة عرض المقاطع (Dashboard)
// ============================================================
function renderClipsGrid() {
  emptyState.classList.toggle("hidden", clips.length > 0);
  clipsGrid.innerHTML = "";
  if (!clips.length) { clipsGrid.appendChild(emptyState); return; }

  for (const clip of clips) {
    const card = document.createElement("div");
    card.className = "clip-card";
    card.innerHTML = `
      <div class="clip-thumb-wrap">
        <video src="${clip.url}" muted></video>
        <span class="clip-score">★ ${clip.score.toFixed(1)}</span>
        <span class="clip-status-badge ready">جاهز</span>
      </div>
      <div class="clip-meta">
        <p class="clip-title-text">${escapeHTML(clip.title)}</p>
        <p class="clip-time">${formatTime(clip.start)} - ${formatTime(clip.end)}</p>
      </div>
    `;
    card.addEventListener("click", () => openEditor(clip.id));
    clipsGrid.appendChild(card);
  }
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
// 9. محرر المقطع: تعديل التوقيت / النص / إعادة المعالجة / التحميل
// ============================================================
function openEditor(clipId) {
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return;
  activeClipId = clipId;
  editorVideo.src = clip.url;
  editStart.value = clip.start.toFixed(1);
  editEnd.value = clip.end.toFixed(1);
  editTranscript.value = clip.transcriptText;
  editorStatus.textContent = "";
  editorModal.classList.remove("hidden");
}

modalClose.addEventListener("click", () => editorModal.classList.add("hidden"));
editorModal.addEventListener("click", (e) => { if (e.target === editorModal) editorModal.classList.add("hidden"); });

rerenderBtn.addEventListener("click", async () => {
  const clip = clips.find((c) => c.id === activeClipId);
  if (!clip) return;
  rerenderBtn.disabled = true;
  editorStatus.textContent = "جاري إعادة المعالجة...";
  try {
    const newHighlight = {
      start: parseFloat(editStart.value),
      end: parseFloat(editEnd.value),
      title: clip.title,
      virality_score: clip.score,
    };
    // تحديث نص أول segment يدويًا بما كتبه المستخدم (تبسيط: نص واحد مجمّع)
    if (clip.segments.length) {
      clip.segments[0] = { ...clip.segments[0], text: editTranscript.value };
      clip.segments = [clip.segments[0]];
    }
    const idx = clips.findIndex((c) => c.id === activeClipId);
    const rerendered = await renderClip(newHighlight, idx);
    rerendered.id = clip.id; // نحافظ على نفس المعرف
    clips[idx] = rerendered;
    renderClipsGrid();
    editorVideo.src = rerendered.url;
    editorStatus.textContent = "تم بنجاح ✓";
  } catch (err) {
    editorStatus.textContent = "خطأ: " + err.message;
  } finally {
    rerenderBtn.disabled = false;
  }
});

downloadClipBtn.addEventListener("click", () => {
  const clip = clips.find((c) => c.id === activeClipId);
  if (!clip) return;
  const a = document.createElement("a");
  a.href = clip.url;
  a.download = `${clip.title.replace(/[^a-z0-9أ-ي ]/gi, "_")}.mp4`;
  a.click();
});

setStatus("ok", "جاهز");
