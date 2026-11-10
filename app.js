(() => {
  'use strict';

  /*
   * Topologi bintang (tanpa server sendiri):
   *  - Stage Manager (SM) membuka PeerJS dengan ID tetap dari kode acara.
   *  - Tiap perangkat divisi hanya menelepon SM (1 koneksi: audio dua arah + data).
   *  - SM mencampur audio dengan WebAudio: mic SM -> divisi tujuan, dan divisi yang
   *    bicara "ke semua" diteruskan SM ke divisi lain.
   */

  const CFG = window.HT_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const DIVS = CFG.DIVISIONS || [];
  const divName = (id) => (DIVS.find((d) => d.id === id) || {}).name || id;
  const hasDiv = (id) => DIVS.some((d) => d.id === id);
  const PEER_OPTS = Object.assign({ debug: 0 }, CFG.PEER_OPTIONS || {});

  let role = null;          // 'sm' | 'div'
  let myDiv = null;
  let myName = '';
  let code = '';
  let peer = null;
  let micStream = null;
  let micTrack = null;
  let talkingTarget = null; // null | 'sm' | 'all' | id divisi (khusus SM)
  let stopped = true;
  let wakeLock = null;
  let audioCtx = null;
  let alertTimer = null;
  let watchTimer = null;

  // --- state SM ---
  let smOut = null;
  let micSrc = null;
  const micGains = {};
  const dests = {};
  const entries = new Map();   // peerId -> entri perangkat divisi
  const lastRx = {};
  let smHeard = [];
  let divSpeaking = new Set();
  let reapTimer = null;

  // --- state Divisi ---
  let smConn = null;
  let smCall = null;
  let smOnline = false;
  let retryTimer = null;
  let remoteAudio = null;
  let rxLabels = [];
  let lastPong = 0;
  let pingTimer = null;

  const smId = () => 'stagecomms-' + code + '-sm';
  const normCode = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
  const cleanName = (s) => String(s || '').slice(0, 24);

  if (CFG.EVENT_TITLE) {
    document.title = CFG.EVENT_TITLE;
    $('title').textContent = CFG.EVENT_TITLE.toUpperCase();
  }

  /* ---------- Audio util ---------- */
  function ctx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  }

  function beepSeq(freqs, dur = 0.09, gap = 0.04) {
    try {
      const c = ctx();
      let t = c.currentTime;
      freqs.forEach((f) => {
        const o = c.createOscillator();
        const g = c.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        o.connect(g).connect(c.destination);
        o.start(t); o.stop(t + dur + 0.02);
        t += dur + gap;
      });
    } catch (e) { /* abaikan */ }
  }

  function setG(g, v) {
    try { g.gain.setTargetAtTime(v, audioCtx.currentTime, 0.015); } catch (e) { g.gain.value = v; }
  }

  /* ---------- UI util ---------- */
  function setStatus(text, on) {
    $('statusTxt').textContent = text;
    $('dot').classList.toggle('on', !!on);
  }

  function renderRxBox(labels) {
    const box = $('rx');
    if (labels.length) {
      box.classList.add('live');
      box.textContent = '🔊 ' + labels.join(', ');
    } else {
      box.classList.remove('live');
      box.textContent = 'Tidak ada yang berbicara';
    }
  }

  function renderTx() {
    document.querySelectorAll('[data-target]').forEach((el) => {
      el.classList.toggle('talking', talkingTarget !== null && el.dataset.target === talkingTarget);
    });
  }

  function showJoinError(msg) { const e = $('joinErr'); e.textContent = msg; e.classList.remove('hidden'); }

  function showAlert(fromLabel) {
    $('alertBig').textContent = 'PANGGILAN';
    $('alertSub').textContent = 'dari ' + fromLabel;
    $('alert').classList.remove('hidden');
    beepSeq([880, 1100, 880, 1100, 880, 1100], 0.12, 0.08);
    if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]);
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => $('alert').classList.add('hidden'), 8000);
  }
  $('alert').addEventListener('click', () => { $('alert').classList.add('hidden'); clearTimeout(alertTimer); });

  /* =====================================================
   *  STAGE MANAGER (hub)
   * ===================================================== */
  const label = (e) => divName(e.div) + (e.name ? ' (' + e.name + ')' : '');

  function startSM() {
    const c = ctx();
    smOut = c.createGain();
    smOut.gain.value = parseFloat($('vol').value);
    smOut.connect(c.destination);
    micSrc = c.createMediaStreamSource(micStream);
    DIVS.forEach((d) => {
      const dest = c.createMediaStreamDestination();
      dests[d.id] = dest;
      const g = c.createGain();
      g.gain.value = 0;
      micSrc.connect(g);
      g.connect(dest);
      micGains[d.id] = g;
    });
    clearInterval(reapTimer);
    // buang perangkat divisi yang sudah tidak mengirim detak (HP mati/terkunci/keluar jaringan)
    reapTimer = setInterval(() => {
      const now = Date.now();
      entries.forEach((e) => { if (now - e.seen > 10000) dropEntry(e.id, e.conn || e.call); });
    }, 3000);
    openSmPeer(0);
  }

  function openSmPeer(attempt) {
    if (stopped) return;
    setStatus('Menyambung ke server…', false);
    const p = new Peer(smId(), PEER_OPTS);
    peer = p;
    p.on('open', () => {
      if (peer !== p) return;
      setStatus('Siap · menunggu divisi', true);
      renderSm();
    });
    p.on('connection', (conn) => { if (peer === p) onSmConn(conn); });
    p.on('call', (call) => { if (peer === p) onSmCall(call); });
    p.on('disconnected', () => {
      if (peer === p && !stopped) { setStatus('Menyambung ulang ke server…', false); try { p.reconnect(); } catch (e) { /* abaikan */ } }
    });
    p.on('close', () => {
      if (peer !== p || stopped || p._handled) return;
      setStatus('Koneksi server terputus, menyambung ulang…', false);
      setTimeout(() => { if (!stopped && peer === p) openSmPeer(0); }, 3000);
    });
    p.on('error', (err) => {
      if (peer !== p || stopped) return;
      if (err.type === 'unavailable-id') {
        p._handled = true;
        try { p.destroy(); } catch (e) { /* abaikan */ }
        if (attempt < 12) {
          setStatus('Kode ini masih terpakai sesi lain, mencoba lagi…', false);
          setTimeout(() => openSmPeer(attempt + 1), 5000);
        } else {
          backToJoin('Sudah ada Stage Manager aktif dengan kode ini. Tutup halaman SM lain, tunggu sekitar 1 menit, lalu coba lagi.');
        }
      } else if (err.type === 'browser-incompatible') {
        backToJoin('Browser ini tidak mendukung WebRTC.');
      } else {
        setStatus('Gangguan koneksi (' + err.type + '), mencoba lagi…', false);
      }
    });
  }

  function getEntry(id, meta) {
    let e = entries.get(id);
    if (!e) {
      e = { id, div: meta.div, name: cleanName(meta.name), talk: false, target: 'sm', seen: Date.now(),
        conn: null, call: null, stream: null, src: null, toSm: null, toDiv: {}, hack: null };
      entries.set(id, e);
    }
    return e;
  }

  function cleanupNodes(e) {
    try { if (e.src) e.src.disconnect(); } catch (x) { /* abaikan */ }
    try { if (e.toSm) e.toSm.disconnect(); } catch (x) { /* abaikan */ }
    Object.values(e.toDiv).forEach((g) => { try { g.disconnect(); } catch (x) { /* abaikan */ } });
    if (e.hack) { e.hack.srcObject = null; e.hack = null; }
    e.src = null; e.toSm = null; e.toDiv = {}; e.stream = null;
  }

  function dropEntry(id, via) {
    const e = entries.get(id);
    if (!e || (via !== e.conn && via !== e.call)) return;   // event usang
    entries.delete(id);
    cleanupNodes(e);
    try { if (e.conn && e.conn !== via) e.conn.close(); } catch (x) { /* abaikan */ }
    try { if (e.call && e.call !== via) e.call.close(); } catch (x) { /* abaikan */ }
    route();
  }

  function onSmConn(conn) {
    const m = conn.metadata || {};
    if (!hasDiv(m.div)) { try { conn.close(); } catch (e) { /* abaikan */ } return; }
    const e = getEntry(conn.peer, m);
    e.conn = conn;
    conn.on('open', () => { renderSm(); sendRxTo(e); });
    conn.on('data', (d) => onSmData(e, d));
    conn.on('close', () => dropEntry(conn.peer, conn));
    conn.on('error', () => dropEntry(conn.peer, conn));
  }

  function onSmCall(call) {
    const m = call.metadata || {};
    if (!hasDiv(m.div)) { try { call.close(); } catch (e) { /* abaikan */ } return; }
    const e = getEntry(call.peer, m);
    e.call = call;
    call.answer(dests[m.div].stream);   // satu aliran campuran khusus divisi itu
    call.on('stream', (s) => attachDivStream(e, s));
    call.on('close', () => dropEntry(call.peer, call));
    call.on('error', () => dropEntry(call.peer, call));
  }

  function attachDivStream(e, stream) {
    if (e.stream === stream) return;
    cleanupNodes(e);
    const c = ctx();
    e.stream = stream;
    // Chrome: aliran WebRTC jarak jauh baru mengalir ke WebAudio bila juga dipasang pada elemen audio.
    e.hack = new Audio();
    e.hack.muted = true;
    e.hack.srcObject = stream;
    e.hack.play().catch(() => {});
    e.src = c.createMediaStreamSource(stream);
    e.toSm = c.createGain();
    e.toSm.gain.value = 0;
    e.src.connect(e.toSm);
    e.toSm.connect(smOut);
    DIVS.forEach((d) => {
      if (d.id === e.div) return;       // tidak mengembalikan suara ke divisi sendiri
      const g = c.createGain();
      g.gain.value = 0;
      e.src.connect(g);
      g.connect(dests[d.id]);
      e.toDiv[d.id] = g;
    });
    route();
  }

  function onSmData(e, d) {
    if (!d || typeof d !== 'object') return;
    e.seen = Date.now();
    if (d.t === 'ping') {
      if (e.conn && e.conn.open) e.conn.send({ t: 'pong' });
    } else if (d.t === 'st') {
      e.talk = !!d.talk;
      e.target = d.target === 'all' ? 'all' : 'sm';
      route();
    } else if (d.t === 'call') {
      showAlert(label(e));
    }
  }

  function sendRxTo(e) {
    if (e.conn && e.conn.open) e.conn.send({ t: 'rx', labels: lastRx[e.div] || [] });
  }

  // Menentukan siapa mendengar siapa, lalu memperbarui gain dan label.
  function route() {
    if (role !== 'sm' || !audioCtx || !smOut) return;
    const smTalk = talkingTarget !== null;
    DIVS.forEach((d) => {
      setG(micGains[d.id], smTalk && (talkingTarget === 'all' || talkingTarget === d.id) ? 1 : 0);
    });

    const heard = [];
    const speaking = new Set();
    entries.forEach((e) => {
      const toSm = e.talk && (e.target === 'sm' || e.target === 'all');
      if (e.toSm) setG(e.toSm, toSm ? 1 : 0);
      if (toSm) { heard.push(label(e)); speaking.add(e.div); }
      Object.keys(e.toDiv).forEach((did) => setG(e.toDiv[did], e.talk && e.target === 'all' ? 1 : 0));
    });

    DIVS.forEach((d) => {
      const labels = [];
      if (smTalk && (talkingTarget === 'all' || talkingTarget === d.id)) labels.push('Stage Manager');
      entries.forEach((e) => { if (e.talk && e.target === 'all' && e.div !== d.id) labels.push(label(e)); });
      const key = JSON.stringify(labels);
      if (lastRx[d.id + '#k'] !== key) {
        lastRx[d.id + '#k'] = key;
        lastRx[d.id] = labels;
        entries.forEach((e) => { if (e.div === d.id) sendRxTo(e); });
      }
    });

    if (!smHeard.length && heard.length) beepSeq([660], 0.07);
    else if (smHeard.length && !heard.length) beepSeq([990], 0.07);
    smHeard = heard;
    divSpeaking = speaking;
    renderSm();
  }

  function renderSm() {
    if (role !== 'sm') return;
    const online = new Set();
    entries.forEach((e) => { if (e.conn && e.conn.open) online.add(e.div); });
    document.querySelectorAll('.tile').forEach((el) => {
      el.classList.toggle('online', online.has(el.dataset.target));
      el.classList.toggle('speaking', divSpeaking.has(el.dataset.target));
    });
    $('onlineCount').textContent = online.size + '/' + DIVS.length + ' divisi online';
    if (peer && peer.open) setStatus('Hub aktif · ' + online.size + ' divisi online', true);
    renderRxBox(smHeard);
  }

  function sendCallToDiv(divId) {
    let sent = 0;
    entries.forEach((e) => {
      if (e.div === divId && e.conn && e.conn.open) { e.conn.send({ t: 'call', from: 'Stage Manager' }); sent++; }
    });
    beepSeq(sent ? [700, 900] : [300], 0.07);
  }

  function buildGrid() {
    const grid = $('grid');
    grid.innerHTML = '';
    DIVS.forEach((d) => {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.target = d.id;
      tile.innerHTML = '<span class="tdot"></span><span class="tn"></span>';
      tile.querySelector('.tn').textContent = d.name;
      const bell = document.createElement('button');
      bell.className = 'bell';
      bell.dataset.nopt = '1';
      bell.textContent = '🔔';
      bell.setAttribute('aria-label', 'Panggil ' + d.name);
      bell.addEventListener('click', () => sendCallToDiv(d.id));
      tile.appendChild(bell);
      grid.appendChild(tile);
      bindPtt(tile, d.id);
    });
  }

  /* =====================================================
   *  DIVISI (ujung bintang)
   * ===================================================== */
  function startDiv() {
    clearInterval(pingTimer);
    // detak: jika SM tidak membalas >7 detik, anggap putus dan sambung ulang
    pingTimer = setInterval(() => {
      if (stopped || !smConn || !smConn.open) return;
      if (Date.now() - lastPong > 7000) { lost(); return; }
      try { smConn.send({ t: 'ping' }); } catch (e) { /* abaikan */ }
    }, 2000);
    openDivPeer();
  }

  function openDivPeer() {
    if (stopped) return;
    teardownSm();
    setStatus('Menyambung ke server…', false);
    const p = new Peer(PEER_OPTS);
    peer = p;
    p.on('open', () => { if (peer === p) connectSm(); });
    p.on('disconnected', () => {
      if (peer === p && !stopped) { try { p.reconnect(); } catch (e) { /* abaikan */ } }
    });
    p.on('close', () => {
      if (peer !== p || stopped) return;
      setStatus('Koneksi server terputus, menyambung ulang…', false);
      setTimeout(() => { if (!stopped && peer === p) openDivPeer(); }, 3000);
    });
    p.on('error', (err) => {
      if (peer !== p || stopped) return;
      if (err.type === 'peer-unavailable' || err.type === 'webrtc') {
        lost();
      } else if (err.type === 'browser-incompatible') {
        backToJoin('Browser ini tidak mendukung WebRTC.');
      } else {
        setStatus('Gangguan koneksi (' + err.type + '), mencoba lagi…', false);
      }
    });
  }

  function teardownSm() {
    const c = smConn; const k = smCall;
    smConn = null; smCall = null; smOnline = false;
    try { if (c) c.close(); } catch (e) { /* abaikan */ }
    try { if (k) k.close(); } catch (e) { /* abaikan */ }
  }

  function renderDivStatus() {
    setStatus(smOnline ? 'Terhubung · SM online' : 'Menunggu Stage Manager…', smOnline);
  }

  function scheduleRetry() {
    if (stopped) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connectSm, 3000);
  }

  function lost() {
    if (stopped) return;
    teardownSm();
    rxLabels = [];
    renderRxBox([]);
    renderDivStatus();
    scheduleRetry();
  }

  function connectSm() {
    if (stopped || !peer || peer.destroyed || !peer.open) return;
    clearTimeout(retryTimer);
    teardownSm();
    const meta = { div: myDiv, name: myName };
    renderDivStatus();

    const conn = peer.connect(smId(), { reliable: true, metadata: meta });
    smConn = conn;
    conn.on('open', () => {
      if (smConn !== conn) return;
      smOnline = true;
      lastPong = Date.now();
      conn.send({ t: 'st', talk: talkingTarget !== null, target: talkingTarget || 'sm' });
      renderDivStatus();
    });
    conn.on('data', onDivData);
    conn.on('close', () => { if (smConn === conn) lost(); });
    conn.on('error', () => { if (smConn === conn) lost(); });

    const call = peer.call(smId(), micStream, { metadata: meta });
    smCall = call;
    call.on('stream', (s) => { if (smCall === call) playSm(s); });
    call.on('close', () => { if (smCall === call) lost(); });
    call.on('error', () => { if (smCall === call) lost(); });
  }

  function playSm(stream) {
    if (!remoteAudio) {
      remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
      $('audios').appendChild(remoteAudio);
    }
    remoteAudio.srcObject = stream;
    remoteAudio.volume = parseFloat($('vol').value);
    remoteAudio.play().then(() => $('audioWarn').classList.add('hidden'))
      .catch(() => $('audioWarn').classList.remove('hidden'));
  }

  function onDivData(d) {
    if (!d || typeof d !== 'object') return;
    lastPong = Date.now();
    if (d.t === 'rx') {
      const was = rxLabels.length;
      rxLabels = Array.isArray(d.labels) ? d.labels.slice(0, 8).map(String) : [];
      renderRxBox(rxLabels);
      if (!was && rxLabels.length) beepSeq([660], 0.07);
      else if (was && !rxLabels.length) beepSeq([990], 0.07);
    } else if (d.t === 'call') {
      showAlert(String(d.from || 'Stage Manager'));
    }
  }

  function sendCallToSm() {
    if (smConn && smConn.open) { smConn.send({ t: 'call' }); beepSeq([700, 900], 0.07); }
    else beepSeq([300], 0.07);
  }

  /* =====================================================
   *  Push-to-talk (dipakai kedua peran)
   * ===================================================== */
  function setTalkTarget(t) {
    if (!peer || stopped || !micTrack || t === talkingTarget) return;
    const was = talkingTarget;
    talkingTarget = t;
    micTrack.enabled = t !== null;
    if (was === null && t !== null) beepSeq([1200], 0.06);
    if (was !== null && t === null) beepSeq([800], 0.06);
    renderTx();
    if (role === 'sm') route();
    else if (smConn && smConn.open) smConn.send({ t: 'st', talk: t !== null, target: t || 'sm' });
  }

  function bindPtt(el, target) {
    let down = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('[data-nopt]')) return;
      e.preventDefault();
      if ($('latch').checked) { setTalkTarget(talkingTarget === target ? null : target); return; }
      down = true;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* abaikan */ }
      setTalkTarget(target);
    });
    const up = () => {
      if (!down) return;
      down = false;
      if (!$('latch').checked) setTalkTarget(null);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /* =====================================================
   *  Masuk / keluar
   * ===================================================== */
  async function keepAwake() {
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* abaikan */ }
  }

  async function connect() {
    $('joinErr').classList.add('hidden');
    role = $('role').value;
    myDiv = role === 'div' ? $('div').value : null;
    myName = cleanName($('name').value.trim());
    code = normCode($('code').value);

    if (code.length < 4) return showJoinError('Kode acara minimal 4 huruf/angka.');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      return showJoinError('Browser tidak mendukung mikrofon, atau halaman tidak dibuka lewat HTTPS.');
    if (!window.Peer) return showJoinError('Library PeerJS gagal dimuat. Cek koneksi internet lalu muat ulang.');

    try {
      localStorage.setItem('ht_name', myName);
      localStorage.setItem('ht_role', role);
      localStorage.setItem('ht_code', code);
      if (myDiv) localStorage.setItem('ht_div', myDiv);
    } catch (e) { /* abaikan */ }

    ctx();   // dibuat saat ada gestur pengguna
    $('joinBtn').disabled = true;
    $('joinBtn').textContent = 'Menghubungkan…';
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
    } catch (e) {
      $('joinBtn').disabled = false;
      $('joinBtn').textContent = 'Masuk';
      return showJoinError('Izin mikrofon ditolak. Aktifkan izin mikrofon untuk situs ini lalu coba lagi.');
    }
    micTrack = micStream.getAudioTracks()[0];
    micTrack.enabled = false;

    stopped = false;
    talkingTarget = null;
    showRadio();
    keepAwake();
    clearInterval(watchTimer);
    watchTimer = setInterval(() => {
      if (!stopped && peer && !peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch (e) { /* abaikan */ } }
    }, 5000);
    if (role === 'sm') startSM(); else startDiv();

    $('joinBtn').disabled = false;
    $('joinBtn').textContent = 'Masuk';
  }

  function showRadio() {
    $('join').classList.add('hidden');
    $('radio').classList.remove('hidden');
    $('roleLabel').textContent = role === 'sm' ? 'STAGE MANAGER' : divName(myDiv).toUpperCase();
    $('smView').classList.toggle('hidden', role !== 'sm');
    $('divView').classList.toggle('hidden', role !== 'div');
    $('audioWarn').classList.add('hidden');
    renderRxBox([]);
    renderTx();
    setStatus('Menyambung…', false);
    if (role === 'sm') {
      const base = location.origin + location.pathname;
      $('links').value = ['Stage Manager: ' + base + '#' + code + '/sm']
        .concat(DIVS.map((d) => d.name + ': ' + base + '#' + code + '/' + d.id)).join('\n');
    }
  }

  function backToJoin(msg) {
    stopped = true;
    clearTimeout(retryTimer);
    clearInterval(watchTimer);
    clearInterval(pingTimer);
    clearInterval(reapTimer);
    talkingTarget = null;
    teardownSm();
    entries.forEach((e) => {
      try { if (e.conn) e.conn.close(); } catch (x) { /* abaikan */ }
      try { if (e.call) e.call.close(); } catch (x) { /* abaikan */ }
    });
    entries.clear();
    if (peer) { try { peer.destroy(); } catch (e) { /* abaikan */ } peer = null; }
    if (micStream) micStream.getTracks().forEach((t) => t.stop());
    micStream = null; micTrack = null;
    if (audioCtx) { try { audioCtx.close(); } catch (e) { /* abaikan */ } audioCtx = null; }
    smOut = null; micSrc = null;
    Object.keys(micGains).forEach((k) => delete micGains[k]);
    Object.keys(dests).forEach((k) => delete dests[k]);
    Object.keys(lastRx).forEach((k) => delete lastRx[k]);
    smHeard = []; divSpeaking = new Set(); rxLabels = [];
    remoteAudio = null;
    $('audios').innerHTML = '';
    if (wakeLock) { try { wakeLock.release(); } catch (e) { /* abaikan */ } wakeLock = null; }
    $('radio').classList.add('hidden');
    $('join').classList.remove('hidden');
    $('alert').classList.add('hidden');
    document.querySelectorAll('.tile').forEach((el) => el.classList.remove('online', 'speaking'));
    renderTx();
    if (msg) showJoinError(msg);
  }

  /* ---------- Setup UI ---------- */
  const divSel = $('div');
  DIVS.forEach((d) => { const o = document.createElement('option'); o.value = d.id; o.textContent = d.name; divSel.appendChild(o); });

  function syncRoleFields() { $('divField').classList.toggle('hidden', $('role').value === 'sm'); }
  $('role').addEventListener('change', syncRoleFields);

  try {
    $('name').value = localStorage.getItem('ht_name') || '';
    $('role').value = localStorage.getItem('ht_role') || 'div';
    $('code').value = localStorage.getItem('ht_code') || '';
    const sd = localStorage.getItem('ht_div'); if (sd && hasDiv(sd)) $('div').value = sd;
  } catch (e) { /* abaikan */ }

  // Link khusus: #kodeacara/sm  atau  #kodeacara/d05
  const hp = decodeURIComponent(location.hash.slice(1)).split('/');
  if (hp[0]) $('code').value = hp[0];
  if (hp[1] === 'sm') $('role').value = 'sm';
  else if (hasDiv(hp[1])) { $('role').value = 'div'; $('div').value = hp[1]; }
  syncRoleFields();

  buildGrid();
  bindPtt($('pttSm'), 'sm');
  bindPtt($('pttAllDiv'), 'all');
  bindPtt($('pttAllSm'), 'all');
  $('callSm').addEventListener('click', sendCallToSm);

  $('joinBtn').addEventListener('click', connect);
  $('leaveBtn').addEventListener('click', () => backToJoin());
  $('audioWarn').addEventListener('click', () => { if (remoteAudio) remoteAudio.play().then(() => $('audioWarn').classList.add('hidden')).catch(() => {}); });

  $('vol').addEventListener('input', () => {
    const v = parseFloat($('vol').value);
    if (remoteAudio) remoteAudio.volume = v;
    if (smOut) smOut.gain.value = v;
  });
  $('dim').addEventListener('change', () => document.body.classList.toggle('dim', $('dim').checked));

  // Spasi = tombol bicara utama (SM: ke semua, Divisi: ke SM)
  const spaceTarget = () => (role === 'sm' ? 'all' : 'sm');
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || stopped) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    if ($('latch').checked) setTalkTarget(talkingTarget ? null : spaceTarget());
    else setTalkTarget(spaceTarget());
  });
  window.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || stopped || $('latch').checked) return;
    setTalkTarget(null);
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (!$('latch').checked) setTalkTarget(null); }
    else if (!stopped) keepAwake();
  });
  window.addEventListener('beforeunload', () => { if (peer) { try { peer.destroy(); } catch (e) { /* abaikan */ } } });

  // untuk pengujian
  window.__ht = { entries, get role() { return role; } };
})();
