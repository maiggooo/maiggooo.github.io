// Online rooms for multiplayer games, kept from the old MarketingDuell.
// Uses the Firebase Realtime Database of the "maiggooo" project.
//
// Load order on a page:
//   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js"></script>
//   <script src="multiplayer.js"></script>
//
// Every tab signs in anonymously (no account needed); the player id is that sign-in's uid,
// which the database rules in database.rules.json use to decide who may write what.
// The id survives a reload of the tab. Bots/extra seats pass their own appName to get
// a separate sign-in and therefore their own id.
//
// Usage:
//   const mp = Multiplayer.create("wizard", { maxPlayers: 6 });   // mp.me is set once host()/join() resolved
//   const code = await mp.host("Maiko", { phase: "lobby" });  // open a room, you are the host
//   await mp.join("K7QXM", "Lina");                           // or join one by its code
//   mp.onChange(room => render(room));  // { code, hostId, state, players: { id: { name, joinedAt, data } } }
//   mp.setState({ phase: "night" });    // shared game state
//   mp.transaction("state", s => { ...; return s; });  // race-free update
//   mp.setMine({ vote: "p2" });         // this player's own data
//   Multiplayer.hostOf(room);           // host, or the longest-present player if the host is gone
//   mp.leave();
//
// Rooms live under games/<game>/rooms/<code>. A player who closes the tab is removed
// automatically and comes back by themselves when the connection returns (e.g. after the
// phone screen was locked). When the last player leaves, the room is deleted; rooms that
// have been empty and idle for 15 minutes, or are older than a day, are swept away
// whenever someone opens or joins a room.

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC5rIZe_XZsUI7XElqYPuyzVf3-PCNALtI",
  authDomain:        "maiggooo.firebaseapp.com",
  databaseURL:       "https://maiggooo-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "maiggooo",
  storageBucket:     "maiggooo.firebasestorage.app",
  messagingSenderId: "390526000253",
  appId:             "1:390526000253:web:dcc10cb716978769cf2514"
};

const ROOM_MAX_AGE = 24 * 60 * 60 * 1000;
const ROOM_IDLE    = 15 * 60 * 1000;

const Multiplayer = {
  NOW: () => firebase.database.ServerValue.TIMESTAMP,

  // Room codes without look-alike characters (0/O, 1/I)
  makeCode(len = 5) {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: len }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
  },

  // The host, or whoever has been in the room longest if the host left
  hostOf(room) {
    const players = room?.players || {};
    if (players[room?.hostId]) return room.hostId;
    return Object.entries(players).sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0))[0]?.[0] || null;
  },

  create(game, { maxPlayers = 20, appName } = {}) {
    const appKey = appName || "[DEFAULT]";
    const app = firebase.apps.find(a => a.name === appKey) || firebase.initializeApp(FIREBASE_CONFIG, ...(appName ? [appName] : []));
    const db = app.database();
    let me = null;
    // Anonymous sign-in, kept per tab so a reload keeps the same id. If sign-in isn't
    // available (auth not enabled yet), fall back to a random per-tab id.
    const ready = (async () => {
      try {
        const auth = app.auth();
        await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION);
        const user = await new Promise(res => { const un = auth.onAuthStateChanged(u => { un(); res(u); }); });
        return (user || (await auth.signInAnonymously()).user).uid;
      } catch (e) {
        console.warn("Anonyme Anmeldung nicht möglich, nutze Ersatz-ID:", e?.code || e);
        const key = "mp-id-" + appKey;
        let id = null;
        try { id = sessionStorage.getItem(key); } catch {}
        if (!id) { id = "p" + Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem(key, id); } catch {} }
        return id;
      }
    })().then(id => (me = api.me = id));
    const roomsRef = db.ref(`games/${game}/rooms`);
    const roomRef = code => roomsRef.child(code);
    let ref = null, off = null, myName = "", connOff = null;
    const touch = () => ref && ref.child("lastActive").set(Multiplayer.NOW());

    // Delete rooms that are empty or stale. Best effort, never blocks the caller.
    async function sweep() {
      try {
        const snap = await roomsRef.get();
        const now = Date.now();
        snap.forEach(r => {
          const v = r.val() || {};
          const idle = now - (v.lastActive || v.createdAt || 0);
          if ((!v.players && idle > ROOM_IDLE) || now - (v.createdAt || 0) > ROOM_MAX_AGE) r.ref.remove();
        });
      } catch {}
    }

    const api = {
      me: null, code: null, isHost: false, ready,

      async host(name, state = {}) {
        await ready;
        sweep();
        let code;
        do { code = Multiplayer.makeCode(); } while ((await roomRef(code).get()).exists());
        await roomRef(code).set({
          hostId: me, createdAt: Multiplayer.NOW(), lastActive: Multiplayer.NOW(), state,
          players: { [me]: { name, joinedAt: Multiplayer.NOW() } }
        });
        api.isHost = true;
        enter(code, name);
        return code;
      },

      async join(code, name) {
        await ready;
        sweep();
        code = String(code).trim().toUpperCase();
        const snap = await roomRef(code).get();
        if (!snap.exists()) throw new Error("Raum nicht gefunden");   // empty rooms stay joinable until the sweep removes them
        const room = snap.val();
        const players = room.players || {};
        if (!players[me] && Object.keys(players).length >= maxPlayers) throw new Error("Raum ist voll");
        await roomRef(code).child("players/" + me).update({ name, joinedAt: players[me]?.joinedAt || Multiplayer.NOW() });
        api.isHost = room.hostId === me;
        enter(code, name);
        touch();
        return room;
      },

      onChange(cb) {
        if (!ref) throw new Error("Erst host() oder join() aufrufen");
        if (off) off();
        const handler = ref.on("value", snap => cb(snap.exists() ? { code: api.code, ...snap.val() } : null));
        const r = ref;
        off = () => r.off("value", handler);
      },

      // Writes after leave() (e.g. a move that was still scheduled) are ignored
      setState(patch) { if (!ref) return Promise.resolve(); touch(); return ref.child("state").update(patch); },
      setMine(patch)  { if (!ref) return Promise.resolve(); touch(); return ref.child("players/" + me + "/data").update(patch); },
      transaction(path, fn) { if (!ref) return Promise.resolve(); touch(); return ref.child(path).transaction(fn); },
      ref(path = "") { return path ? ref.child(path) : ref; },

      async leave() {
        if (!ref) return;
        const r = ref;
        if (off) { off(); off = null; }
        if (connOff) { connOff(); connOff = null; }
        ref = null; api.code = null; api.isHost = false;
        try {
          // Cancel the tab-close handler first, or it would re-create the room after it is deleted
          await r.child("players/" + me).onDisconnect().cancel();
          await r.child("players/" + me).remove();
          const left = await r.child("players").get();
          if (!left.exists()) await r.remove();   // last one out deletes the room
        } catch {}
      }
    };

    function enter(code, name) {
      api.code = code; myName = name;
      ref = roomRef(code);
      if (connOff) connOff();
      // (Re)announce this player whenever the connection is (re)established
      const info = db.ref(".info/connected");
      const h = info.on("value", async snap => {
        if (!snap.val() || !ref) return;
        const r = ref;
        await r.child("players/" + me).onDisconnect().remove();
        if (!(await r.child("createdAt").get()).exists()) return;   // room is gone, don't recreate it
        await r.child("players/" + me).update({ name: myName });
        if (!(await r.child("players/" + me + "/joinedAt").get()).exists()) r.child("players/" + me + "/joinedAt").set(Multiplayer.NOW());
      });
      connOff = () => info.off("value", h);
    }
    return api;
  }
};
