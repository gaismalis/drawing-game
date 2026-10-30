const $ = (id) => document.getElementById(id);
const SESSION_KEY = 'drawing-game-session';
const NAME_KEY = 'drawing-game-name';

const socket = io({ reconnectionDelayMax: 3000 });

let session = loadSession();
let state = null;
let roleVisible = false;
let shownRoundNumber = null;
let impostorCount = 1;

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  else localStorage.removeItem(SESSION_KEY);
}

function show(screen) {
  $('screen-home').classList.toggle('hidden', screen !== 'home');
  $('screen-room').classList.toggle('hidden', screen !== 'room');
}

function goHome(message = '') {
  saveSession(null);
  state = null;
  $('home-error').textContent = message;
  show('home');
}

// ---------- Connection ----------

socket.on('connect', () => {
  $('connection').classList.add('hidden');
  if (session) {
    socket.emit('resume', session, (res) => {
      if (res.error) goHome('Iepriekšējā spēle vairs nav pieejama');
    });
  } else {
    show('home');
  }
});

socket.on('disconnect', () => {
  if (session) $('connection').classList.remove('hidden');
});

// Phones often kill the socket while the screen is locked — reconnect right away on return.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !socket.connected) socket.connect();
});

socket.on('state', (s) => {
  state = s;
  show('room');
  render();
});

socket.on('kicked', () => goHome('Admins tevi izmeta no istabas'));
socket.on('replaced', () => {
  $('connection').textContent = 'Spēle atvērta citā cilnē';
  $('connection').classList.remove('hidden');
});

// ---------- Home ----------

$('name').value = localStorage.getItem(NAME_KEY) || '';
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('code').value = urlCode;

function enterRoom(event, payload) {
  const name = $('name').value.trim();
  if (!name) {
    $('home-error').textContent = 'Ievadi savu vārdu';
    return;
  }
  localStorage.setItem(NAME_KEY, name);
  socket.emit(event, { ...payload, name }, (res) => {
    if (res.error) {
      $('home-error').textContent = res.error;
      return;
    }
    $('home-error').textContent = '';
    saveSession({ code: res.code, playerId: res.playerId, token: res.token });
  });
}

$('btn-create').onclick = () => enterRoom('create', {});
$('btn-join').onclick = () => {
  const code = $('code').value.trim();
  if (!/^\d{4}$/.test(code)) {
    $('home-error').textContent = 'Kodam jābūt 4 cipariem';
    return;
  }
  enterRoom('join', { code });
};
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && $('btn-join').click());

// ---------- Room ----------

$('role-card').onclick = () => {
  roleVisible = !roleVisible;
  render();
};

$('imp-minus').onclick = () => { impostorCount--; render(); };
$('imp-plus').onclick = () => { impostorCount++; render(); };

$('btn-start').onclick = () => {
  const isNew = !state.round || state.round.revealed;
  if (!isNew && !confirm('Raunds vēl nav atklāts. Sākt jaunu raundu?')) return;
  socket.emit('startRound', { impostors: impostorCount }, (res) => {
    $('room-error').textContent = res.error || '';
  });
};

$('btn-reveal').onclick = () => {
  if (confirm('Atklāt vārdu un viltniekus visiem?')) socket.emit('reveal');
};

$('btn-leave').onclick = () => {
  if (!confirm('Tiešām pamest istabu?')) return;
  socket.emit('leave');
  goHome();
};

function maxImpostors() {
  return Math.max(1, state.players.length - 2);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function render() {
  if (!state) return;
  const { me, players, round } = state;

  $('room-code').textContent = state.code;
  $('player-count').textContent = `(${players.length})`;
  $('words-used').textContent = `Izspēlēti vārdi: ${state.wordsUsed} / ${state.wordsTotal}`;

  // Round
  $('round').classList.toggle('hidden', !round);
  $('waiting').classList.toggle('hidden', !!round);
  if (round) {
    if (shownRoundNumber !== round.number) {
      shownRoundNumber = round.number;
      roleVisible = false; // new round — hide role until tapped
    }
    $('round-title').textContent = `${round.number}. raunds`;

    const card = $('role-card');
    card.className = 'role-card';
    if (!round.participating) {
      card.disabled = true;
      $('role-hidden').classList.add('hidden');
      $('role-shown').classList.remove('hidden');
      $('role-shown').textContent = 'Tu pievienojies raunda laikā — gaidi nākamo raundu';
    } else {
      card.disabled = false;
      $('role-hidden').classList.toggle('hidden', roleVisible);
      $('role-shown').classList.toggle('hidden', !roleVisible);
      if (roleVisible) {
        card.classList.add(round.role);
        $('role-shown').innerHTML =
          round.role === 'impostor'
            ? 'Tu esi<span class="big">🕵️ VILTNIEKS</span>'
            : `Zīmējamais vārds<span class="big">${escapeHtml(round.word)}</span>`;
      }
    }

    const impText = round.impostorCount === 1 ? '1 viltnieks' : `${round.impostorCount} viltnieki`;
    $('round-info').textContent = `Sāk: ${round.firstPlayerName || '—'} · Šajā raundā ${impText}`;

    $('reveal').classList.toggle('hidden', !round.revealed);
    if (round.revealed) {
      $('reveal').innerHTML =
        `Vārds bija: <strong>${escapeHtml(round.word)}</strong><br>` +
        `Viltnieki: <strong>${round.impostorNames.map(escapeHtml).join(', ')}</strong>`;
    }
  }

  // Admin controls
  $('admin-controls').classList.toggle('hidden', !me.isAdmin);
  if (me.isAdmin) {
    impostorCount = Math.min(Math.max(1, impostorCount), maxImpostors());
    $('imp-count').textContent = impostorCount;
    $('btn-start').textContent = round ? 'Jauns raunds' : 'Sākt raundu';
    $('btn-reveal').classList.toggle('hidden', !round || round.revealed);
  }

  // Players
  const list = $('players');
  list.innerHTML = '';
  for (const p of players) {
    const li = document.createElement('li');
    if (!p.online) li.classList.add('offline');
    li.innerHTML =
      `<span class="dot"></span><span class="name">${escapeHtml(p.name)}` +
      `${p.id === me.id ? ' (tu)' : ''}${p.isAdmin ? ' 👑' : ''}</span>`;
    if (me.isAdmin && p.id !== me.id) {
      const promote = document.createElement('button');
      promote.textContent = '👑';
      promote.title = 'Padarīt par adminu';
      promote.onclick = () => {
        if (confirm(`Padarīt ${p.name} par adminu?`)) socket.emit('makeAdmin', { playerId: p.id });
      };
      const kick = document.createElement('button');
      kick.className = 'kick';
      kick.textContent = 'Izmest';
      kick.onclick = () => {
        if (confirm(`Izmest ${p.name}?`)) socket.emit('kick', { playerId: p.id });
      };
      li.append(promote, kick);
    }
    list.appendChild(li);
  }
}

if (!session) show('home');
