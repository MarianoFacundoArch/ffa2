const socket = io();
const sessionsContainer = document.getElementById('sessions');
const template = document.getElementById('session-card-template');
const form = document.getElementById('session-form');
const queueUrlInput = document.getElementById('queue-url');
const labelInput = document.getElementById('session-label');
const countInput = document.getElementById('session-count');
const sourceInput = document.getElementById('source-url');
const globalToggleButton = document.getElementById('global-auto-toggle');

const sessionElements = new Map();
const sessionStates = new Map();
let globalAutoReloadEnabled = true;
const EMPTY_CAPTCHA_IMAGE = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90" viewBox="0 0 160 90"><rect width="160" height="90" rx="12" ry="12" fill="rgba(148,163,184,0.12)" stroke="rgba(148,163,184,0.35)" stroke-width="2" stroke-dasharray="6 6"/><text x="50%" y="50%" fill="rgba(148,163,184,0.6)" font-size="12" text-anchor="middle" alignment-baseline="middle">Captcha hidden</text></svg>';

const STATUS_BADGES = {
  idle: 'Idle',
  launching: 'Launching',
  running: 'In queue',
  waiting: 'Waiting open',
  captcha: 'Captcha',
  ready: 'Ready',
  error: 'Error',
  warning: 'Warning',
  stopped: 'Stopped',
};

function formatTime(ts) {
  if (!ts) return '—';
  const date = new Date(ts);
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`;
}

function createCard(state) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.sessionId = state.id;
  node.querySelector('.session-label').textContent = state.label;
  const badgeEl = node.querySelector('.badge');
  badgeEl.textContent = STATUS_BADGES[state.status] || state.status;
  badgeEl.className = `badge ${state.status || 'idle'}`;
  node.querySelector('.status-message').textContent = state.message || '—';
  node.querySelector('.countdown').textContent = state.countdownText || '—';
  node.querySelector('.queue-position').textContent = state.queuePosition || '—';
  node.querySelector('.info-banner').textContent = state.infoBanner || '—';
  node.querySelector('.last-updated').textContent = formatTime(state.lastUpdated);
  updateScreenshot(node, state);
  updateCaptcha(node, state);
  node.classList.add(`status-${state.status}`);

  sessionElements.set(state.id, node);
  sessionStates.set(state.id, state);
  updateAutoButton(node, state);
  node.classList.toggle('auto-paused', !state.autoReloadEnabled || !state.globalAutoReloadEnabled);

  node.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', (event) => handleAction(btn.dataset.action, state.id, event));
  });

  sessionsContainer.appendChild(node);
}

function updateScreenshot(card, state) {
  const img = card.querySelector('.screenshot');
  if (state.screenshotPath) {
    const url = `/api/sessions/${state.id}/screenshot?ts=${Date.now()}`;
    img.src = url;
  } else {
    img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="160" height="200"></svg>';
  }
}

function updateCard(state) {
  let card = sessionElements.get(state.id);
  if (!card) {
    createCard(state);
    card = sessionElements.get(state.id);
    if (!card) return;
  }
  card.querySelector('.session-label').textContent = state.label;
  const badgeEl = card.querySelector('.badge');
  badgeEl.textContent = STATUS_BADGES[state.status] || state.status;
  badgeEl.className = `badge ${state.status}`;
  card.querySelector('.status-message').textContent = state.message || '—';
  card.querySelector('.countdown').textContent = state.countdownText || '—';
  card.querySelector('.queue-position').textContent = state.queuePosition || '—';
  card.querySelector('.info-banner').textContent = state.infoBanner || '—';
  card.querySelector('.last-updated').textContent = formatTime(state.lastUpdated);
  card.className = `session-card status-${state.status}`;
  card.classList.toggle('auto-paused', !state.autoReloadEnabled || !state.globalAutoReloadEnabled);
  updateScreenshot(card, state);
  updateCaptcha(card, state);
  sessionStates.set(state.id, state);
  updateAutoButton(card, state);
}

async function handleAction(action, id, event) {
  let endpoint;
  const options = { method: 'POST' };
  const card = sessionElements.get(id);
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  switch (action) {
    case 'bring':
      endpoint = `/api/sessions/${id}/bring-to-front`;
      break;
    case 'reload':
      endpoint = `/api/sessions/${id}/reload`;
      break;
    case 'refresh-screenshot':
      endpoint = `/api/sessions/${id}/screenshot`;
      break;
    case 'toggle-auto': {
      endpoint = `/api/sessions/${id}/auto-reload`;
      const current = sessionStates.get(id);
      const nextEnabled = current ? !current.autoReloadEnabled : false;
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ enabled: nextEnabled });
      break;
    }
    case 'submit-captcha': {
      if (!card) return;
      const input = card.querySelector('.captcha-answer');
      const answer = input ? input.value.trim() : '';
      if (!answer) {
        alert('Enter the captcha answer first');
        return;
      }
      endpoint = `/api/sessions/${id}/captcha`;
      options.headers = { 'Content-Type': 'application/json' };
      options.body = JSON.stringify({ answer });
      break;
    }
    case 'refresh-captcha':
      endpoint = `/api/sessions/${id}/captcha/refresh`;
      break;
    default:
      return;
  }
  try {
    const res = await fetch(endpoint, options);
    if (!res.ok) {
      let message = await res.text();
      try {
        const parsed = JSON.parse(message);
        message = parsed.error || parsed.message || message;
      } catch (error) {
        // response was not JSON, keep original text
      }
      throw new Error(message || 'Request failed');
    }
    if (action === 'submit-captcha' && card) {
      const input = card.querySelector('.captcha-answer');
      if (input) {
        input.value = '';
      }
    }
    if (action === 'refresh-captcha' && card) {
      const panel = card.querySelector('.captcha-panel');
      if (panel) {
        panel.dataset.lastCaptchaTs = '';
      }
    }
  } catch (error) {
    console.error(`Action ${action} failed`, error);
    alert(`Action failed: ${error.message}`);
  }
}

if (form) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const queueUrl = queueUrlInput.value.trim();
    if (!queueUrl) {
      alert('Queue URL is required');
      return;
    }
    const payload = {
      queueUrl,
      label: labelInput.value.trim() || undefined,
      sourceUrl: sourceInput.value.trim() || undefined,
      count: Number(countInput.value) || 1,
    };
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to create session');
      }
      labelInput.value = '';
      countInput.value = '1';
      if (!sourceInput.dataset.preserve) {
        sourceInput.value = '';
      }
    } catch (error) {
      console.error('Failed to create sessions', error);
      alert(`Failed to create sessions: ${error.message}`);
    }
  });
}

socket.on('sessions:init', (sessions) => {
  sessionsContainer.innerHTML = '';
  sessionElements.clear();
  sessionStates.clear();
  sessions.forEach(({ id, label, state }) => {
    createCard({ id, label, ...state });
  });
});

socket.on('sessions:update', (state) => {
  updateCard(state);
});

socket.on('settings:init', (settings) => {
  globalAutoReloadEnabled = settings?.autoReloadEnabled !== false;
  updateGlobalButton();
});

socket.on('settings:update', (settings) => {
  globalAutoReloadEnabled = settings?.autoReloadEnabled !== false;
  updateGlobalButton();
  sessionStates.forEach((currentState, sessionId) => {
    const updatedState = { ...currentState, globalAutoReloadEnabled: globalAutoReloadEnabled };
    sessionStates.set(sessionId, updatedState);
    const card = sessionElements.get(sessionId);
    if (card) {
      card.classList.toggle('auto-paused', !updatedState.autoReloadEnabled || !updatedState.globalAutoReloadEnabled);
      updateAutoButton(card, updatedState);
    }
  });
});

if (globalToggleButton) {
  updateGlobalButton();
  globalToggleButton.addEventListener('click', async () => {
    const nextEnabled = !globalAutoReloadEnabled;
    try {
      const res = await fetch('/api/auto-reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: nextEnabled }),
      });
      if (!res.ok) {
        throw new Error(await res.text());
      }
    } catch (error) {
      console.error('Failed to toggle global auto reload', error);
      alert(`Failed to toggle auto reload: ${error.message}`);
    }
  });
}

function updateAutoButton(card, state) {
  const autoBtn = card.querySelector('button[data-action="toggle-auto"]');
  if (!autoBtn) return;
  const sessionEnabled = !!state.autoReloadEnabled;
  const effectiveEnabled = sessionEnabled && state.globalAutoReloadEnabled;
  let label = sessionEnabled ? 'Pause auto reload' : 'Resume auto reload';
  if (!state.globalAutoReloadEnabled) {
    label = 'Resume auto reload';
  }
  autoBtn.textContent = label;
  autoBtn.classList.toggle('off', !effectiveEnabled);
  autoBtn.title = state.globalAutoReloadEnabled ? '' : 'Global auto reload is disabled';
}

function updateGlobalButton() {
  if (!globalToggleButton) return;
  globalToggleButton.textContent = globalAutoReloadEnabled
    ? 'Stop auto reload (all)'
    : 'Resume auto reload (all)';
  globalToggleButton.classList.toggle('off', !globalAutoReloadEnabled);
}

function updateCaptcha(card, state) {
  const panel = card.querySelector('.captcha-panel');
  if (!panel) return;
  const shouldShow = state.status === 'captcha' || state.captchaRequired;
  panel.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) {
    panel.dataset.lastCaptchaTs = '';
    const img = panel.querySelector('.captcha-image');
    if (img) {
      img.src = EMPTY_CAPTCHA_IMAGE;
    }
    const meta = panel.querySelector('.captcha-meta');
    if (meta) {
      meta.textContent = 'Waiting for captcha…';
    }
    const input = panel.querySelector('.captcha-answer');
    if (input) {
      input.value = '';
    }
    return;
  }
  const img = panel.querySelector('.captcha-image');
  if (img) {
    img.src = state.captchaImage || EMPTY_CAPTCHA_IMAGE;
  }
  if (state.captchaUpdatedAt) {
    const lastRendered = panel.dataset.lastCaptchaTs;
    if (String(state.captchaUpdatedAt) !== lastRendered) {
      panel.dataset.lastCaptchaTs = String(state.captchaUpdatedAt);
      const input = panel.querySelector('.captcha-answer');
      if (input) {
        input.value = '';
      }
    }
  }
  const meta = panel.querySelector('.captcha-meta');
  if (meta) {
    const parts = [];
    if (state.captchaUpdatedAt) {
      parts.push(`Image ${formatTime(state.captchaUpdatedAt)}`);
    }
    if (state.lastCaptchaSubmission) {
      parts.push(`Submitted ${formatTime(state.lastCaptchaSubmission)}`);
    }
    meta.textContent = parts.length ? parts.join(' · ') : 'Captcha active';
  }
}
