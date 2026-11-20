// Ponte tra ALDO e Firebase.
// ALDO è nato come Artifact di claude.ai e parla con window.claude.use('db' | 'downloads' | 'sample' | 'dictation').
// Qui ricreiamo le stesse funzioni sopra Firebase, così il codice dell'app (app.js) resta quasi identico.
// Ogni utente lavora solo dentro utenti/{uid}/...: le regole di Firestore impediscono di leggere i dati altrui.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  sendPasswordResetEmail, signInWithPopup, GoogleAuthProvider, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, addDoc, setDoc, deleteDoc, onSnapshot, getDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// cache locale: l'app si apre subito e funziona anche con connessione ballerina
const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

/* ---------- database con la stessa forma di quello degli Artifact ---------- */
function makeDb(uid) {
  const base = ['utenti', uid];
  const colRef = name => collection(fs, ...base, ...String(name).split('/'));
  const docRef = path => doc(fs, ...base, ...String(path).split('/'));
  const wrapErr = cb => cb && (e => cb({ code: e.code || 'error', message: e.message }));
  const docSnap = s => ({ id: s.id, exists: s.exists(), data: () => s.data() });
  return {
    collection(name) {
      return {
        async add(data) { const r = await addDoc(colRef(name), data); return { id: r.id }; },
        doc(id) { return this._doc(name + '/' + id); },
        _doc: p => makeDocApi(p),
        onSnapshot(cb, err) {
          return onSnapshot(colRef(name), s => cb({ docs: s.docs.map(docSnap) }), wrapErr(err));
        },
      };
    },
    doc(path) { return makeDocApi(path); },
  };
  function makeDocApi(path) {
    return {
      set: data => setDoc(docRef(path), data),
      update: data => setDoc(docRef(path), data, { merge: true }),
      delete: () => deleteDoc(docRef(path)),
      onSnapshot: (cb, err) => onSnapshot(docRef(path), s => cb(docSnap(s)), wrapErr(err)),
    };
  }
}

/* ---------- download (backup Excel) ---------- */
const downloads = {
  async save({ filename, data }) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  },
};

/* ---------- login ---------- */
let userReady;
const userPromise = new Promise(r => { userReady = r; });
let dbInstance = null;

const ERR = {
  'auth/invalid-credential': 'Email o password non corretti.',
  'auth/invalid-email': 'L\'email non sembra valida.',
  'auth/user-not-found': 'Nessun account con questa email.',
  'auth/wrong-password': 'Password non corretta.',
  'auth/email-already-in-use': 'Hai già un account con questa email: accedi.',
  'non-invitato': 'Questa email non è stata invitata. Chiedi un invito a chi gestisce ALDO.',
  'auth/weak-password': 'La password deve avere almeno 6 caratteri.',
  'auth/too-many-requests': 'Troppi tentativi: riprova tra qualche minuto.',
  'auth/popup-closed-by-user': 'Accesso con Google annullato.',
  'auth/admin-restricted-operation': 'Le nuove iscrizioni sono chiuse: chiedi un invito.',
};
const msg = e => ERR[e && e.code] || 'Qualcosa non ha funzionato. Riprova.';

function showLogin() {
  if (document.getElementById('login')) return;
  const el = document.createElement('div');
  el.id = 'login';
  el.innerHTML = `
    <form class="lg-card" novalidate>
      <div class="lg-brand"><b>ALDO<i>.</i></b><span>accesso su invito</span></div>
      <button type="button" class="lg-google">${G_ICON}Continua con Google</button>
      <div class="lg-or"><span>oppure</span></div>
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <label>Password<input type="password" name="password" autocomplete="current-password" required minlength="6"></label>
      <div class="lg-err" role="alert"></div>
      <button type="submit" class="btn lg-go">Accedi</button>
      <div class="lg-links"><button type="button" class="lnk lg-mode">Hai ricevuto un invito? Crea la password</button><button type="button" class="lnk lg-reset">Password dimenticata?</button></div>
    </form>`;
  document.body.appendChild(el);
  const f = el.querySelector('form'), err = el.querySelector('.lg-err'), go = el.querySelector('.lg-go'), mode = el.querySelector('.lg-mode');
  let registra = false;
  mode.onclick = () => {
    registra = !registra; err.textContent = '';
    go.textContent = registra ? 'Crea account' : 'Accedi';
    mode.textContent = registra ? 'Hai già un account? Accedi' : 'Hai ricevuto un invito? Crea la password';
    f.password.autocomplete = registra ? 'new-password' : 'current-password';
  };
  el.querySelector('.lg-reset').onclick = async () => {
    const email = f.email.value.trim();
    if (!email) { err.textContent = 'Scrivi la tua email qui sopra, poi tocca di nuovo.'; return; }
    try { await sendPasswordResetEmail(auth, email); err.textContent = 'Ti ho mandato una email per reimpostare la password.'; }
    catch (e) { err.textContent = msg(e); }
  };
  el.querySelector('.lg-google').onclick = async () => {
    err.textContent = '';
    try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { err.textContent = msg(e); }
  };
  f.onsubmit = async e => {
    e.preventDefault(); err.textContent = ''; go.disabled = true;
    const email = f.email.value.trim(), pw = f.password.value;
    try { registra ? await createUserWithEmailAndPassword(auth, email, pw) : await signInWithEmailAndPassword(auth, email, pw); }
    catch (er) { err.textContent = msg(er); }
    finally { go.disabled = false; }
  };
}
const G_ICON = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"/><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"/><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"/></svg>';

let currentUid = null;
// accesso consentito solo alle email presenti in inviti/{email}
async function invitato(user) {
  if (!user.email) return false;
  try { return (await getDoc(doc(fs, 'inviti', user.email.toLowerCase()))).exists(); } catch (e) { return false; }
}
async function isAdmin(uid) {
  try { return (await getDoc(doc(fs, 'admins', uid))).exists(); } catch (e) { return false; }
}
onAuthStateChanged(auth, async user => {
  if (user && !(await invitato(user))) {
    await signOut(auth);
    showLogin();
    const err = document.querySelector('#login .lg-err'); if (err) err.textContent = msg({ code: 'non-invitato' });
    return;
  }
  if (user) {
    if (currentUid && currentUid !== user.uid) { location.reload(); return; } // cambio utente: si riparte puliti
    currentUid = user.uid;
    document.getElementById('login')?.remove();
    dbInstance = dbInstance || makeDb(user.uid);
    window.aldoUser = { uid: user.uid, email: user.email, nome: user.displayName || '', admin: await isAdmin(user.uid) };
    userReady(user);
  } else {
    if (currentUid) { location.reload(); return; } // uscito: ricarica e mostra il login
    showLogin();
  }
});

window.aldoLogout = () => signOut(auth);

// gestione inviti (solo amministratore: le regole di Firestore rifiutano gli altri)
window.aldoInviti = {
  ascolta(cb) { return onSnapshot(collection(fs, 'inviti'), s => cb(s.docs.map(d => ({ email: d.id, ...d.data() }))), () => cb(null)); },
  aggiungi: email => setDoc(doc(fs, 'inviti', String(email).trim().toLowerCase()), { creato: new Date().toISOString(), da: auth.currentUser?.email || '' }),
  togli: email => deleteDoc(doc(fs, 'inviti', email)),
};

/* ---------- stessa interfaccia di window.claude ---------- */
window.claude = {
  async use(name) {
    if (name === 'db') { await userPromise; return dbInstance; }
    if (name === 'downloads') return downloads;
    // 'sample' (Chiedi ad ALDO) e 'dictation' arrivano nella fase 4: per ora la chat resta nascosta
    return null;
  },
};

// l'app parte solo quando il ponte è pronto
const s = document.createElement('script');
s.src = './app.js';
document.body.appendChild(s);
