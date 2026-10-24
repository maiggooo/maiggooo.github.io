// Online rooms for multiplayer games, kept from the old MarketingDuell.
// Uses the Firebase Realtime Database of the "maiggooo" project.
//
// Load order on a page:
//   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js"></script>
//   <script src="https://www.gstatic.com/firebasejs/10.12.2/firebase-database-compat.js"></script>
//   <script src="multiplayer.js"></script>
//
// Usage:
//   const mp = Multiplayer.create("werwolf", { maxPlayers: 12 });
//   const code = await mp.host("Maiko", { phase: "lobby" });  // open a room, you are the host
//   await mp.join("K7QXM", "Lina");                           // or join one by its code
//   mp.onChange(room => render(room));  // { code, hostId, status, state, players: { id: { name, joinedAt, data } } }
//   mp.setState({ phase: "night" });    // shared game state (usually only the host writes it)
//   mp.setMine({ vote: "p2" });         // this player's own data
//   mp.leave();
//
// Rooms live under games/<game>/rooms/<code>. A player who closes the tab is removed
// automatically; when the host leaves, the room is marked "closed".

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC5rIZe_XZsUI7XElqYPuyzVf3-PCNALtI",
  authDomain:        "maiggooo.firebaseapp.com",
  databaseURL:       "https://maiggooo-default-rtdb.europe-west1.firebasedatabase.app",
  projectId:         "maiggooo",
  storageBucket:     "maiggooo.firebasestorage.app",
  messagingSenderId: "390526000253",
  appId:             "1:390526000253:web:dcc10cb716978769cf2514"
};

const Multiplayer = {
  NOW: () => firebase.database.ServerValue.TIMESTAMP,

  // Room codes without look-alike characters (0/O, 1/I)
  makeCode(len = 5) {
    const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    return Array.from({ length: len }, () => abc[Math.floor(Math.random() * abc.length)]).join("");
  },

  create(game, { maxPlayers = 20, playerId } = {}) {
    if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
    const db = firebase.database();
    // Same id after a reload, so a player can come back into their room
    let me = playerId;
    if (!me) {
      try { me = sessionStorage.getItem("mp-id"); } catch {}
      if (!me) { me = "p" + Math.random().toString(36).slice(2, 10); try { sessionStorage.setItem("mp-id", me); } catch {} }
    }
    const roomRef = code => db.ref(`games/${game}/rooms/${code}`);
    let ref = null, off = null;

    const api = {
      me, code: null, isHost: false,

      async host(name, state = {}) {
        let code;
        do { code = Multiplayer.makeCode(); } while ((await roomRef(code).get()).exists());
        await roomRef(code).set({
          hostId: me, status: "open", createdAt: Multiplayer.NOW(), state,
          players: { [me]: { name, joinedAt: Multiplayer.NOW() } }
        });
        api.isHost = true;
        enter(code);
        ref.child("status").onDisconnect().set("closed");
        return code;
      },

      async join(code, name) {
        code = String(code).trim().toUpperCase();
        const snap = await roomRef(code).get();
        if (!snap.exists()) throw new Error("Raum nicht gefunden");
        const room = snap.val();
        if (room.status === "closed") throw new Error("Raum wurde beendet");
        const players = room.players || {};
        if (!players[me] && Object.keys(players).length >= maxPlayers) throw new Error("Raum ist voll");
        await roomRef(code).child("players/" + me).update({ name, joinedAt: Multiplayer.NOW() });
        api.isHost = room.hostId === me;
        enter(code);
        return room;
      },

      onChange(cb) {
        if (!ref) throw new Error("Erst host() oder join() aufrufen");
        if (off) off();
        const handler = ref.on("value", snap => cb(snap.exists() ? { code: api.code, ...snap.val() } : null));
        const r = ref;
        off = () => r.off("value", handler);
      },

      setState(patch) { return ref.child("state").update(patch); },
      setMine(patch)  { return ref.child("players/" + me + "/data").update(patch); },
      transaction(path, fn) { return ref.child(path).transaction(fn); },
      ref(path = "") { return path ? ref.child(path) : ref; },

      async leave() {
        if (!ref) return;
        if (off) { off(); off = null; }
        try {
          if (api.isHost) await ref.child("status").set("closed");
          await ref.child("players/" + me).remove();
        } catch {}
        ref = null; api.code = null; api.isHost = false;
      }
    };

    function enter(code) {
      api.code = code;
      ref = roomRef(code);
      ref.child("players/" + me).onDisconnect().remove();
    }
    return api;
  }
};
