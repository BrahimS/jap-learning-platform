// Jap-learning-platform frontend — vanilla JS SPA over /ai/* endpoints.

const $ = (s) => document.querySelector(s);
const LANGS = [
  { v: 'fr', l: 'Français' },
  { v: 'en', l: 'English' },
  { v: 'ar', l: 'العربية' },
];
const JLPT = ['N5', 'N4', 'N3', 'N2', 'N1'];

// ---------- helpers ----------
function fillSelects() {
  document.querySelectorAll('.lang-select').forEach((sel) => {
    sel.innerHTML = LANGS.map((l) => `<option value="${l.v}">${l.l}</option>`).join('');
  });
  $('#tutor-level').innerHTML = JLPT.map((l) => `<option>${l}</option>`).join('');
  $('#quiz-level').innerHTML = '<option value="">Tous niveaux</option>' + JLPT.map((l) => `<option>${l}</option>`).join('');
  $('#recommend-level').innerHTML = '<option value="">Niveau…</option>' + JLPT.map((l) => `<option>${l}</option>`).join('');
}

function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = kind;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 3500);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({ ok: false, error: { message: `HTTP ${res.status}` } }));
  if (!json.ok) throw new Error(json.error?.message ?? `HTTP ${res.status}`);
  return json;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function metaLine(meta) {
  return meta ? `<div class="muted" style="margin-top:8px">modèle: ${esc(meta.model)} · ${meta.latencyMs}ms</div>` : '';
}

function out(id, html) { $(id).innerHTML = html; }
function loading(id) { out(id, '<div class="loading">Génération en cours…</div>'); }
function errOut(id, e) { out(id, `<div class="error-box">${esc(e.message)}</div>`); }

function coverageTag(v) {
  if (!v) return '';
  const cls = v === 'covered' ? 'good' : v === 'partial' ? 'warn' : 'bad';
  const label = { covered: 'couvert', partial: 'partiel', not_covered: 'non couvert' }[v] ?? v;
  return `<span class="tag ${cls}">programme: ${label}</span>`;
}

// ---------- nav ----------
document.querySelectorAll('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    btn.classList.add('active');
    $(`#view-${btn.dataset.view}`).classList.add('active');
  });
});

// ---------- provider badge ----------
fetch('/api/status')
  .then((r) => r.json())
  .then((s) => {
    const b = $('#provider-badge');
    b.textContent = `provider: ${s.provider}`;
    b.classList.add(s.provider === 'mock' ? 'warn' : 'ok');
  })
  .catch(() => {});

// ---------- tutor ----------
const tutorHistory = [];
function addMsg(role, data) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  if (role === 'user') {
    div.textContent = data;
  } else {
    div.innerHTML =
      (data.replyJa ? `<div class="ja">${esc(data.replyJa)}</div>` : '') +
      (data.explanation ? `<div class="ex">${esc(data.explanation)}</div>` : '') +
      (data.corrections?.length
        ? data.corrections.map((c) => `<div class="corr">✎ ${esc(c.original)} → ${esc(c.corrected)} — ${esc(c.explanation)}</div>`).join('')
        : '') +
      (data.nextStep ? `<div class="next">→ ${esc(data.nextStep)}</div>` : '');
  }
  $('#chat').appendChild(div);
  $('#chat').scrollTop = $('#chat').scrollHeight;
}
$('#tutor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#tutor-input').value.trim();
  if (!text) return;
  $('#tutor-input').value = '';
  addMsg('user', text);
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const { result, meta } = await api('/ai/tutor', {
      language: $('#tutor-lang').value,
      learnerLevel: $('#tutor-level').value,
      text,
      history: tutorHistory.slice(-10),
    });
    tutorHistory.push({ role: 'user', content: text }, { role: 'assistant', content: result.replyJa });
    addMsg('bot', result);
    if (meta) toast(`${meta.latencyMs}ms`);
  } catch (err) { toast(err.message, 'err'); addMsg('bot', { replyJa: '', explanation: `⚠ ${err.message}` }); }
  btn.disabled = false;
});

// ---------- simple explainers ----------
function bindExplainer(formSel, outSel, path, buildBody, render) {
  $(formSel).addEventListener('submit', async (e) => {
    e.preventDefault();
    loading(outSel);
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    try {
      const { result, meta } = await api(path, buildBody());
      out(outSel, render(result, meta));
    } catch (err) { errOut(outSel, err); }
    btn.disabled = false;
  });
}

bindExplainer('#grammar-form', '#grammar-out', '/ai/grammar',
  () => ({ language: $('#grammar-lang').value, structure: $('#grammar-structure').value.trim() }),
  (g, meta) => `
    <div class="card">
      <h3>${esc(g.structure)} ${coverageTag(g.curriculumCoverage)} <span class="tag">${esc(g.jlptLevel ?? '—')}</span></h3>
      <div><strong>${esc(g.meaning)}</strong></div>
      <div class="muted">${esc(g.usage)}</div>
      ${g.comparison ? `<div class="muted">≈ ${esc(g.comparison.with)} — ${esc(g.comparison.difference)}</div>` : ''}
      <ul class="ex-list">${(g.examples ?? []).map((x) => `<li><span class="ja">${esc(x.ja)}</span> — ${esc(x.translation)}${x.reading ? ` <span class="reading">[${esc(x.reading)}]</span>` : ''}</li>`).join('')}</ul>
      ${(g.commonMistakes ?? []).length ? `<div class="muted">Erreurs fréquentes:</div><ul class="ex-list">${g.commonMistakes.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
      ${(g.exercises ?? []).length ? `<div class="muted">Exercices:</div><ul class="ex-list">${g.exercises.map((x) => `<li>${esc(x.prompt)} → <strong>${esc(x.answer)}</strong></li>`).join('')}</ul>` : ''}
      ${metaLine(meta)}
    </div>`);

bindExplainer('#vocab-form', '#vocab-out', '/ai/vocabulary',
  () => ({ language: $('#vocab-lang').value, word: $('#vocab-word').value.trim() }),
  (v, meta) => `
    <div class="card">
      <h3><span class="ja-big">${esc(v.word)}</span> <span class="muted">${esc(v.reading)}</span> ${coverageTag(v.curriculumCoverage)} <span class="tag">${esc(v.jlptLevel ?? '—')}</span></h3>
      <div><strong>${esc(v.meaning)}</strong></div>
      ${v.usage ? `<div class="muted">${esc(v.usage)}</div>` : ''}
      <ul class="ex-list">${(v.examples ?? []).map((x) => `<li><span class="ja">${esc(x.ja)}</span> — ${esc(x.translation)}</li>`).join('')}</ul>
      ${v.synonyms?.length ? `<div class="muted">Synonymes: ${v.synonyms.map(esc).join(', ')}</div>` : ''}
      ${v.antonyms?.length ? `<div class="muted">Antonymes: ${v.antonyms.map(esc).join(', ')}</div>` : ''}
      ${metaLine(meta)}
    </div>`);

// ---------- quiz ----------
let quizState = null;
$('#quiz-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  loading('#quiz-out');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const { result, meta } = await api('/ai/quiz', {
      language: $('#quiz-lang').value,
      type: $('#quiz-type').value,
      topic: $('#quiz-topic').value.trim() || undefined,
      jlptLevel: $('#quiz-level').value || undefined,
      count: Number($('#quiz-count').value) || 3,
    });
    quizState = { questions: result.questions, i: 0, score: 0, answers: {} };
    renderQuestion(meta);
  } catch (err) { errOut('#quiz-out', err); }
  btn.disabled = false;
});

function renderQuestion(meta) {
  const qs = quizState.questions;
  if (quizState.i >= qs.length) return renderQuizEnd();
  const q = qs[quizState.i];
  const hasOptions = Array.isArray(q.options) && q.options.length > 0;
  const input = hasOptions
    ? `<div>${q.options.map((o, i) => `<label class="q-opt" data-i="${i}"><input type="radio" name="q" value="${esc(o)}" style="display:none"> ${esc(o)}</label>`).join('')}</div>`
    : `<input type="text" id="q-text" placeholder="Votre réponse…" style="width:100%" />`;
  const passage = q.passage ? `<p class="ja">${esc(q.passage)}</p>` : '';
  out('#quiz-out', `
    <div class="q-card">
      <div class="muted">Question ${quizState.i + 1}/${qs.length} · ${esc(q.type)} ${q.jlptLevel ? `<span class="tag">${esc(q.jlptLevel)}</span>` : ''}</div>
      ${passage}<p style="font-size:17px">${esc(q.prompt)}</p>${input}
      <div style="margin-top:12px;display:flex;gap:10px">
        <button class="btn" id="q-check">Vérifier</button>
        <button class="btn" id="q-next" style="background:var(--panel2);border:1px solid var(--border)">Passer</button>
      </div>
      <div id="q-feedback"></div>
    </div>
    ${metaLine(meta)}`);
  document.querySelectorAll('.q-opt').forEach((el) =>
    el.addEventListener('click', () => {
      document.querySelectorAll('.q-opt').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      el.querySelector('input').checked = true;
    }),
  );
  $('#q-check').addEventListener('click', () => checkAnswer(q));
  $('#q-next').onclick = () => { quizState.i++; renderQuestion(); };
}

function checkAnswer(q) {
  const hasOptions = Array.isArray(q.options) && q.options.length > 0;
  const given = hasOptions
    ? document.querySelector('input[name="q"]:checked')?.value
    : $('#q-text')?.value.trim();
  if (!given) return toast('Répondez d’abord', 'err');
  const ok = given.trim().toLowerCase() === String(q.answer).trim().toLowerCase();
  if (ok) quizState.score++;
  document.querySelectorAll('.q-opt').forEach((el) => {
    if (el.querySelector('input').value === q.answer) el.classList.add('correct');
    else if (el.classList.contains('sel')) el.classList.add('wrong');
  });
  $('#q-feedback').innerHTML = `
    <div class="${ok ? 'tag good' : 'tag bad'}" style="margin-top:10px">${ok ? '✓ Correct' : '✗ Incorrect'}</div>
    <div class="card" style="margin-top:8px"><strong>Réponse:</strong> ${esc(q.answer)}<br/><span class="muted">${esc(q.explanation)}</span></div>`;
  $('#q-check').disabled = true;
  $('#q-next').textContent = quizState.i + 1 >= quizState.questions.length ? 'Voir le score' : 'Suivant →';
}

function renderQuizEnd() {
  const { score, questions } = quizState;
  out('#quiz-out', `
    <div class="card"><div class="q-score">Score: ${score}/${questions.length}</div>
    <button class="btn" id="quiz-again">Nouveau quiz</button></div>`);
  $('#quiz-again').addEventListener('click', () => { quizState = null; $('#quiz-form').requestSubmit(); });
}

// ---------- writing ----------
bindExplainer('#writing-form', '#writing-out', '/ai/writing',
  () => ({
    language: $('#writing-lang').value,
    sentence: $('#writing-sentence').value.trim(),
    criteria: $('#writing-criteria').value.trim() || undefined,
  }),
  (w, meta) => `
    <div class="card">
      <h3>Correction ${w.score !== undefined ? `<span class="tag ${w.score >= 80 ? 'good' : w.score >= 50 ? 'warn' : 'bad'}">${w.score}/100</span>` : ''}</h3>
      <div class="ja">${esc(w.original)}</div>
      <div class="ja-big" style="margin:8px 0">→ ${esc(w.improved)}</div>
      ${(w.corrections ?? []).map((c) => `<div class="corr" style="color:var(--warn)">✎ [${esc(c.category)}] ${esc(c.issue)} — ${esc(c.explanation)} ⇒ ${esc(c.suggestion)}</div>`).join('')}
      ${(w.alternatives ?? []).length ? `<div class="muted">Alternatives: ${w.alternatives.map((a) => `<span class="ja">${esc(a)}</span>`).join(' · ')}</div>` : ''}
      ${metaLine(meta)}
    </div>`);

// ---------- translate ----------
bindExplainer('#translate-form', '#translate-out', '/ai/translate',
  () => ({
    text: $('#translate-text').value.trim(),
    sourceLang: $('#translate-from').value,
    targetLang: $('#translate-to').value,
  }),
  (t, meta) => `
    <div class="card">
      <div class="ja-big">${esc(t.translation)}</div>
      ${t.backTranslation ? `<div class="muted">↩ ${esc(t.backTranslation)}</div>` : ''}
      ${t.notes ? `<div class="muted">${esc(t.notes)}</div>` : ''}
      ${metaLine(meta)}
    </div>`);

// ---------- ask (RAG) ----------
bindExplainer('#ask-form', '#ask-out', '/ai/ask',
  () => ({ language: $('#ask-lang').value, question: $('#ask-question').value.trim() }),
  (a, meta) => `
    <div class="card">
      <div>${coverageTag(a.curriculumCoverage)}</div>
      <p style="white-space:pre-wrap">${esc(a.answer)}</p>
      ${a.followUp ? `<div class="muted">→ ${esc(a.followUp)}</div>` : ''}
      ${metaLine(meta)}
    </div>`);

// ---------- speak (TTS) ----------
$('#speak-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = $('#speak-text').value.trim();
  if (!text) return;
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  out('#speak-out', '<div class="loading">Synthèse en cours…</div>');
  try {
    const { result } = await api('/ai/synthesize', { text });
    const bytes = Uint8Array.from(atob(result.audioBase64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mimeType }));
    const audio = $('#speak-audio');
    audio.src = url;
    audio.hidden = false;
    audio.play().catch(() => {});
    out('#speak-out', `<div class="card"><span class="muted">Lecture: « ${esc(text)} » (${result.mimeType})</span></div>`);
  } catch (err) { errOut('#speak-out', err); }
  btn.disabled = false;
});

// ---------- recommend ----------
let catalog = null;
fetch('/catalog.json').then((r) => r.json()).then((c) => (catalog = c.items ?? [])).catch(() => {});
$('#recommend-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  loading('#recommend-out');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    if (!catalog) {
      const c = await fetch('/catalog.json').then((r) => r.json());
      catalog = c.items ?? [];
    }
    if (!catalog.length) throw new Error('Catalogue vide — /catalog.json introuvable');
    const weak = $('#recommend-weak').value.trim();
    const { result, meta } = await api('/ai/recommend', {
      language: 'fr',
      learnerLevel: $('#recommend-level').value || 'N5',
      stats: { weakAreas: weak ? [weak] : [] },
      catalog,
    });
    out('#recommend-out', `
      <div class="card">
        <h3>Axes faibles</h3>
        <div>${(result.weakAreas ?? []).map((w) => `<span class="tag warn">${esc(w)}</span>`).join(' ') || '<span class="muted">—</span>'}</div>
        <h3 style="margin-top:14px">Recommandations</h3>
        ${(result.recommendations ?? []).map((r) => `
          <div class="rec-item">
            <span class="tag">${esc(r.kind)}</span> <span class="tag">${esc(r.priority)}</span>
            <code>${esc(r.itemId)}</code>
            <div class="reason">${esc(r.reason)}</div>
          </div>`).join('') || '<div class="muted">Aucune recommandation valide.</div>'}
        <h3 style="margin-top:14px">Plan</h3>
        <div>${esc(result.studyPlan?.focus ?? '')}</div>
        <ul class="ex-list">${(result.studyPlan?.adjustments ?? []).map((a) => `<li>${esc(a)}</li>`).join('')}</ul>
        ${metaLine(meta)}
      </div>`);
  } catch (err) { errOut('#recommend-out', err); }
  btn.disabled = false;
});

fillSelects();
addMsg('bot', { replyJa: 'こんにちは！私はあなたの日本語チューターです。何から始めましょうか？', explanation: 'Posez une question, pratiquez une phrase, ou demandez une correction.', nextStep: 'Essayez: « 私は学生です »' });
