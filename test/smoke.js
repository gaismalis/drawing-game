// End-to-end smoke test: starts the server and simulates several phones.
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert');
const { io } = require('socket.io-client');

const PORT = 3999;
const URL = `http://localhost:${PORT}`;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const emit = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));

function client() {
  const s = io(URL, { forceNew: true, transports: ['websocket'] });
  s.last = null;
  s.on('state', (st) => (s.last = st));
  return new Promise((r) => s.on('connect', () => r(s)));
}

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT },
    stdio: 'inherit',
  });
  await wait(500);
  try {
    const admin = await client();
    const created = await emit(admin, 'create', { name: 'Anna' });
    assert.match(created.code, /^\d{4}$/);

    const phones = [admin];
    const sessions = [created];
    for (const name of ['Jānis', 'Pēteris', 'Ilze']) {
      const s = await client();
      const res = await emit(s, 'join', { code: created.code, name });
      assert.ok(!res.error, res.error);
      phones.push(s);
      sessions.push(res);
    }
    assert.ok((await emit(await client(), 'join', { code: created.code, name: 'jānis' })).error, 'duplicate name rejected');
    assert.ok((await emit(await client(), 'join', { code: '0000x', name: 'X' })).error, 'bad code rejected');

    // Rounds: roles are private and words never repeat.
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      assert.ok((await emit(admin, 'startRound', { impostors: 1 })).ok);
      await wait(30);
      const rounds = phones.map((p) => p.last.round);
      const impostors = rounds.filter((r) => r.role === 'impostor');
      const artists = rounds.filter((r) => r.role === 'artist');
      assert.strictEqual(impostors.length, 1);
      assert.ok(impostors.every((r) => r.word === null), 'impostor must not get the word');
      assert.strictEqual(new Set(artists.map((r) => r.word)).size, 1);
      const word = artists[0].word;
      assert.ok(!seen.has(word), `word repeated: ${word}`);
      seen.add(word);
      assert.ok(phones.every((p) => !JSON.stringify(p.last).includes('impostorNames')), 'no leak before reveal');
    }
    assert.strictEqual(admin.last.wordsUsed, 30);

    // Reconnect: same role/word after disconnect.
    const before = phones[1].last.round;
    phones[1].disconnect();
    await wait(50);
    assert.strictEqual(admin.last.players.find((p) => p.name === 'Jānis').online, false);
    const back = await client();
    const { code, playerId, token } = sessions[1];
    assert.ok((await emit(back, 'resume', { code, playerId, token })).ok);
    await wait(30);
    assert.deepStrictEqual(back.last.round, before);
    phones[1] = back;

    // Reveal shows everything.
    admin.emit('reveal');
    await wait(30);
    assert.strictEqual(phones[2].last.round.impostorNames.length, 1);

    // Kick: player removed and cannot resume.
    let kicked = false;
    phones[3].on('kicked', () => (kicked = true));
    admin.emit('kick', { playerId: sessions[3].playerId });
    await wait(50);
    assert.ok(kicked);
    assert.strictEqual(admin.last.players.length, 3);
    const k = await client();
    assert.strictEqual((await emit(k, 'resume', { ...sessions[3] })).error, 'gone');

    // Non-admin can't kick.
    phones[1].emit('kick', { playerId: sessions[2].playerId });
    await wait(50);
    assert.strictEqual(admin.last.players.length, 3);

    // Admin leaving hands admin to someone else.
    admin.emit('leave');
    await wait(50);
    assert.ok(phones[1].last.players.some((p) => p.isAdmin));

    console.log('✅ All smoke tests passed');
  } finally {
    server.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 100);
  }
}

main().catch((e) => {
  console.error('❌', e);
  process.exitCode = 1;
});
