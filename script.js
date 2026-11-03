/* =====================================================================
   MindMetric – frontend logic (vanilla JS)
   Talks to the existing FastAPI backend:
     POST {API_BASE_URL}/predict   ->  { "predicted_mental_health_score": <number> }
   ===================================================================== */
'use strict';

/* ---------- Configuration ---------- */
const CONFIG = {
  API_BASE_URL: 'http://127.0.0.1:8000', // must match the port uvicorn is running on
  PREDICT_PATH: '/predict',
  REQUEST_TIMEOUT_MS: 30000,
  // The backend does not report the score's range. This only controls how full the
  // ring looks and the "out of N" label. Set it to your target's real maximum.
  SCORE_SCALE_MAX: 10,
};

/* ---------- Field definitions (mirror the Pydantic StudentData model) ----------
   type: 'int' | 'float' | 'text' | 'choice'   */
const FIELDS = {
  Age:                     { label: 'Age',                    type: 'int',   min: 10, max: 100 },
  Gender:                  { label: 'Gender',                 type: 'choice', options: ['Male', 'Female'] },
  Country:                 { label: 'Country',                type: 'text',  maxLength: 60 },
  Academic_Level:          { label: 'Academic level',         type: 'choice', options: ['Undergraduate', 'Graduate', 'High School'] },
  Most_Used_Platform:      { label: 'Most used platform',     type: 'choice', options: ['Instagram', 'TikTok', 'Facebook', 'LinkedIn', 'YouTube', 'Twitter', 'Snapchat', 'WhatsApp', 'LINE', 'VKontakte', 'KakaoTalk', 'WeChat'] },
  Purpose_Of_Use:          { label: 'Purpose of use',         type: 'choice', options: ['networking', 'Education', 'Entertainment', 'News'] },
  Avg_Daily_Usage_Hours:   { label: 'Average daily usage',    type: 'float', min: 0, max: 24 },
  Daily_Unlocks:           { label: 'Phone unlocks per day',  type: 'int',   min: 0 },
  Study_Hours:             { label: 'Study hours',            type: 'float', min: 0, max: 24 },
  Physical_Activity_Hours: { label: 'Physical activity hours', type: 'float', min: 0, max: 24 },
  Sleep_Hours_Per_Night:   { label: 'Sleep hours',            type: 'float', min: 0, max: 24 },
  Stress_Level:            { label: 'Stress level',           type: 'choice', options: ['Low', 'Medium', 'High', 'Very High'] },
};

/* ---------- DOM references ---------- */
const $ = (id) => document.getElementById(id);
const form = $('predictForm');
const submitBtn = $('submitBtn');
const panels = {
  idle: $('stateIdle'),
  loading: $('stateLoading'),
  result: $('stateResult'),
  error: $('stateError'),
};
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- UI helpers ---------- */

/** Show exactly one panel state: idle | loading | result | error */
function showState(name) {
  Object.entries(panels).forEach(([key, el]) => { el.hidden = key !== name; });
}

/** Small notification in the corner of the screen. */
function toast(message, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast${type === 'error' ? ' toast--error' : ''}`;
  el.textContent = message;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function setFieldError(name, message) {
  const wrapper = form.elements[name].closest('.field');
  $(`err-${name}`).textContent = message || '';
  wrapper.classList.toggle('invalid', Boolean(message));
  form.elements[name].setAttribute('aria-invalid', message ? 'true' : 'false');
}

function clearAllErrors() {
  Object.keys(FIELDS).forEach((name) => setFieldError(name, ''));
}

function setLoading(isLoading) {
  submitBtn.disabled = isLoading;
  submitBtn.classList.toggle('is-loading', isLoading);
  submitBtn.querySelector('.btn__label').textContent = isLoading ? 'Analyzing…' : 'Estimate score';
}

/* ---------- Validation and payload ---------- */

/** Returns { value, error } for one field, converting to the type the backend expects. */
function readField(name) {
  const rule = FIELDS[name];
  const raw = String(form.elements[name].value).trim();
  const label = rule.label;

  if (raw === '') {
    return { error: rule.type === 'choice' ? `Select an option for ${label.toLowerCase()}.` : `${label} is required.` };
  }

  if (rule.type === 'choice') {
    return rule.options.includes(raw) ? { value: raw } : { error: `Choose one of the listed options.` };
  }

  if (rule.type === 'text') {
    return raw.length <= rule.maxLength ? { value: raw } : { error: `${label} must be ${rule.maxLength} characters or fewer.` };
  }

  const num = Number(raw);
  if (!Number.isFinite(num)) return { error: `${label} must be a number.` };
  if (rule.type === 'int' && !Number.isInteger(num)) return { error: `${label} must be a whole number.` };
  if (rule.min !== undefined && num < rule.min) return { error: `${label} must be at least ${rule.min}.` };
  if (rule.max !== undefined && num > rule.max) return { error: `${label} must be at most ${rule.max}.` };
  return { value: num };
}

/** Validates the entire form. Returns the payload, or null if anything is invalid. */
function buildPayload() {
  const payload = {};
  let firstInvalid = null;

  Object.keys(FIELDS).forEach((name) => {
    const { value, error } = readField(name);
    setFieldError(name, error);
    if (error && !firstInvalid) firstInvalid = name;
    if (!error) payload[name] = value;
  });

  if (firstInvalid) {
    form.elements[firstInvalid].focus();
    return null;
  }
  return payload;
}

/** Non-blocking hint when daily activities cannot realistically fit in a day. */
function updateTimeWarning() {
  const total = ['Study_Hours', 'Physical_Activity_Hours', 'Sleep_Hours_Per_Night']
    .reduce((sum, name) => sum + (parseFloat(form.elements[name].value) || 0), 0);
  $('timeWarning').hidden = total <= 24;
}

/* ---------- Error translation ---------- */

/** Turn one FastAPI/Pydantic validation item into a readable sentence. */
function describeValidationItem(item) {
  const ctx = item.ctx || {};
  switch (item.type) {
    case 'missing': return 'This field is required.';
    case 'greater_than_equal': return `Must be at least ${ctx.ge}.`;
    case 'less_than_equal': return `Must be at most ${ctx.le}.`;
    case 'int_parsing':
    case 'int_from_float': return 'Must be a whole number.';
    case 'float_parsing': return 'Must be a number.';
    case 'literal_error': return 'Choose one of the listed options.';
    default: return item.msg || 'Invalid value.';
  }
}

/** Map a 422 response onto the form fields. Returns a summary message. */
function applyValidationErrors(detail) {
  if (!Array.isArray(detail)) return 'The server rejected some of the values. Please check your answers.';
  const unmatched = [];
  detail.forEach((item) => {
    const fieldName = Array.isArray(item.loc) ? item.loc[item.loc.length - 1] : null;
    if (fieldName && FIELDS[fieldName]) setFieldError(fieldName, describeValidationItem(item));
    else unmatched.push(item.msg);
  });
  const firstBad = detail.map((d) => d.loc && d.loc[d.loc.length - 1]).find((n) => FIELDS[n]);
  if (firstBad) form.elements[firstBad].focus();
  return unmatched.length
    ? `The server rejected the request: ${unmatched.join('; ')}`
    : 'The server rejected some values. The fields to fix are marked in the form.';
}

/** Show the error panel and a toast. */
function showError(title, message) {
  $('errorTitle').textContent = title;
  $('errorMessage').textContent = message;
  showState('error');
  toast(title, 'error');
}

/* ---------- API calls ---------- */

async function requestPrediction(payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.REQUEST_TIMEOUT_MS);
  try {
    return await fetch(CONFIG.API_BASE_URL + CONFIG.PREDICT_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function handleSubmit(event) {
  event.preventDefault();
  clearAllErrors();

  const payload = buildPayload();
  if (!payload) {
    toast('Please fix the highlighted fields.', 'error');
    return;
  }

  setLoading(true);
  showState('loading');
  panels.loading.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const response = await requestPrediction(payload);

    if (response.status === 422) {
      const body = await response.json().catch(() => ({}));
      showError('Some values need attention', applyValidationErrors(body.detail));
      return;
    }
    if (response.status >= 500) {
      showError('The server had a problem', 'The prediction service hit an internal error. Check the uvicorn terminal for details, then try again.');
      return;
    }
    if (!response.ok) {
      showError('Request not accepted', `The server answered with status ${response.status}. Please try again.`);
      return;
    }

    const data = await response.json().catch(() => null);
    const score = data ? data.predicted_mental_health_score : undefined;
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      showError('Unexpected response', 'The server replied, but the result was not in the expected format.');
      return;
    }

    showResult(score);
    toast('Estimate ready.');
  } catch (err) {
    if (err.name === 'AbortError') {
      showError('The request timed out', 'The server took too long to respond. Please try again.');
    } else {
      // fetch() rejects with a TypeError when the server is unreachable or the browser blocks the request
      showError('Cannot reach the server', `Make sure the backend is running at ${CONFIG.API_BASE_URL} (uvicorn main:app --port 8000), then try again.`);
      setApiStatus('offline');
    }
  } finally {
    setLoading(false);
  }
}

/* ---------- Result display ---------- */

function formatScore(score) {
  return Number.isInteger(score) ? String(score) : score.toFixed(1);
}

function showResult(score) {
  const circumference = 2 * Math.PI * 52;
  const fraction = Math.min(Math.max(score / CONFIG.SCORE_SCALE_MAX, 0), 1);
  const fill = $('gaugeFill');
  const valueEl = $('scoreValue');

  $('scoreScale').textContent = `out of ${CONFIG.SCORE_SCALE_MAX}`;
  fill.style.strokeDasharray = circumference;
  fill.style.strokeDashoffset = circumference; // start empty
  valueEl.textContent = prefersReducedMotion ? formatScore(score) : '0';
  showState('result');
  panels.result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Animate the ring after the panel is visible, and count the number up.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.strokeDashoffset = circumference * (1 - fraction);
  }));
  if (!prefersReducedMotion) {
    const start = performance.now();
    const duration = 900;
    const tick = (now) => {
      const t = Math.min((now - start) / duration, 1);
      valueEl.textContent = formatScore(Number((score * t).toFixed(1)));
      if (t < 1) requestAnimationFrame(tick); else valueEl.textContent = formatScore(score);
    };
    requestAnimationFrame(tick);
  }
}

/* ---------- Reset ---------- */

function resetForm() {
  form.reset();
  clearAllErrors();
  updateTimeWarning();
  showState('idle');
  form.elements.Age.focus();
}

/* ---------- Backend connection indicator (GET /) ---------- */

function setApiStatus(state) {
  const labels = { online: 'Server connected', offline: 'Server offline', checking: 'Checking server…' };
  $('apiStatus').dataset.state = state;
  $('apiStatusText').textContent = labels[state];
}

async function checkApi() {
  setApiStatus('checking');
  try {
    const res = await fetch(CONFIG.API_BASE_URL + '/', { method: 'GET' });
    setApiStatus(res.ok ? 'online' : 'offline');
  } catch {
    setApiStatus('offline');
  }
}

/* ---------- Event wiring ---------- */

form.addEventListener('submit', handleSubmit);
$('clearBtn').addEventListener('click', resetForm);
$('newPredictionBtn').addEventListener('click', () => {
  resetForm();
  $('predict').scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('dismissErrorBtn').addEventListener('click', () => showState('idle'));
$('apiStatus').addEventListener('click', checkApi);

// Re-validate a field as soon as the user leaves it, and clear its error while typing.
Object.keys(FIELDS).forEach((name) => {
  const el = form.elements[name];
  el.addEventListener('blur', () => {
    if (el.value !== '') setFieldError(name, readField(name).error);
  });
  el.addEventListener('input', () => {
    if ($(`err-${name}`).textContent) setFieldError(name, '');
    updateTimeWarning();
  });
});

// Responsive navigation
const navToggle = $('navToggle');
const mainNav = $('mainNav');
navToggle.addEventListener('click', () => {
  const open = mainNav.classList.toggle('is-open');
  navToggle.setAttribute('aria-expanded', String(open));
});
mainNav.addEventListener('click', (e) => {
  if (e.target.tagName === 'A') {
    mainNav.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
  }
});

checkApi();
