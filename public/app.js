/* ---------- config ---------- */
const TABS = [
  ['home', 'Dashboard'], ['progetti', 'Progetti'], ['note', 'Note'], ['fatture', 'Fatture'], ['tasse', 'Tasse'],
  ['clienti', 'Clienti'], ['spese', 'Spese'], ['impostazioni', 'Impostazioni'],
];
const STATI_P = [
  ['preventivo', 'Preventivi', 'var(--rosa)'],
  ['in_corso', 'In corso', 'var(--lilla)'],
  ['in_revisione', 'Attesa', 'var(--giallo)'],
  ['completato', 'Completato', 'var(--verde)'],
];
// "da_fare" (vecchio stato) e stati sconosciuti valgono come "in corso"
const statoP = p => STATI_P.some(s => s[0] === p.stato) ? p.stato : 'in_corso';
const STATI_F = { bozza: ['Bozza', 'b-gray'], inviata: ['Inviata', 'b-blue'], pagata: ['Pagata', 'b-green'], scaduta: ['Scaduta', 'b-red'] };
const CAT_S = { software: 'Software', abbonamento: 'Abbonamento', professionista: 'Professionista', previdenza: 'Previdenza', utenze: 'Utenze', altro: 'Altro' };
const FREQ = { mensile: ['Mensile', 12], trimestrale: ['Ogni 3 mesi', 4], semestrale: ['Ogni 6 mesi', 2], annuale: ['Annuale', 1], una_tantum: ['Una tantum', 0] };
const MESI = ['Gen','Feb','Mar','Apr','Mag','Giu','Lug','Ago','Set','Ott','Nov','Dic'];
const DEF_IMP = { nome: '', coefficiente: 0.78, aliquotaTasse: 0.15, aliquotaInps: 0.2607, limite: 85000,
  inpsTipo: 'separata', inpsFisso: 0, inpsMinimale: 0, inpsEccedenza: 0, deduciInps: true };
const INPS_TIPI = { separata: 'Gestione separata (percentuale)', fisso: 'Artigiani/commercianti, contributi fissi', ridotto: 'Artigiani/commercianti, contributi fissi ridotti (35%)' };
// stima di INPS, imposta e netto a partire dall'incassato "fiscale" (senza EXTRA)
function stimaTasse(incFisc) {
  const i = S.imp;
  const imponibile = incFisc * num(i.coefficiente);
  let inps;
  if (!i.inpsTipo || i.inpsTipo === 'separata') inps = imponibile * num(i.aliquotaInps);
  else {
    // contributi fissi annui + eventuale percentuale sulla parte di reddito oltre il minimale
    inps = num(i.inpsFisso);
    const min = num(i.inpsMinimale), ecc = num(i.inpsEccedenza);
    if (min > 0 && ecc > 0 && imponibile > min) inps += (imponibile - min) * ecc;
  }
  const base = i.deduciInps === false ? imponibile : Math.max(0, imponibile - inps);
  const tasse = base * num(i.aliquotaTasse);
  return { imponibile, inps, tasse, netto: Math.max(0, incFisc - tasse - inps) };
}
const COLLS = ['clienti', 'progetti', 'fatture', 'spese', 'task', 'note', 'cartelle'];

let db = null;
const S = { clienti: [], progetti: [], fatture: [], spese: [], task: [], note: [], cartelle: [], imp: { ...DEF_IMP } };
let tab = 'home';
let fattFilter = 'tutte';
let impSaved = false;
let bkNote = '';
try { tab = localStorage.getItem('tg_tab') || 'home'; } catch (e) {}
if (!TABS.some(t => t[0] === tab)) tab = 'home';

/* ---------- utils ---------- */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// importi scritti all'italiana: "1.500" = 1500, "1.500,50" = 1500.5, "12,5" = 12.5
const num = v => {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  let t = String(v ?? '').trim().replace(/[\s€]/g, '');
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = parseFloat(t); return isNaN(n) ? 0 : n;
};
// importi interi con il punto delle migliaia sempre (Intl it-IT su iPhone scrive "9650 €" senza punto sotto 10.000)
const euro = n => { const v = Math.round(Number(n) || 0); return (v < 0 ? '-' : '') + String(Math.abs(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '\u00a0€'; };
const isoLocale = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const todayISO = () => isoLocale(new Date());
const fmtD = iso => iso ? new Date(iso + 'T12:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
const daysTo = iso => Math.round((new Date(iso + 'T12:00:00') - new Date(todayISO() + 'T12:00:00')) / 864e5);
const cliente = id => S.clienti.find(c => c.id === id);
const cNome = id => cliente(id)?.nome || '—';
const byName = (a, b) => String(a.nome || a.titolo || '').localeCompare(String(b.nome || b.titolo || ''), 'it');
const year = new Date().getFullYear();

// una fattura può coprire più progetti: righe = [{ progettoId, importo }] (2 o più). Con un solo progetto resta progettoId e vale tutto l'importo.
const multiProgetto = f => Array.isArray(f.righe) && f.righe.length > 1;
const progettiFattura = f => multiProgetto(f) ? f.righe.map(r => r.progettoId).filter(Boolean) : (f.progettoId ? [f.progettoId] : []);
const quotaRiga = (f, pid) => { const r = (f.righe || []).find(x => x.progettoId === pid); return r ? num(r.importo) : 0; };
function fatturaDiProgetto(pid) { return S.fatture.find(f => progettiFattura(f).includes(pid)); }
function fattureDiProgetto(pid) { return S.fatture.filter(f => progettiFattura(f).includes(pid)); }
// quanto di una fattura appartiene a un progetto (per le fatture con più progetti: la sua riga)
const quotaFattura = (f, pid) => multiProgetto(f) ? quotaRiga(f, pid) : num(f.importo);
// importo che conta ai fini fiscali: esclude la parte fatturata da collaboratori (extra)
// EXTRA su fattura = spunta: l'intera fattura è di un collaboratore (conta nell'incassato, non nelle tasse)
// stato come lo vedi: una fattura inviata con la scadenza passata conta come scaduta (lo stato salvato non cambia)
const statoF = f => f.stato === 'inviata' && f.dataScadenza && daysTo(f.dataScadenza) < 0 ? 'scaduta' : f.stato;
const badgeF = f => { const k = statoF(f); return `<span class="badge ${STATI_F[k]?.[1] || 'b-gray'}">${STATI_F[k]?.[0] || esc(k)}</span>`; };
const isExtra = f => f.extra === true || (num(f.extra) > 0 && num(f.extra) >= num(f.importo));
const fiscale = f => isExtra(f) ? 0 : Math.max(0, num(f.importo) - (f.extra === true ? 0 : num(f.extra)));
// le fatture sopra 77,47€ includono 2€ di bollo: non vanno contati come lavoro fatturato
const senzaBollo = x => (x > 77.47 && Math.round(x) % 10 === 2) ? x - 2 : x;
// quanto Matteo ha fatturato su un progetto (esclusi EXTRA e bollo)
function fatturatoProgetto(p) { return fattureDiProgetto(p.id).reduce((s, f) => s + (multiProgetto(f) ? (isExtra(f) ? 0 : quotaRiga(f, p.id)) : (isExtra(f) ? 0 : Math.max(0, senzaBollo(num(f.importo)) - (f.extra === true ? 0 : num(f.extra))))), 0); }
// parte EXTRA già fatturata sul progetto (fatture EXTRA collegate, o quota EXTRA dentro una fattura)
function extraFatturatoProgetto(p) { return fattureDiProgetto(p.id).reduce((s, f) => s + (multiProgetto(f) ? (isExtra(f) ? quotaRiga(f, p.id) : 0) : (isExtra(f) ? senzaBollo(num(f.importo)) : (f.extra === true ? 0 : num(f.extra)))), 0); }
// quanto resta da fatturare: valore commessa − parte EXTRA (quella prevista nel progetto o quella già fatturata, la maggiore) − fatturato da Matteo.
// Così una fattura EXTRA collegata chiude il lavoro e conta una volta sola (tra le fatture da incassare), senza entrare nelle tasse.
function residuo(p) { if (statoP(p) === 'preventivo') return 0; const r = num(p.importo) - Math.max(num(p.extra), extraFatturatoProgetto(p)) - fatturatoProgetto(p); return r > 2.5 ? r : 0; } // tolleranza: arrotondamenti e i 2 € di bollo
function daFatturare() { return S.progetti.filter(p => p.stato === 'completato' && residuo(p) > 0); }
function dataIncasso(f) { return f.dataPagamento || f.dataEmissione || ''; }

/* ---------- db ops ---------- */
async function create(coll, data) { const ref = await db.collection(coll).add({ ...data, createdAt: new Date().toISOString() }); return ref && ref.id; }
async function put(coll, id, data) { const { id: _drop, ...body } = data; await db.doc(coll + '/' + id).set(body); }
async function remove(coll, id) { await db.doc(coll + '/' + id).delete(); }

/* ---------- tabs ---------- */
const ICONS = {
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
  note: '<path d="M6 3h9l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 9h4M9 13h6M9 17h6"/>',
  progetti: '<rect x="3" y="4" width="7" height="16" rx="2"/><rect x="14" y="4" width="7" height="10" rx="2"/>',
  fatture: '<path d="M6 2h9l4 4v16l-2.5-1.5L14 22l-2.5-1.5L9 22l-2.5-1.5L4 22V4a2 2 0 0 1 2-2z"/><path d="M8 9h8M8 13h8"/>',
  clienti: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
  spese: '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>',
  tasse: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-7 7"/><circle cx="9" cy="9" r="1.3"/><circle cx="15" cy="15" r="1.3"/>',
  impostazioni: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
};
const svgIcon = (k, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`;
const BURGER_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>';
const CLOSE_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/* tema chiaro / scuro: uguale su tutti i dispositivi (salvato nel database), ricordato anche in locale per aprire subito col tema giusto */
let tema = 'dark';
try { tema = localStorage.getItem('aldo_tema') === 'light' ? 'light' : 'dark'; } catch (e) {}
const I_SUN = '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
const I_MOON = '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/>';
const themeSwHTML = () => `${svgI(I_SUN)}<button type="button" role="switch" aria-checked="${tema === 'dark'}" aria-label="Tema scuro" title="Tema chiaro / scuro"></button>${svgI(I_MOON)}`;
function svgI(d) { return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`; }
function bindThemeSw(root) { (root || document).querySelectorAll('.themesw button').forEach(b => b.onclick = e => { e.stopPropagation(); setTema(tema === 'dark' ? 'light' : 'dark'); }); }
// stile pastello: un solo tema chiaro (il vecchio interruttore chiaro/scuro non c'è più)
function applyTema(t) {
  tema = 'light';
  document.documentElement.removeAttribute('data-aldo');
  try { localStorage.setItem('aldo_tema', tema); } catch (e) {}
  document.querySelectorAll('.themesw button').forEach(b => b.setAttribute('aria-checked', String(tema === 'dark')));
}
function setTema(t) { applyTema(t); if (db) db.doc('config/aspetto').set({ tema }).catch(() => {}); }

/* menu burger (mobile): elenco di tutte le sezioni, la testata resta sempre visibile */
function closeMenu() {
  document.querySelector('.menu-ov')?.remove();
  const b = document.getElementById('burger');
  if (b) { b.innerHTML = BURGER_SVG; b.setAttribute('aria-expanded', 'false'); b.setAttribute('aria-label', 'Apri il menu'); }
}
function toggleMenu() {
  if (document.querySelector('.menu-ov')) return closeMenu();
  const ov = document.createElement('div'); ov.className = 'menu-ov';
  ov.innerHTML = `<div class="menu" role="menu">${TABS.map(([k, l]) =>
    k === 'impostazioni'
      ? `<div class="sep"></div><button type="button" role="menuitem" data-tab="${k}" ${k === tab ? 'aria-current="page"' : ''}>${svgIcon(k)}${esc(l)}</button>`
      : `<button type="button" role="menuitem" data-tab="${k}" ${k === tab ? 'aria-current="page"' : ''}>${svgIcon(k)}${esc(l)}</button>`).join('')}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeMenu(); });
  ov.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => goTab(b.dataset.tab));
  bindThemeSw(ov);
  const b = document.getElementById('burger');
  b.innerHTML = CLOSE_SVG; b.setAttribute('aria-expanded', 'true'); b.setAttribute('aria-label', 'Chiudi il menu');
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
let kCol = 'in_corso';
let fattQuery = '';
let clientiQuery = '';
let showDone = false; // Dashboard: mostra anche i task già completati
let invStop = null; // ascolto degli inviti (Impostazioni, solo amministratore)
let prevTab = 'home'; // sezione da cui si è arrivati alle Impostazioni (per il tasto Indietro)
function goTab(t) {
  if (tab === 'note' && t !== 'note') lasciaNota();
  if (t === 'impostazioni' && tab !== 'impostazioni') prevTab = tab;
  tab = t; try { localStorage.setItem('tg_tab', tab); } catch (e) {}
  try { document.activeElement && document.activeElement.blur && document.activeElement.blur(); } catch (e) {}
  closeMenu(); closeAltro();
  render(); window.scrollTo(0, 0); document.querySelector('.wrap').scrollTop = 0;
}
const goBack = () => goTab(prevTab && prevTab !== 'impostazioni' ? prevTab : 'home');
const BACK_BTN = '<button type="button" class="back" data-back aria-label="Torna indietro"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>Indietro</button>';
function actionSheet() {
  openSheet('Aggiungi', [
    ['Nuovo progetto', () => formProgetto(null)], ['Nuova fattura', () => formFattura(null)],
    ['Nuovo cliente', () => formCliente(null)], ['Nuova spesa', () => formSpesa(null)],
    ['Nuova nota', () => nuovaNota()],
    ['Nuovo task', () => { goTab('home'); setTimeout(() => { const i = document.querySelector('#task-box .task-add input'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus({ preventScroll: true }); } }, 60); }],
  ]);
}
// descrizione breve di una fattura: prima riga della nota, altrimenti il progetto collegato
function descrFatt(f) {
  const n = String(f.note || '').split('\n').map(x => x.trim()).find(Boolean);
  if (n) return n.length > 60 ? n.slice(0, 58) + '…' : n;
  const ids = progettiFattura(f), p = ids[0] && S.progetti.find(x => x.id === ids[0]);
  return p ? p.titolo + (ids.length > 1 ? ` + ${ids.length - 1} ${ids.length === 2 ? 'progetto' : 'progetti'}` : '') : '';
}
// dettaglio di una voce del riepilogo "Da fatturare e incassare": cliente e importo, tocchi una riga e si apre
function dettaglioRiepilogo(k) {
  let titolo, righe;
  const cl = id => cliente(id) ? cNome(id) : '';
  const byImp = (a, b) => b.v - a.v;
  if (k === 'lav') {
    titolo = 'Lavori da fatturare';
    righe = S.progetti.filter(p => residuo(p) > 0).map(p => ({ c: cl(p.clienteId) || p.titolo, s: cl(p.clienteId) ? p.titolo : '', v: residuo(p), open: () => formProgetto(p) })).sort(byImp);
  } else {
    const fs = S.fatture.filter(f => k === 'boz' ? f.stato === 'bozza' : (f.stato === 'inviata' || f.stato === 'scaduta'));
    titolo = k === 'boz' ? 'Fatture in bozza' : 'Fatture da incassare';
    righe = fs.map(f => ({ c: cl(f.clienteId) || (f.numero ? 'Fattura n. ' + f.numero : 'Senza cliente'), s: descrFatt(f), v: num(f.importo), open: () => formFattura(f) })).sort(byImp);
  }
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet small dsheet" role="dialog" aria-label="${esc(titolo)}"><h3><span class="ttl">${esc(titolo)}</span><button type="button" class="xclose" data-a="x" aria-label="Chiudi">✕</button></h3>
    <div class="dlist">${righe.length ? righe.map((r, i) => `<div class="row" data-i="${i}" tabindex="0" role="button"><div class="main"><div class="ttl">${esc(r.c)}</div>${r.s ? `<div class="sub">${esc(r.s)}</div>` : ''}</div><span class="amt">${euro(r.v)}</span></div>`).join('') : '<div class="empty">Niente in questa voce.</div>'}</div>
    ${righe.length ? `<div class="dtot"><span>Totale</span><b>${euro(righe.reduce((s, r) => s + r.v, 0))}</b></div>` : ''}</div>`;
  document.body.appendChild(ov);
  const onKey = e => { if (e.key === 'Escape') close(); };
  // chiudendo si ridisegna (se nel frattempo sono arrivati dati nuovi la Dashboard si aggiorna)
  function close(ridisegna = true) { ov.remove(); document.removeEventListener('keydown', onKey); if (ridisegna) render(); }
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.querySelector('[data-a="x"]').onclick = () => close();
  ov.querySelectorAll('[data-i]').forEach(r => bindOpen(r, () => { close(false); righe[+r.dataset.i].open(); }));
}
// Incassato dell'anno diviso tra quello fatturato da Matteo e quello EXTRA (collaboratori)
function dettaglioIncassato(tot, tuo) {
  const extra = Math.max(0, tot - tuo);
  const pc = x => tot > 0 ? Math.round(x / tot * 100) + '%' : '0%';
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet small dsheet" role="dialog" aria-label="Incassato ${year}"><h3><span class="ttl">Incassato ${year}</span><button type="button" class="xclose" data-a="x" aria-label="Chiudi">✕</button></h3>
    <div class="itot">
      <div><div class="il"><i style="background:var(--lilla)"></i>Fatturato da te</div><div class="iv"><b>${euro(tuo)}</b><span>${pc(tuo)}</span></div><div class="ih">Conta per tasse e limite forfettario.</div></div>
      <div><div class="il"><i style="background:var(--rosa)"></i>EXTRA</div><div class="iv"><b>${euro(extra)}</b><span>${pc(extra)}</span></div><div class="ih">Fatturato per conto di collaboratori: fuori da tasse e limite.</div></div>
    </div>
    <div class="dtot"><span>Totale incassato</span><b>${euro(tot)}</b></div></div>`;
  document.body.appendChild(ov);
  const onKey = e => { if (e.key === 'Escape') close(); };
  function close() { ov.remove(); document.removeEventListener('keydown', onKey); render(); }
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.querySelector('[data-a="x"]').onclick = close;
}
function openSheet(title, items) {
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="sheet small"><h3><span class="ttl">${esc(title)}</span></h3><div class="asheet">${items.map((it, i) => `<button type="button" data-i="${i}">${esc(it[0])}</button>`).join('')}</div>
    <div class="actions"><span class="spacer"></span><button type="button" class="btn ghost" data-a="cancel">Annulla</button></div></div>`;
  document.body.appendChild(ov);
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = (ridisegna = true) => { ov.remove(); document.removeEventListener('keydown', onKey); if (ridisegna) renderQuandoLibero(); };
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.querySelector('[data-a="cancel"]').onclick = () => close();
  ov.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { close(false); items[+b.dataset.i][1](); });
}
function renderChrome() {
  // il burger si costruisce una sola volta (niente sfarfallio ad ogni sincronizzazione)
  const bg = document.getElementById('burger');
  if (!bg.dataset.ready) { bg.dataset.ready = '1'; bg.innerHTML = BURGER_SVG; bg.onclick = toggleMenu; }
  document.getElementById('brand').onclick = () => goTab('home');
  const fab = document.getElementById('fab');
  const act = { home: actionSheet, note: () => nuovaNota(), progetti: () => formProgetto(null), fatture: () => formFattura(null), clienti: () => formCliente(null), spese: () => formSpesa(null) }[tab];
  fab.hidden = !act || (tab === 'note' && notePane === 'note'); fab.onclick = act || null;
  const tai = document.getElementById('top-ai'); if (tai) { tai.hidden = !aiFn; tai.onclick = apriAI; }
  renderBnav(act);
}
/* barra di navigazione del telefono, fissa in alto sotto il logo (in basso nell'app Claude su iPhone finirebbe fuori schermo) */
const ALTRO = ['tasse', 'clienti', 'spese', 'impostazioni'];
const I_DOTS = '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>';
function renderBnav(act) {
  const el = document.getElementById('bnav'); if (!el) return;
  const nome = k => TABS.find(t => t[0] === k)[1];
  const cnt = { progetti: S.progetti.filter(p => p.stato !== 'completato').length, fatture: S.fatture.filter(f => f.stato === 'inviata' || f.stato === 'scaduta').length };
  const it = k => `<button type="button" class="bn-it" data-tab="${k}" ${k === tab ? 'aria-current="page"' : ''}>${svgIcon(k, 22)}<span>${nome(k)}</span>${cnt[k] ? `<em class="bn-n">${cnt[k]}</em>` : ''}</button>`;
  el.innerHTML = `${it('home')}${it('progetti')}${it('fatture')}${it('note')}`;
  // "Altro" sta in testata accanto al +: sempre visibile, si riempie quando sei in una delle sue sezioni
  const altro = document.getElementById('bn-altro');
  if (altro) { if (ALTRO.includes(tab)) altro.setAttribute('aria-current', 'page'); else altro.removeAttribute('aria-current'); }
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { closeAltro(); goTab(b.dataset.tab); });
  const add = document.getElementById('top-add');
  if (add) add.onclick = () => { closeAltro(); (act || actionSheet)(); };
  if (altro) altro.onclick = toggleAltro;
  // la voce attiva resta sempre visibile anche se la riga di pillole scorre
  const att = el.querySelector('[aria-current="page"]');
  if (att) requestAnimationFrame(() => { if (att.offsetLeft + att.offsetWidth > el.clientWidth - 8) el.scrollLeft = att.offsetLeft - 16; });
}
function closeAltro() { document.querySelector('.alt-ov')?.remove(); }
function toggleAltro() {
  if (document.querySelector('.alt-ov')) return closeAltro();
  document.querySelector('.toast')?.remove();
  const ov = document.createElement('div'); ov.className = 'alt-ov';
  ov.innerHTML = `<div class="menu alt" role="menu">${ALTRO.map(k => `<button type="button" role="menuitem" data-tab="${k}" ${k === tab ? 'aria-current="page"' : ''}>${svgIcon(k)}${esc(TABS.find(t => t[0] === k)[1])}</button>`).join('')}</div>`;
  document.body.appendChild(ov);
  ov.addEventListener('click', e => { if (e.target === ov) closeAltro(); });
  ov.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => { closeAltro(); goTab(b.dataset.tab); });
  bindThemeSw(ov);
}
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAltro(); });

/* barra laterale (da computer): aperta con icona + nome, o ridotta a sole icone. Sotto 1100px parte sempre ridotta. */
const SIDE_MQ = matchMedia('(max-width: 1100px)');
let sideMin = false;
try { sideMin = localStorage.getItem('aldo_side') === 'min'; } catch (e) {}
const sideRidotta = () => sideMin || SIDE_MQ.matches;
function applySide() { document.documentElement.classList.toggle('side-min', sideRidotta()); }
SIDE_MQ.addEventListener('change', () => { applySide(); renderSide(); });
const CHEV_L = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 17l-5-5 5-5M18 17l-5-5 5-5"/></svg>';
const CHEV_R = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 17l5-5-5-5M6 17l5-5-5-5"/></svg>';
function renderSide() {
  const el = document.getElementById('side'); if (!el) return;
  const item = ([k, l]) => `<button type="button" class="side-item" data-tab="${k}" data-label="${esc(l)}" aria-label="${esc(l)}" ${k === tab ? 'aria-current="page"' : ''}>${svgIcon(k, 20)}<span>${esc(l)}</span></button>`;
  el.innerHTML = `
    <div class="side-top">
      <button type="button" class="side-brand" id="side-brand" aria-label="Vai alla Dashboard"><b><span class="full">ALDO</span><span class="short">A</span><i>.</i></b><small>TRAINGRAPHIC</small></button>
      ${SIDE_MQ.matches ? '' : `<button type="button" class="side-col" id="side-col" aria-label="${sideMin ? 'Apri la barra' : 'Riduci la barra'}" title="${sideMin ? 'Apri la barra' : 'Riduci la barra'}">${sideMin ? CHEV_R : CHEV_L}</button>`}
    </div>
    ${aiFn ? `<button type="button" class="side-ai" id="side-ai" data-label="Parla con Aldo" aria-label="Parla con Aldo"><span class="st">✦</span><span>Parla con Aldo</span></button>` : ''}
    <nav class="side-nav">${TABS.filter(t => t[0] !== 'impostazioni').map(item).join('')}</nav>
    <div class="side-bottom">
      <button type="button" class="side-add" id="side-add" data-label="Aggiungi" aria-label="Aggiungi"><span class="pl">+</span><span>Aggiungi</span></button>
      <div class="side-sep"></div>
      ${item(TABS.find(t => t[0] === 'impostazioni'))}
    </div>`;
  el.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => goTab(b.dataset.tab));
  el.querySelector('#side-brand').onclick = () => goTab('home');
  el.querySelector('#side-add').onclick = actionSheet;
  const sai = el.querySelector('#side-ai'); if (sai) sai.onclick = apriAI;
  const col = el.querySelector('#side-col');
  if (col) col.onclick = () => { sideMin = !sideMin; try { localStorage.setItem('aldo_side', sideMin ? 'min' : ''); } catch (e) {} applySide(); renderSide(); };
  bindThemeSw(el);
}
function renderTabs() {
  renderChrome();
  applySide();
  renderSide();
}

function render() {
  renderTabs();
  const v = document.getElementById('view');
  ({ home: vHome, note: vNote, progetti: vProgetti, fatture: vFatture, tasse: vTasse, clienti: vClienti, spese: vSpese, impostazioni: vImp })[tab](v);
}

/* ---------- PANORAMICA ---------- */
// icone della Dashboard (stesso stile di quelle del menu)
const DI = {
  wallet: '<rect x="3" y="6" width="18" height="13" rx="2.5"/><path d="M3 10h18M16 14.5h2"/><path d="M6 6l9-3 1 3"/>',
  alarm: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M5 3 2 6M19 3l3 3"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
  bank: '<path d="M3 10 12 4l9 6"/><path d="M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18"/>',
  task: '<rect x="3" y="3" width="18" height="18" rx="4.5"/><path d="M8 12.5l3 3 5-6"/>',
  cal: '<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/>',
  bars: '<path d="M5 20V11M10 20V5M15 20v-8M20 20v-5"/>',
};
// scheda pastello della Dashboard (colore, voce, importo, etichetta, sottotitolo; n = 0 la rende non cliccabile)
const WAVES = ['M0 40 C 25 10, 45 12, 62 28 S 95 50, 112 34 S 140 8, 160 30 S 185 44, 200 18 L200 56 L0 56Z', 'M0 36 C 22 18, 40 16, 60 30 S 92 52, 115 36 S 145 12, 165 34 S 188 40, 200 14 L200 56 L0 56Z', 'M0 34 C 20 14, 42 14, 64 30 S 96 50, 118 36 S 146 14, 166 32 S 190 42, 200 20 L200 56 L0 56Z', 'M0 38 C 24 14, 44 16, 64 30 S 98 50, 120 34 S 148 10, 168 30 S 190 44, 200 16 L200 56 L0 56Z'];
const PC_COL = ['lilla', 'rosa', 'giallo', 'verde'];
function pcard(col, k, val, label, sub, n) {
  const w = WAVES[PC_COL.indexOf(col)] || WAVES[0];
  return `<div class="pcard pc-${col}${n ? '' : ' off'}" data-seg="${k}" ${n ? `role="button" tabindex="0" aria-label="${esc(label)}: vedi il dettaglio"` : ''}>
    <div class="pv">${euro(val)}</div><div class="pl">${esc(label)}</div><div class="ps">${sub}</div>
    ${n ? `<span class="pdots" aria-hidden="true"><svg width="14" height="4" viewBox="0 0 14 4"><circle cx="2" cy="2" r="1.6"/><circle cx="7" cy="2" r="1.6"/><circle cx="12" cy="2" r="1.6"/></svg></span>` : ''}
    <svg class="pwave" viewBox="0 0 200 56" preserveAspectRatio="none" aria-hidden="true"><path d="${w}"/></svg></div>`;
}
const scalaK = x => x >= 1000 ? (Math.round(x / 100) / 10).toString().replace('.', ',') + 'k' : String(Math.round(x));
let meseSel = null; // mese scelto nel grafico "Incassato mese per mese" (null = mese migliore)
function vHome(v) {
  const h = new Date().getHours();
  // saluto amichevole: Buongiorno fino alle 17, poi Buonasera; tra mezzanotte e le 5 un tocco ironico
  const sottotitolo = h < 5 ? 'Ancora sveglio? Ecco come stanno andando le cose.' : (h < 17 ? 'Buongiorno!' : 'Buonasera!') + ' Ecco come stanno andando le cose.';
  const imp = S.imp;
  const fAnno = S.fatture.filter(f => f.stato !== 'bozza');
  const pagateAnno = fAnno.filter(f => f.stato === 'pagata' && dataIncasso(f).startsWith(String(year)));
  const incassatoTot = pagateAnno.reduce((s, f) => s + num(f.importo), 0);
  const incassato = pagateAnno.reduce((s, f) => s + fiscale(f), 0);
  const daIncassare = S.fatture.filter(f => f.stato === 'inviata' || f.stato === 'scaduta');
  const totDaInc = daIncassare.reduce((s, f) => s + num(f.importo), 0);
  // lavori (in qualsiasi stato) con una parte ancora da fatturare
  const aperti = S.progetti.filter(p => residuo(p) > 0);
  const totLavori = aperti.reduce((s, p) => s + residuo(p), 0);
  // bozze: fatture preparate ma non ancora inviate (non contano per tasse e fatturato, ma sono soldi in arrivo)
  const bozze = S.fatture.filter(f => f.stato === 'bozza');
  const totBoz = bozze.reduce((s, f) => s + num(f.importo), 0);
  const totDF = totLavori + totBoz + totDaInc;
  const scadute = S.fatture.filter(f => f.stato === 'scaduta' || (f.stato === 'inviata' && f.dataScadenza && daysTo(f.dataScadenza) < 0));
  const totScad = scadute.reduce((s, f) => s + num(f.importo), 0);
  const st = stimaTasse(incassato), inps = st.inps, tasse = st.tasse;
  const costiAnno = speseCommesseAnno(year);
  const netto = Math.max(0, st.netto - costiAnno); // quello che resta dopo tasse, INPS e spese delle commesse
  const limite = num(imp.limite) || 85000;
  const pct = Math.min(100, incassato / limite * 100);
  const limColor = pct >= 90 ? 'var(--red)' : pct >= 75 ? 'var(--orange)' : 'var(--accent-text)';
  const attivi = S.progetti.filter(p => p.stato === 'in_corso' || p.stato === 'in_revisione');
  const incMesi = Array(12).fill(0), extraMesi = Array(12).fill(0);
  S.fatture.forEach(f => { if (f.stato === 'pagata' && dataIncasso(f).startsWith(String(year))) { const m = +dataIncasso(f).slice(5, 7) - 1; incMesi[m] += num(f.importo); extraMesi[m] += num(f.importo) - fiscale(f); } });
  const incExtra = incassatoTot - incassato;
  const maxMese = Math.max(...incMesi, 1), meseOra = new Date().getMonth();
  // grafico: scala "tonda" e mese migliore per il fumetto
  const maxParte = Math.max(...incMesi.map((x, i) => Math.max(x - extraMesi[i], extraMesi[i])), 1);
  const passo = maxParte > 6000 ? 3000 : maxParte > 3000 ? 2000 : 1000;
  const maxY = Math.ceil(maxParte / passo) * passo;
  const meseTop = incMesi.indexOf(Math.max(...incMesi));
  // prossimo pagamento fiscale (stessa logica della pagina Tasse)
  const futF = pianoFiscale('aperte').filter(e => e.d >= todayISO());
  const prossimo = [...new Set(futF.map(e => e.d))].map(dd => { const items = futF.filter(e => e.d === dd); return { d: dd, items, tot: items.reduce((x, e) => x + e.v, 0) }; }).find(g => g.tot > 0);


  v.innerHTML = `
    <div class="page-head"><div>
      <h1>Ehy${imp.nome ? ', ' + esc(imp.nome) : ''}.</h1>
      <div class="lede">${sottotitolo}</div>
    </div></div>

    <div class="quick" role="group" aria-label="Azioni rapide">
      <button type="button" data-q="progetto"><span class="pl">+</span><span class="lungo">Nuovo progetto</span><span class="corto">Progetto</span></button>
      <button type="button" data-q="fattura"><span class="pl">+</span><span class="lungo">Nuova fattura</span><span class="corto">Fattura</span></button>
      <button type="button" data-q="task"><span class="pl">+</span><span class="lungo">Nuovo task</span><span class="corto">Task</span></button>
    </div>

    <div class="dash">
      <div class="dcol dfin">
        <div class="sec-h"><h2>Da fatturare e incassare</h2><span>${euro(totDF)}</span></div>
        <div class="pgrid">
          ${pcard('lilla', 'lav', totLavori, 'Lavori da fatturare', aperti.length ? `${aperti.length} ${aperti.length === 1 ? 'progetto' : 'progetti'}` : 'nessuno', aperti.length)}
          ${pcard('rosa', 'boz', totBoz, 'Fatture in bozza', bozze.length ? `${bozze.length} ${bozze.length === 1 ? 'fattura' : 'fatture'}` : 'nessuna', bozze.length)}
          ${pcard('giallo', 'inc', totDaInc, 'Da incassare', `${daIncassare.length} ${daIncassare.length === 1 ? 'fattura' : 'fatture'} · ${scadute.length ? `<b class="pc-red">${scadute.length} ${scadute.length === 1 ? 'scaduta' : 'scadute'} (${euro(totScad)})</b>` : '0 scadute'}`, daIncassare.length)}
          ${pcard('verde', 'incassato', incassatoTot, 'Incassato ' + year, incExtra > 0 ? `${euro(incassato)} fatturati da te` : `${attivi.length} progetti attivi`, 1)}
        </div>
        <div class="panel">
          <h2>Incassato mese per mese</h2>
          <div class="mchart" role="img" aria-label="Incassato mese per mese: parte tua ed EXTRA">
            <div class="m-y">${[1, 2 / 3, 1 / 3, 0].map(f => `<span>${scalaK(maxY * f)}</span>`).join('')}</div>
            <div class="m-plot">
              <div class="m-grid"><i></i><i></i><i></i><i></i></div>
              <div class="m-bars">${incMesi.map((x, i) => { const tuo = x - extraMesi[i]; return `<div class="m-col${i > meseOra ? ' fut' : ''}" data-m="${i}" role="button" tabindex="0" aria-label="${MESI_L[i]}: ${euro(x)}${extraMesi[i] > 0 ? ', di cui EXTRA ' + euro(extraMesi[i]) : ''}">${x > 0 ? `<i class="m1" style="height:${tuo / maxY * 100}%"></i><i class="m2" style="height:${extraMesi[i] > 0 ? Math.max(2, extraMesi[i] / maxY * 100) : 0}%"></i>` : ''}</div>`; }).join('')}</div>
              <div class="m-x">${MESI.map(m => `<span>${m[0]}</span>`).join('')}</div>
            </div>
          </div>
          <div class="m-leg"><span><i class="m1"></i>Fatturato da te</span><span><i class="m2"></i>EXTRA</span></div>
        </div>
        <div class="duo">
          <div class="obox clic" id="tax-card" role="button" tabindex="0" aria-label="Tasse + INPS: apri scadenze e pagamenti">
            <div class="ot">Tasse + INPS ${year}<span class="chev" aria-hidden="true">›</span></div>
            <div class="ov">${euro(tasse + inps)}</div>
            <span class="chip2 ch-verde">${Math.round(quotaAccantona('incassato') * 100)}% da parte</span>
            <div class="os">ti restano ${euro(netto)}</div>
          </div>
          <div class="obox">
            <div class="ot">Limite forfettario</div>
            <div class="ov" style="color:${limColor}">${Math.round(pct)}%</div>
            <span class="chip2 ${pct >= 90 ? 'ch-rossa' : pct >= 75 ? 'ch-gialla' : 'ch-lilla'}">mancano ${euro(Math.max(0, limite - incassato))}</span>
            <div class="os">su ${euro(limite)}</div>
          </div>
        </div>
        ${prossimo ? `<div class="paystrip" id="pay-card" role="button" tabindex="0" aria-label="Prossimo pagamento: apri la pagina Tasse">
          <div class="pd"><b>${+prossimo.d.slice(8, 10)}</b><span>${MESI[+prossimo.d.slice(5, 7) - 1]}</span></div>
          <div class="pm"><div>Prossimo pagamento</div><strong>${esc(prossimo.items.length === 1 ? prossimo.items[0].label : prossimo.items.length + ' voci (F24)')}</strong></div>
          <div class="pa">${euro(prossimo.tot)}</div></div>` : ''}
      </div>
      <div class="dcol dops">
        <div class="panel dtask">
          <h2>${ic(DI.task, 18)}Lista task <span class="aside" id="task-count"></span></h2>
          <div id="task-box"></div>
        </div>
        <div class="panel">
          <h2>${ic(DI.cal, 18)}Agenda<span class="aside">prossimi 7 giorni</span></h2>
          <div id="agenda"></div>
        </div>
        <div class="panel">
          <h2>${ic(ICONS.note, 18)}Ultime note<span class="aside">${S.note.length ? `<button type="button" class="lnk" id="all-notes">Vedi tutte (${S.note.length})</button>` : ''}</span></h2>
          <div class="rows" id="last-notes">${S.note.length ? noteOrdinate().slice(0, 4).map(rigaNota).join('') : '<div class="empty-act"><p>Nessuna nota. Appuntati riunioni, idee e lavori nuovi.</p><button type="button" class="btn ghost sm" id="empty-nota">+ Nuova nota</button></div>'}</div>
        </div>
      </div>
    </div>`;

  renderAgenda(v.querySelector('#agenda'));
  renderTasks(v.querySelector('#task-box'), null);
  const QA = {
    progetto: () => formProgetto(null), fattura: () => formFattura(null),
    cliente: () => formCliente(null), spesa: () => formSpesa(null), nota: () => nuovaNota(),
    task: () => {
      const inp = v.querySelector('#task-box .task-add input');
      if (!inp) return;
      inp.scrollIntoView({ behavior: 'smooth', block: 'center' });
      inp.focus({ preventScroll: true });
    },
  };
  v.querySelectorAll('.quick [data-q]').forEach(b => b.onclick = () => QA[b.dataset.q]());
  bindNoteRows(v.querySelector('#last-notes'));
  v.querySelectorAll('.pcard[data-seg]:not(.off)').forEach(b => bindOpen(b, () => b.dataset.seg === 'incassato' ? dettaglioIncassato(incassatoTot, incassato) : dettaglioRiepilogo(b.dataset.seg)));
  bindOpen(v.querySelector('#tax-card'), () => goTab('tasse'));
  const pc = v.querySelector('#pay-card'); if (pc) bindOpen(pc, () => goTab('tasse'));
  // grafico interattivo: toccando un mese il fumetto mostra totale, parte tua ed EXTRA
  const mostraMese = (i, scelto) => {
    const box = v.querySelector('.m-bars'); if (!box) return;
    box.querySelector('.m-tip')?.remove();
    box.classList.toggle('sel', !!scelto);
    box.querySelectorAll('.m-col').forEach(c => { const on = +c.dataset.m === i; c.classList.toggle('on', on); c.setAttribute('aria-pressed', String(on && !!scelto)); });
    const col = box.querySelector(`.m-col[data-m="${i}"]`); if (!col) return;
    const x = incMesi[i], ex = extraMesi[i], tuo = x - ex;
    const tip = document.createElement('span'); tip.className = 'm-tip';
    tip.style.bottom = `calc(${Math.max(tuo, ex, 0) / maxY * 100}% + 10px)`;
    tip.innerHTML = x > 0 ? `<b>${MESI_L[i]} · ${euro(x)}</b>${ex > 0 ? `<small>tuo ${euro(tuo)} · EXTRA ${euro(ex)}</small>` : ''}` : `<b>${MESI_L[i]}</b><small>nessun incasso</small>`;
    col.appendChild(tip);
  };
  if (incMesi[meseTop] > 0) mostraMese(meseSel ?? meseTop, meseSel != null);
  v.querySelectorAll('.m-col').forEach(c => bindOpen(c, () => {
    const i = +c.dataset.m;
    meseSel = meseSel === i ? null : i; // secondo tocco sullo stesso mese: torna al mese migliore
    mostraMese(meseSel ?? meseTop, meseSel != null);
  }));
  const an = v.querySelector('#all-notes'); if (an) an.onclick = () => goTab('note');
  const en = v.querySelector('#empty-nota'); if (en) en.onclick = () => nuovaNota();
  const ag = v.querySelector('#agenda'); if (ag) ag.addEventListener('click', e => { if (e.target.closest('#ag-more')) { agendaTutta = !agendaTutta; renderAgenda(ag); } });
  const open = S.task.filter(t => !t.completato).length;
  const nDone = S.task.length - open;
  const tc = v.querySelector('#task-count');
  tc.innerHTML = S.task.length ? `${open} da fare${nDone ? ` · <button type="button" class="lnk" id="toggle-done">${showDone ? 'Nascondi' : 'Mostra'} fatti (${nDone})</button>` : ''}` : '';
  const td = tc.querySelector('#toggle-done'); if (td) td.onclick = () => { showDone = !showDone; render(); };
}

/* ---------- TASSE: scadenzario fiscale ---------- */
// Stima di imposta e contributi per anno, calendario dei pagamenti (F24) e quanto accantonare.
// Regole usate (forfettario):
// - imposta sostitutiva: saldo e 1° acconto il 30/6, 2° acconto il 30/11. Acconto = 100% dell'imposta dell'anno prima,
//   metà e metà (sotto 257,52 € tutto a novembre, sotto 51,65 € niente acconto)
// - INPS artigiani/commercianti: contributi fissi in 4 rate (16/5, 20/8, 16/11 e 16/2 dell'anno dopo);
//   la parte oltre il minimale va a saldo e acconto come l'imposta
// - INPS gestione separata: tutto variabile, acconto 80% (40% + 40%)
let tasseScen = 'aperte'; // 'aperte' = incassato + fatture da incassare · 'incassato' = solo incassato a oggi
// incassato "fiscale" (senza EXTRA) di un anno; per l'anno in corso a richiesta anche le fatture inviate/scadute
function incTuoAnno(y, conAperte) {
  const Y = String(y);
  let t = S.fatture.filter(f => f.stato === 'pagata' && dataIncasso(f).startsWith(Y)).reduce((s, f) => s + fiscale(f), 0);
  if (conAperte) t += S.fatture.filter(f => f.stato === 'inviata' || f.stato === 'scaduta').reduce((s, f) => s + fiscale(f), 0);
  return t;
}
const inpsFissoAnnuo = () => (!S.imp.inpsTipo || S.imp.inpsTipo === 'separata') ? 0 : num(S.imp.inpsFisso);
// imposta e INPS variabile (oltre il minimale, o tutta la gestione separata) di un anno, se si possono sapere
function fiscoAnno(yr, scen) {
  const i = S.imp;
  if (yr === year) {
    const inc = incTuoAnno(year, scen === 'aperte');
    const st = stimaTasse(inc);
    return { inc, imposta: st.tasse, inpsVar: Math.max(0, st.inps - inpsFissoAnnuo()), inps: st.inps, imponibile: st.imponibile, stima: true };
  }
  // anno scorso scritto a mano in Impostazioni (es. il 2025, quando l'imposta era al 5%)
  const scritto = x => x !== undefined && x !== null && x !== '';
  if (num(i.prevAnno) === yr && (scritto(i.prevImposta) || scritto(i.prevInpsVar))) {
    // il campo lasciato vuoto si stima dagli incassi di quell'anno registrati in ALDO
    const incP = incTuoAnno(yr, false), stP = incP > 0 ? stimaTasse(incP) : null;
    return { imposta: scritto(i.prevImposta) ? num(i.prevImposta) : (stP ? stP.tasse : 0),
      inpsVar: scritto(i.prevInpsVar) ? num(i.prevInpsVar) : (stP ? Math.max(0, stP.inps - inpsFissoAnnuo()) : 0), manuale: true };
  }
  // altrimenti dai dati di ALDO, se in quell'anno ci sono incassi
  const inc = incTuoAnno(yr, false);
  if (inc > 0) { const st = stimaTasse(inc); return { inc, imposta: st.tasse, inpsVar: Math.max(0, st.inps - inpsFissoAnnuo()), stima: true }; }
  return null;
}
function accontiImposta(base) {
  if (!(base >= 51.65)) return [0, 0];
  if (base <= 257.52) return [0, base];
  return [base / 2, base / 2];
}
function accontiInps(base) {
  const pct = (!S.imp.inpsTipo || S.imp.inpsTipo === 'separata') ? 0.8 : 1;
  return base > 0 ? [base * pct / 2, base * pct / 2] : [0, 0];
}
// tutte le uscite fiscali degli anni year e year+1 (anche quelle già passate: servono per i totali)
function pianoFiscale(scen) {
  const ev = [];
  const fisso = inpsFissoAnnuo(), sep = !S.imp.inpsTipo || S.imp.inpsTipo === 'separata';
  const nomeVar = sep ? 'INPS gestione separata' : 'INPS oltre il minimale';
  const add = (d, label, v, comp, tipo) => { if (Math.abs(v) >= 0.5) ev.push({ d, label, v, comp, tipo }); };
  const fa = yr => fiscoAnno(yr, scen);
  for (const yr of [year, year + 1]) {
    if (fisso > 0) {
      add(`${yr}-02-16`, `4ª rata INPS fissi ${yr - 1}`, fisso / 4, yr - 1, 'inps');
      add(`${yr}-05-16`, `1ª rata INPS fissi ${yr}`, fisso / 4, yr, 'inps');
      add(`${yr}-08-20`, `2ª rata INPS fissi ${yr}`, fisso / 4, yr, 'inps');
      add(`${yr}-11-16`, `3ª rata INPS fissi ${yr}`, fisso / 4, yr, 'inps');
    }
    const prev = fa(yr - 1), prev2 = fa(yr - 2);
    // saldo dell'anno prima = dovuto − acconti versati (calcolati sull'anno ancora prima)
    if (prev) {
      // se manca l'anno ancora prima si assume che non siano stati versati acconti: il saldo è tutto il dovuto
      const [i1, i2] = prev2 ? accontiImposta(prev2.imposta) : [0, 0], [v1, v2] = prev2 ? accontiInps(prev2.inpsVar) : [0, 0];
      add(`${yr}-06-30`, `Saldo imposta ${yr - 1}`, prev.imposta - i1 - i2, yr - 1, 'imposta');
      add(`${yr}-06-30`, `Saldo ${nomeVar} ${yr - 1}`, prev.inpsVar - v1 - v2, yr - 1, 'inps');
    }
    if (prev) {
      const [i1, i2] = accontiImposta(prev.imposta), [v1, v2] = accontiInps(prev.inpsVar);
      add(`${yr}-06-30`, `1° acconto imposta ${yr}`, i1, yr, 'imposta');
      add(`${yr}-06-30`, `1° acconto ${nomeVar} ${yr}`, v1, yr, 'inps');
      add(`${yr}-11-30`, `2° acconto imposta ${yr}`, i2, yr, 'imposta');
      add(`${yr}-11-30`, `2° acconto ${nomeVar} ${yr}`, v2, yr, 'inps');
    }
  }
  return ev.sort((a, b) => a.d.localeCompare(b.d));
}
// quota da mettere da parte su ogni incasso tuo (imposta + INPS dell'anno / incassato tuo)
function quotaAccantona(scen) {
  const f = fiscoAnno(year, scen || tasseScen);
  return f && f.inc > 0 ? Math.min(0.6, (f.imposta + f.inps) / f.inc) : 0;
}
// undo: funzione che riporta la fattura com'era (dal tasto rapido "✓ Pagata")
function avvisoAccantona(f, undo) {
  const q = quotaAccantona('aperte'), v = fiscale(f) * q;
  const az = undo ? { label: 'Annulla', fn: undo } : null;
  if (v >= 1) toast(`Incassati ${euro(num(f.importo))}: metti da parte ${euro(v)} per tasse e INPS (${Math.round(q * 100)}%).`, az);
  else if (isExtra(f)) toast(`Incassati ${euro(num(f.importo))}: fattura EXTRA, niente da mettere da parte.`, az);
  else if (az) toast('Fattura segnata pagata.', az);
}
// messaggio in basso; con azione (es. Annulla) resta un po' di più
function toast(msg, azione) {
  document.querySelector('.toast')?.remove();
  const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status');
  t.innerHTML = `<span>${esc(msg)}</span>${azione ? `<button type="button" class="t-act">${esc(azione.label)}</button>` : ''}<button type="button" class="t-x" aria-label="Chiudi">✕</button>`;
  document.body.appendChild(t);
  const close = () => t.remove();
  t.querySelector('.t-x').onclick = close;
  if (azione) t.querySelector('.t-act').onclick = () => { close(); Promise.resolve(azione.fn()).catch(() => toast('Non sono riuscito ad annullare. Riprova.')); };
  setTimeout(close, azione ? 10000 : 9000);
}

// uscite fiscali future raggruppate per data
function gruppiFiscali(piano, oggi) {
  const futuri = piano.filter(e => e.d >= oggi);
  const date = [...new Set(futuri.map(e => e.d))];
  return date.map(d => { const items = futuri.filter(e => e.d === d); return { d, items, tot: Math.max(0, items.reduce((s, e) => s + e.v, 0)) }; }).filter(g => g.tot > 0 || g.items.length);
}
const contoTasse = () => S.conto && S.conto.saldo !== undefined && S.conto.saldo !== null && S.conto.saldo !== '' ? S.conto : null;
// conto tasse: saldo reale scritto a mano, confrontato con le uscite fino al 30 giugno dell'anno dopo
function coperturaConto(piano, gruppi, oggi) {
  const conto = contoTasse(); if (!conto) return null;
  const LIM = `${year + 1}-06-30`;
  // le scadenze passate dopo il giorno in cui hai scritto il saldo si danno per pagate da quel conto
  const dS = conto.data || oggi;
  const scalati = Math.max(0, piano.filter(e => e.d > dS && e.d < oggi).reduce((s, e) => s + e.v, 0));
  const disp = num(conto.saldo) - scalati;
  let cum = 0, ultimo = null, primoNo = null; const stato = {};
  for (const g of gruppi) {
    if (g.d > LIM) break;
    cum += g.tot;
    if (!primoNo && cum <= disp + 0.5) { if (g.tot > 0) ultimo = g; stato[g.d] = 'ok'; }
    else { if (!primoNo) primoNo = g; stato[g.d] = 'no'; }
  }
  return { dS, scalati, disp, tot: cum, manca: Math.max(0, cum - disp), avanza: Math.max(0, disp - cum), ultimo, primoNo, stato };
}
const fmtGM = d => `${+d.slice(8, 10)} ${MESI_L[+d.slice(5, 7) - 1].toLowerCase()}`;
/* ---------- CHIEDI AD ALDO (IA) ---------- */
// Domande in italiano sui dati di ALDO. Usa Claude con l'account di chi guarda (capability "sample").
// Non legge MAI le note. Non modifica dati. Ogni domanda rimanda i dati aggiornati, la chat resta in memoria finché la pagina è aperta.
let aiFn = null, aiTurns = [], aiCtl = null, aiBenvenuto = null;
// dettatura (solo dove la piattaforma la offre: computer). Le parole arrivano nel campo di Aldo, l'invio resta a mano.
let dictFn = null, dictUI = null;
function initDettatura(d) {
  if (!d) return; dictFn = d;
  d.onPartial(({ text }) => dictUI && dictUI.partial(text));
  d.onFinal(({ text }) => dictUI && dictUI.final(text));
  d.onState(({ state, reason }) => {
    if (dictUI) dictUI.state(state);
    if (state === 'idle' && (reason === 'not_granted' || reason === 'unavailable')) { if (dictUI) dictUI.note(reason === 'unavailable' ? 'La dettatura qui non è disponibile.' : 'Microfono non consentito: puoi riattivarlo dal menu Autorizzazioni.'); if (reason === 'unavailable') dictFn = null; }
    if (state === 'idle' && (reason === 'upstream_error' || reason === 'rate_limited') && dictUI) dictUI.note('Il microfono non ha funzionato, riprova.');
  });
}
const AI_REGOLE = `Sei Aldo, il socio di bottega di Matteo (lo chiami Treno): vivi dentro ALDO, l'app con cui tiene conti, progetti e fatture del suo studio di grafica Train Graphic (freelance in regime forfettario, Cesena).
Come parli:
- Dai del tu, italiano colloquiale e diretto, come un collega di fiducia che tiene i conti. Un filo di ironia leggera ogni tanto, mai melenso, mai da assistente robotico ("Certamente!", "Ottima domanda" vietati).
- Brevissimo: di solito 1-3 frasi. Prima la risposta con la cifra, poi al massimo un dettaglio utile o un consiglio pratico. Elenchi puntati solo se servono davvero (3 voci o più).
- Grassetto solo per le cifre chiave. Niente tabelle, niente titoli.
- Importi in formato italiano: punto delle migliaia e € dopo (es. 1.250 €). Mai la lineetta lunga: usa la virgola.
Regole sui dati:
- Usa SOLO i dati qui sotto. Se una cosa non c'è, dillo con semplicità ("questo non lo vedo nei tuoi dati"), non inventare mai.
- Usa i totali già calcolati in RIEPILOGHI invece di rifare le somme; se devi sommare, fallo con attenzione.
- Per i conti usa importi e stati, mai le descrizioni delle fatture.
- Fatture EXTRA: fatturate da un collaboratore, contano nell'incassato ma non nelle tasse. "Tuo" = importo senza EXTRA.
- Tasse e INPS sono stime: se ne parli, ricordalo con leggerezza (una mezza frase), senza fare il commercialista.
- Non leggi le note di ALDO e non puoi modificare nulla: se ti chiede di creare o cambiare qualcosa, digli in una riga dove farlo (il + in alto per aggiungere, oppure tocca la voce per modificarla).`;
function contestoAI() {
  const oggi = todayISO(), r2 = x => Math.round(num(x) * 100) / 100, e = x => euro(x).replace(/\u00a0/g, ' ');
  const nomeP = id => { const p = S.progetti.find(x => x.id === id); return p ? p.titolo : ''; };
  const statoPL = k => (STATI_P.find(x => x[0] === k) || [k, k])[1];
  const L = [];
  L.push(`DATI DI ALDO aggiornati a oggi ${oggi} (anno in corso ${year}).`);
  // riepiloghi già calcolati dall'app
  const pag = S.fatture.filter(f => f.stato === 'pagata');
  const anni = [...new Set(pag.map(f => dataIncasso(f).slice(0, 4)).filter(Boolean))].sort();
  L.push('\nRIEPILOGHI (calcolati da ALDO, usali così):');
  for (const y of anni) { const fs = pag.filter(f => dataIncasso(f).startsWith(y)); const tot = fs.reduce((a, f) => a + num(f.importo), 0), tuo = fs.reduce((a, f) => a + fiscale(f), 0); L.push(`- Incassato ${y}: ${e(tot)} totale, di cui ${e(tuo)} fatturati da Matteo e ${e(tot - tuo)} EXTRA (${fs.length} fatture)`); }
  const mesi = MESI_L.map((m, i) => { const k = `${year}-${String(i + 1).padStart(2, '0')}`; const v = pag.filter(f => dataIncasso(f).startsWith(k)).reduce((a, f) => a + num(f.importo), 0); return v ? `${m} ${e(v)}` : ''; }).filter(Boolean);
  L.push(`- Incassato ${year} per mese: ${mesi.join(', ') || 'nessuno'}`);
  const aperte = S.fatture.filter(f => f.stato === 'inviata' || f.stato === 'scaduta'), scad = aperte.filter(f => statoF(f) === 'scaduta');
  L.push(`- Da incassare: ${e(aperte.reduce((a, f) => a + num(f.importo), 0))} in ${aperte.length} fatture, di cui scadute ${scad.length} (${e(scad.reduce((a, f) => a + num(f.importo), 0))})`);
  const boz = S.fatture.filter(f => f.stato === 'bozza'); L.push(`- Fatture in bozza: ${boz.length} (${e(boz.reduce((a, f) => a + num(f.importo), 0))})`);
  const daF = S.progetti.filter(p => residuo(p) > 0); L.push(`- Lavori ancora da fatturare: ${e(daF.reduce((a, p) => a + residuo(p), 0))}${daF.length ? ' (' + daF.map(p => `${p.titolo}, ${cNome(p.clienteId)}: ${e(residuo(p))}`).join('; ') + ')' : ''}`);
  const lim = num(S.imp.limite); if (lim) { const t = incTuoAnno(year, false); L.push(`- Limite forfettario ${e(lim)}: usato ${e(t)} (${Math.round(t / lim * 100)}%)`); }
  // per cliente
  const perC = {};
  for (const f of S.fatture) { const c = perC[f.clienteId] = perC[f.clienteId] || { anno: 0, tuoAnno: 0, sempre: 0, aperto: 0, n: 0 }; c.n++; if (f.stato === 'pagata') { c.sempre += num(f.importo); if (dataIncasso(f).startsWith(String(year))) { c.anno += num(f.importo); c.tuoAnno += fiscale(f); } } if (f.stato === 'inviata' || f.stato === 'scaduta') c.aperto += num(f.importo); }
  L.push(`\nPER CLIENTE (incassato ${year} | di cui tuo | incassato da sempre | da incassare | n. fatture):`);
  Object.entries(perC).sort((a, b) => b[1].anno - a[1].anno).forEach(([id, c]) => L.push(`- ${cNome(id)}: ${e(c.anno)} | ${e(c.tuoAnno)} | ${e(c.sempre)} | ${e(c.aperto)} | ${c.n}`));
  // tasse
  try {
    const sc = tasseScen, piano = pianoFiscale(sc), soloInc = fiscoAnno(year, 'incassato'), conAp = fiscoAnno(year, 'aperte');
    L.push(`\nTASSE E INPS (stime, regime forfettario, coefficiente ${Math.round(num(S.imp.coefficiente) * 100)}%, imposta ${Math.round(num(S.imp.aliquotaTasse) * 100)}%):`);
    if (soloInc) L.push(`- Stima ${year} solo sull'incassato: imposta ${e(soloInc.imposta)}, INPS ${e(soloInc.inps)}, totale ${e(soloInc.imposta + soloInc.inps)}`);
    if (conAp) L.push(`- Stima ${year} contando anche le fatture da incassare: imposta ${e(conAp.imposta)}, INPS ${e(conAp.inps)}, totale ${e(conAp.imposta + conAp.inps)}`);
    L.push(`- Quota da mettere da parte su ogni incasso tuo: ${Math.round(quotaAccantona('aperte') * 100)}%`);
    const gr = gruppiFiscali(piano, oggi);
    L.push(`- Prossimi pagamenti F24 (scenario "${sc === 'aperte' ? 'incassato + da incassare' : 'solo incassato'}"): ` + gr.filter(g => g.tot > 0).map(g => `${g.d} ${e(g.tot)} (${g.items.map(x => x.label).join(', ')})`).join('; '));
    const cp = coperturaConto(piano, gr, oggi), ct = contoTasse();
    if (cp) L.push(`- Conto tasse: saldo scritto ${e(ct.saldo)} il ${cp.dS}${cp.scalati >= 0.5 ? `, già scalati ${e(cp.scalati)} di scadenze passate (disponibile ${e(cp.disp)})` : ''}. ${cp.manca < 0.5 ? `Copre tutto fino al 30/06/${year + 1}, avanzano ${e(cp.avanza)}.` : `${cp.ultimo ? 'Coperto fino al ' + cp.ultimo.d : 'Non copre il ' + cp.primoNo.d}; per arrivare al 30/06/${year + 1} mancano ${e(cp.manca)}.`}`);
    else L.push('- Conto tasse: saldo non inserito.');
  } catch (err) { L.push('- Tasse: non calcolabili.'); }
  // dati di dettaglio
  L.push('\nFATTURE (numero | cliente | progetti | importo | di cui tuo | stato | emessa | scadenza | incassata | descrizione breve):');
  [...S.fatture].sort((a, b) => String(b.dataEmissione || '').localeCompare(String(a.dataEmissione || ''))).forEach(f => {
    const d = String(f.note || '').split('\n')[0].trim().slice(0, 50);
    L.push(`${f.numero || 's/n'} | ${cNome(f.clienteId)} | ${progettiFattura(f).map(nomeP).filter(Boolean).join(' + ') || '-'} | ${e(f.importo)} | ${isExtra(f) ? 'EXTRA' : e(fiscale(f))} | ${STATI_F[statoF(f)]?.[0] || f.stato} | ${f.dataEmissione || '-'} | ${f.dataScadenza || '-'} | ${f.stato === 'pagata' ? dataIncasso(f) : '-'} | ${d}`);
  });
  L.push('\nPROGETTI (titolo | cliente | stato | valore | EXTRA previsto | fatturato da te | ancora da fatturare | scadenza | descrizione breve):');
  S.progetti.forEach(p => L.push(`${p.titolo} | ${cNome(p.clienteId)} | ${statoPL(statoP(p))} | ${e(p.importo)} | ${num(p.extra) ? e(p.extra) : '-'} | ${e(fatturatoProgetto(p))} | ${e(residuo(p))} | ${p.scadenza || '-'} | ${String(p.descrizione || '').replace(/\s+/g, ' ').slice(0, 220)}`));
  const tk = S.task.filter(t => !t.completato);
  L.push(`\nTASK DA FARE (${tk.length}):`);
  tk.forEach(t => L.push(`- ${t.titolo}${t.progettoId ? ' [' + nomeP(t.progettoId) + ']' : ''}${t.scadenza ? ' entro ' + t.scadenza : ''}`));
  L.push('\nSPESE FISSE (descrizione | categoria | frequenza | importo | annuo | attiva):');
  S.spese.forEach(x => L.push(`${x.descrizione} | ${CAT_S[x.categoria] || x.categoria || '-'} | ${FREQ[x.frequenza]?.[0] || x.frequenza || '-'} | ${e(x.importo)} | ${e(annuo(x))} | ${x.attivo === false ? 'no' : 'sì'}`));
  L.push('\nCLIENTI (nome | email | telefono):');
  [...S.clienti].sort(byName).forEach(c => L.push(`${c.nome} | ${c.email || '-'} | ${c.telefono || '-'}`));
  return L.join('\n');
}
// markdown minimo e sicuro: grassetto, elenchi, paragrafi
function mdLite(t) {
  const out = []; let list = null;
  const inl = x => esc(x).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  const chiudi = () => { if (list) { out.push(`<${list.t}>${list.items.map(i => `<li>${i}</li>`).join('')}</${list.t}>`); list = null; } };
  let par = [];
  const flush = () => { if (par.length) { out.push(`<p>${par.join('<br>')}</p>`); par = []; } };
  for (const raw of String(t).replace(/\u2014/g, ',').split('\n')) {
    const l = raw.trim();
    const ul = l.match(/^[-*•]\s+(.*)/), ol = l.match(/^\d+[.)]\s+(.*)/), h = l.match(/^#{1,4}\s+(.*)/);
    if (ul || ol) { flush(); const tp = ul ? 'ul' : 'ol'; if (!list || list.t !== tp) { chiudi(); list = { t: tp, items: [] }; } list.items.push(inl((ul || ol)[1])); continue; }
    chiudi();
    if (!l) { flush(); continue; }
    if (h) { flush(); out.push(`<p><b>${inl(h[1])}</b></p>`); continue; }
    par.push(inl(l));
  }
  chiudi(); flush();
  return out.join('');
}
// saluto immediato, scritto con i dati del giorno (non consuma il piano Claude)
function benvenutoAI() {
  const h = new Date().getHours(), nome = (S.imp && S.imp.nome) || '';
  const n = nome ? ' ' + nome : ''; const saluto = h < 5 ? `Ehi${n}, ancora sveglio?` : h < 13 ? `Buongiorno${n}!` : h < 18 ? `Ciao${n}!` : `Buonasera${n}!`;
  const giorno = d => { const g = daysTo(d); return g === 0 ? 'oggi' : g === 1 ? 'domani' : g < 7 ? new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { weekday: 'long' }) : `il ${+d.slice(8, 10)} ${MESI_L[+d.slice(5, 7) - 1].toLowerCase()}`; };
  const cose = [];
  const aperte = S.fatture.filter(f => f.stato === 'inviata' || f.stato === 'scaduta'), scad = aperte.filter(f => statoF(f) === 'scaduta');
  if (scad.length) cose.push(`hai ${scad.length === 1 ? 'una fattura scaduta' : scad.length + ' fatture scadute'} (${euro(scad.reduce((a, f) => a + num(f.importo), 0))})`);
  else if (aperte.length) cose.push(`hai ${euro(aperte.reduce((a, f) => a + num(f.importo), 0))} da incassare`);
  const pr = S.progetti.filter(p => p.scadenza && p.stato !== 'completato' && daysTo(p.scadenza) >= 0 && daysTo(p.scadenza) <= 7).sort((a, b) => a.scadenza.localeCompare(b.scadenza))[0];
  if (pr) cose.push(`«${pr.titolo}» scade ${giorno(pr.scadenza)}`);
  try { const g = gruppiFiscali(pianoFiscale(tasseScen), todayISO()).find(x => x.tot > 0); if (g && daysTo(g.d) <= 14) cose.push(`${giorno(g.d)} c'è un F24 da ${euro(g.tot)}`); } catch (e) {}
  if (cose.length < 2) { const r = S.progetti.reduce((a, p) => a + residuo(p), 0); if (r > 0) cose.push(`ci sono ${euro(r)} ancora da fatturare`); }
  const lista = cose.slice(0, 2);
  const situa = lista.length ? ` Ti aggiorno al volo: ${lista.join(' e ')}.` : ' Qui è tutto tranquillo, niente in sospeso.';
  const chiusa = ['Di cosa hai bisogno?', 'Cosa ti serve?', 'Dimmi pure.'][new Date().getDate() % 3];
  return (saluto + situa + ' ' + chiusa).replace(/ /g, ' ');
}
// cursore lampeggiante in coda all'ultima riga scritta
const conCursore = html => { const c = '<span class="ai-caret"></span>'; const m = html.match(/(<\/(?:p|li)>)((?:<\/[uo]l>)?)$/); return m ? html.slice(0, m.index) + c + m[1] + m[2] : html + c; };
function apriAI() {
  if (!aiFn || document.querySelector('.ai-ov')) return;
  closeAltro && closeAltro();
  const ov = document.createElement('div'); ov.className = 'ai-ov';
  ov.innerHTML = `<div class="ai-wrap"><div class="ai-glow" aria-hidden="true"></div><div class="ai-panel" role="dialog" aria-modal="true" aria-label="Aldo">
    <div class="ai-edge" aria-hidden="true"></div>
    <div class="ai-head"><div class="ai-orb" aria-hidden="true">A<i>.</i></div><div class="ai-who"><b>Aldo</b><span class="ai-stato">il tuo socio dei conti</span></div>
      <button type="button" class="ai-hb ai-new" aria-label="Nuova chat" title="Nuova chat" hidden><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>
      <button type="button" class="ai-hb ai-x" aria-label="Chiudi">✕</button></div>
    <div class="ai-body" aria-live="polite"></div>
  </div></div>`;
  document.body.appendChild(ov);
  const panel = ov.querySelector('.ai-wrap'), body = ov.querySelector('.ai-body'), stato = ov.querySelector('.ai-stato'), nuova = ov.querySelector('.ai-new');
  const SEND = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';
  const STOP = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="3"/></svg>';
  const MIC = '<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/></svg>';
  let typer = null, attivo = true;
  const vicinoFondo = () => body.scrollHeight - body.scrollTop - body.clientHeight < 90;
  const giu = (forza) => { if (forza || vicinoFondo()) body.scrollTop = body.scrollHeight; };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  function close() {
    if (!attivo) return; attivo = false;
    if (aiCtl) aiCtl.abort(); clearInterval(typer);
    if (dictFn && dictFn.active()) dictFn.stop().catch(() => {}); dictUI = null;
    document.removeEventListener('keydown', onKey, true);
    panel.classList.add('out'); ov.style.transition = 'opacity .2s'; ov.style.opacity = '0';
    setTimeout(() => { ov.remove(); renderQuandoLibero(); }, 200);
  }
  document.addEventListener('keydown', onKey, true);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.querySelector('.ai-x').onclick = close;
  nuova.onclick = () => { if (aiCtl) aiCtl.abort(); aiTurns = []; aiBenvenuto = null; disegna(true); };
  const msgAldo = (html, cls = '') => `<div class="ai-msg al"><span class="ai-mini" aria-hidden="true"></span><div class="ai-txt ${cls}">${html}</div></div>`;
  // conversazione dall'alto in basso; il campo per scrivere segue l'ultimo messaggio (niente fissato in fondo allo schermo)
  function disegna(animaSaluto) {
    clearInterval(typer);
    if (!aiBenvenuto) aiBenvenuto = benvenutoAI();
    let h = msgAldo(animaSaluto ? '<span class="ai-caret"></span>' : mdLite(aiBenvenuto), 'ai-hello');
    for (let i = 0; i < aiTurns.length; i++) {
      const t = aiTurns[i];
      if (t.role === 'user') h += `<div class="ai-msg me"><div class="ai-txt">${esc(t.content)}</div></div>`;
      else h += t.err ? msgAldo(esc(t.err), 'err') : msgAldo(mdLite(t.content));
    }
    if (aiCtl && aiTurns.length % 2 === 1) h += msgAldo('<span class="ai-typing" aria-label="Aldo sta scrivendo"><i></i><i></i><i></i></span>', 'ai-live');
    h += `<form class="ai-in" novalidate><div class="ai-field"><div class="ai-partial" aria-live="polite"></div><textarea rows="1" placeholder="${dictFn ? 'Scrivi o detta ad Aldo…' : 'Scrivi ad Aldo…'}" aria-label="Scrivi ad Aldo"></textarea></div>${dictFn ? `<button type="button" class="ai-mic${dictFn.active() ? ' on' : ''}" aria-label="Detta con la voce" title="Detta con la voce">${MIC}</button>` : ''}<button type="submit" class="ai-send" aria-label="Invia" disabled>${SEND}</button></form>`;
    body.innerHTML = h;
    nuova.hidden = !aiTurns.length;
    const form = body.querySelector('.ai-in'), q = form.querySelector('textarea'), send = form.querySelector('.ai-send');
    const fit = () => { q.style.height = 'auto'; q.style.height = Math.min(140, q.scrollHeight) + 'px'; send.disabled = !aiCtl && !q.value.trim(); };
    q.addEventListener('input', fit);
    q.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); chiedi(q.value); } });
    form.onsubmit = async e => { e.preventDefault(); if (aiCtl) { aiCtl.abort(); return; } if (dictFn && dictFn.active()) { try { await dictFn.stop(); } catch (er) {} } chiedi(q.value); };
    const mic = form.querySelector('.ai-mic'), part = form.querySelector('.ai-partial');
    if (mic) mic.onclick = () => {
      if (dictFn.active()) { dictFn.stop().catch(() => {}); return; }
      // va chiamato subito dentro al clic, senza attese prima
      dictFn.start({ language: 'it' }).catch(err => { const c = err && err.code; if (c === 'unavailable') { dictFn = null; mic.remove(); dictUI && dictUI.note('La dettatura qui non è disponibile.'); } else if (c === 'not_granted') dictUI && dictUI.note('Microfono non consentito: puoi riattivarlo dal menu Autorizzazioni.'); else if (c !== 'stopped' && c !== 'dismissed') dictUI && dictUI.note('Il microfono non ha funzionato, riprova.'); });
    };
    dictUI = {
      partial: t => { part.textContent = t; part.classList.toggle('on', !!t); giu(); },
      final: t => { const v = q.value; q.value = v ? v + t : t.replace(/^\s+/, ''); part.textContent = ''; part.classList.remove('on'); fit(); },
      state: st => { const on = st !== 'idle'; if (mic) { mic.classList.toggle('on', on); mic.setAttribute('aria-label', on ? 'Ferma la dettatura' : 'Detta con la voce'); } stato.textContent = on ? (st === 'starting' ? 'apro il microfono…' : 'ti ascolto…') : (aiCtl ? 'sta scrivendo…' : 'il tuo socio dei conti'); if (!on) { part.textContent = ''; part.classList.remove('on'); q.focus({ preventScroll: true }); } },
      note: t => { stato.textContent = t; setTimeout(() => { if (stato.textContent === t) stato.textContent = aiCtl ? 'sta scrivendo…' : 'il tuo socio dei conti'; }, 4000); },
    };
    if (aiCtl) { send.disabled = false; send.classList.add('stop'); send.innerHTML = STOP; send.setAttribute('aria-label', 'Ferma'); }
    if (animaSaluto) {
      // il saluto si scrive da solo, come se Aldo stesse digitando
      panel.classList.add('hello');
      const el = body.querySelector('.ai-hello'), testo = aiBenvenuto; let n = 0;
      typer = setInterval(() => {
        n = Math.min(testo.length, n + 2);
        el.innerHTML = esc(testo.slice(0, n)) + (n < testo.length ? '<span class="ai-caret"></span>' : '');
        if (n >= testo.length) { clearInterval(typer); el.innerHTML = mdLite(testo); panel.classList.remove('hello'); }
      }, 16);
    }
    giu(true);
    if (!matchMedia('(pointer: coarse)').matches || aiTurns.length) q.focus({ preventScroll: true });
  }
  async function chiedi(testo) {
    testo = String(testo || '').trim(); if (!testo || aiCtl) return;
    clearInterval(typer);
    aiTurns.push({ role: 'user', content: testo });
    const ctl = aiCtl = new AbortController();
    panel.classList.add('busy'); stato.textContent = 'sta scrivendo…';
    disegna(false);
    const storia = [];
    for (let i = 0; i < aiTurns.length - 1; i += 2) { const a = aiTurns[i + 1]; if (a && !a.err) storia.push({ role: 'user', content: aiTurns[i].content }, { role: 'assistant', content: a.content }); }
    const input = [{ role: 'user', content: AI_REGOLE + '\n\n' + contestoAI() }, ...storia.slice(-12), { role: 'user', content: testo }];
    const idx = aiTurns.length;
    const live = () => body.querySelector('.ai-live');
    try {
      const { text, truncated } = await aiFn(input, { signal: ctl.signal, cache: false, modelTier: 'quick', onText: ({ text }) => {
        const b = live(); if (!b) return; const stick = vicinoFondo();
        b.innerHTML = conCursore(mdLite(text)); if (stick) giu(true);
      } });
      aiTurns[idx] = { role: 'assistant', content: text + (truncated ? '\n\n(Mi sono fermato a metà: chiedimelo in modo più preciso.)' : '') };
    } catch (e) {
      const c = e && e.code;
      const err = t => ({ role: 'assistant', err: t });
      if (c === 'cancelled') aiTurns[idx] = e.text ? { role: 'assistant', content: e.text } : err('Ok, mi fermo.');
      else if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(c)) aiTurns[idx] = err('Non ho il permesso di usare Claude, quindi per ora non posso risponderti. Riapri ALDO e consenti l\'accesso quando te lo chiede.');
      else if (c === 'rate_limited') aiTurns[idx] = err('Mi stai facendo lavorare troppo (o il piano Claude è al limite). Dammi un attimo e riprova.');
      else if (c === 'session_expired') aiTurns[idx] = err('Devi rientrare in Claude, poi ci risentiamo.');
      else if (c === 'refused') aiTurns[idx] = err('Su questa preferisco non rispondere. Prova a chiedermela in un altro modo.');
      else if (c === 'prompt_too_large') aiTurns[idx] = err('Abbiamo chiacchierato troppo: tocca la matita in alto per ripartire da zero.');
      else aiTurns[idx] = e && e.text ? { role: 'assistant', content: e.text + '\n\n(Mi si è interrotta la linea, riprova.)' } : err('Mi si è interrotta la linea. Riprova tra poco.');
    } finally {
      if (aiCtl === ctl) aiCtl = null;
      panel.classList.remove('busy'); stato.textContent = 'il tuo socio dei conti';
      if (ov.isConnected && attivo) disegna(false);
    }
  }
  disegna(!aiTurns.length);
}
const fmtLungo = iso => new Date(iso + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
function vTasse(v) {
  const oggi = todayISO();
  const piano = pianoFiscale(tasseScen);
  const cur = fiscoAnno(year, tasseScen);
  const soloInc = fiscoAnno(year, 'incassato'), conAp = fiscoAnno(year, 'aperte');
  const q = quotaAccantona(tasseScen);
  const gruppi = gruppiFiscali(piano, oggi);
  const prossimo = gruppi.find(g => g.tot > 0);
  const totProssimoAnno = Math.max(0, piano.filter(e => e.d.startsWith(String(year + 1))).reduce((s, e) => s + e.v, 0));
  const voceAnno = t => piano.filter(e => e.d.startsWith(String(year + 1)) && e.tipo === t).reduce((s, e) => s + e.v, 0);
  const conto = contoTasse();
  const cop = coperturaConto(piano, gruppi, oggi);
  const prev = fiscoAnno(year - 1, tasseScen);
  const nMesi = d => { const g = daysTo(d); return g <= 0 ? 'oggi' : g === 1 ? 'domani' : g < 45 ? `tra ${g} giorni` : `tra ${Math.round(g / 30.4)} mesi`; };
  const meseL = d => MESI_L[+d.slice(5, 7) - 1] + ' ' + d.slice(0, 4);
  let ultimoMese = '';
  const cal = gruppi.map(g => {
    const m = meseL(g.d), h = m !== ultimoMese ? `<div class="tx-mese">${m}</div>` : ''; ultimoMese = m;
    return `${h}<div class="tx-row${g === prossimo ? ' next' : ''}">
      <div class="tx-d"><b>${+g.d.slice(8, 10)}</b><span>${MESI[+g.d.slice(5, 7) - 1]}</span></div>
      <div class="tx-main">${g.items.map(e => `<div class="tx-it"><span>${esc(e.label)}${e.v < 0 ? ' <em>(credito, si compensa)</em>' : ''}</span><b>${e.v < 0 ? '−' : ''}${euro(Math.abs(e.v))}</b></div>`).join('')}</div>
      <div class="tx-tot">${euro(g.tot)}${cop && cop.stato[g.d] && g.tot > 0 ? (cop.stato[g.d] === 'ok' ? '<span class="cv ok">Coperto</span>' : '<span class="cv no">Scoperto</span>') : ''}</div></div>`;
  }).join('');
  v.innerHTML = `
    <div class="page-head"><div><h1>Tasse</h1><div class="lede">Quanto pagherai, quando, e quanto mettere da parte. Stima indicativa, non sostituisce il commercialista.</div></div></div>
    <div class="filters" role="group" aria-label="Scenario">
      <button class="fchip" data-scen="aperte" aria-pressed="${tasseScen === 'aperte'}">Incassato + da incassare</button>
      <button class="fchip" data-scen="incassato" aria-pressed="${tasseScen === 'incassato'}">Solo incassato a oggi</button>
    </div>
    <div class="grid g-stats tx-stats" style="margin-bottom:14px">
      <div class="panel stat">
        <div class="l">${ic(DI.cal, 17, 'var(--accent-text)')}Prossimo pagamento</div>
        <div class="v">${prossimo ? euro(prossimo.tot) : '—'}</div>
        <div class="s">${prossimo ? `${fmtLungo(prossimo.d)} · ${nMesi(prossimo.d)}` : 'Nessun pagamento in programma'}</div>
      </div>
      <div class="panel stat">
        <div class="l">${ic(DI.wallet, 17, 'var(--accent-text)')}Da mettere da parte</div>
        <div class="v">${Math.round(q * 100)}%</div>
        <div class="s">di ogni incasso tuo (le EXTRA no)</div>
      </div>
      <div class="panel stat tx-conto">
        <label class="l" for="cnt-saldo">${ic(DI.bank, 17, 'var(--accent-text)')}Sul conto tasse ho</label>
        <div class="cnt-in"><input id="cnt-saldo" inputmode="decimal" autocomplete="off" placeholder="Scrivi il saldo" value="${conto ? fN(conto.saldo) : ''}"><span aria-hidden="true">€</span></div>
        ${!cop ? `<div class="cnt-st vuoto">Scrivi quanto hai da parte: ti dico fino a quale scadenza sei coperto.</div>`
          : cop.manca < 0.5 ? `<div class="cnt-st ok">Coperto fino a giugno ${year + 1}</div><div class="s">Dopo il 30 giugno ti avanzano ${euro(cop.avanza)}</div>`
          : `<div class="cnt-st ${cop.ultimo ? 'meta' : 'no'}">${cop.ultimo ? `Coperto fino al ${fmtGM(cop.ultimo.d)}` : `Non copri il ${fmtGM(cop.primoNo.d)}`}</div><div class="s">Per arrivare al 30 giugno ${year + 1} ti mancano <b>${euro(cop.manca)}</b></div>`}
        ${cop ? `<div class="s" style="margin-top:4px">Aggiornato il ${fmtGM(cop.dS)}${cop.scalati >= 0.5 ? `, già scalati ${euro(cop.scalati)} di scadenze passate` : ''}</div>` : ''}
      </div>
    </div>
    <div class="fgrid">
      <div class="fmain"><div class="panel">
        <h2>${ic(DI.cal, 18)}Calendario pagamenti<span class="aside">fino a dicembre ${year + 1}</span></h2>
        <div class="tx-cal">${cal || '<div class="empty">Nessun pagamento in programma.</div>'}</div>
        ${prev ? '' : `<p class="hint" style="margin-top:12px">Mancano i dati del ${year - 1}: senza, non posso calcolare gli acconti del ${year}. Inseriscili in Impostazioni.</p>`}
      </div></div>
      <aside class="fside">
        <div class="panel">
          <h2>Totale da pagare nel ${year + 1}</h2>
          <div class="bigv" style="color:var(--text)">${euro(totProssimoAnno)}</div>
          <div class="kv"><span>Imposta (saldo ${year} + acconti ${year + 1})</span><b>${euro(voceAnno('imposta'))}</b></div>
          <div class="kv"><span>INPS (rate fisse, saldo e acconti)</span><b>${euro(voceAnno('inps'))}</b></div>
          <p class="hint" style="margin-top:10px">Giugno è il mese pesante: saldo e primo acconto arrivano insieme.</p>
        </div>
        <div class="panel">
          <h2>Stima ${year}<span class="aside">${tasseScen === 'aperte' ? 'con le fatture da incassare' : 'solo incassato'}</span></h2>
          <div class="kv"><span>Incassato tuo (senza EXTRA)</span><b>${euro(cur.inc)}</b></div>
          <div class="kv"><span>Imponibile (× ${Math.round(num(S.imp.coefficiente) * 100)}%)</span><b>${euro(cur.imponibile)}</b></div>
          ${inpsFissoAnnuo() ? `<div class="kv"><span>INPS fissi</span><b>${euro(inpsFissoAnnuo())}</b></div><div class="kv"><span>INPS oltre il minimale</span><b>${euro(cur.inpsVar)}</b></div>` : `<div class="kv"><span>INPS</span><b>${euro(cur.inps)}</b></div>`}
          <div class="kv"><span>Imposta sostitutiva (${Math.round(num(S.imp.aliquotaTasse) * 100)}%)</span><b>${euro(cur.imposta)}</b></div>
          <div class="kv tot"><span>Totale tasse + INPS</span><b>${euro(cur.imposta + cur.inps)}</b></div>
          <p class="hint" style="margin-top:10px">${tasseScen === 'aperte' ? `Solo incassato: ${euro(soloInc.imposta + soloInc.inps)}.` : `Con le fatture da incassare: ${euro(conAp.imposta + conAp.inps)}.`}</p>
        </div>
        <div class="panel">
          <h2>Anno ${year - 1}<span class="aside">${prev ? (prev.manuale ? 'da Impostazioni' : 'dai dati di ALDO') : 'mancante'}</span></h2>
          ${prev ? `<div class="kv"><span>Imposta</span><b>${euro(prev.imposta)}</b></div><div class="kv"><span>${inpsFissoAnnuo() ? 'INPS oltre il minimale' : 'INPS'}</span><b>${euro(prev.inpsVar)}</b></div>` : ''}
          <p class="hint" style="margin-top:10px">Serve per gli acconti versati quest'anno. <button type="button" class="lnk" id="tx-imp">Modifica in Impostazioni</button></p>
        </div>
      </aside>
    </div>`;
  v.querySelectorAll('[data-scen]').forEach(b => b.onclick = () => { tasseScen = b.dataset.scen; render(); });
  v.querySelector('#tx-imp').onclick = () => goTab('impostazioni');
  const cs = v.querySelector('#cnt-saldo');
  // il campo si allarga col numero, così il simbolo € resta attaccato
  const misura = document.createElement('canvas').getContext('2d');
  const fit = () => {
    const st = getComputedStyle(cs); misura.font = `${st.fontWeight} ${st.fontSize} ${st.fontFamily}`;
    if (!cs.value) { cs.style.width = '13ch'; return; }
    const w = misura.measureText(cs.value).width + cs.value.length * (parseFloat(st.letterSpacing) || 0);
    cs.style.width = Math.ceil(Math.max(w, 30) + 6) + 'px';
  };
  fit(); if (document.fonts) document.fonts.ready.then(() => cs.isConnected && fit()); cs.addEventListener('input', fit);
  cs.addEventListener('keydown', e => { if (e.key === 'Enter') cs.blur(); });
  cs.addEventListener('change', async () => {
    const raw = cs.value.trim();
    const nuovo = raw === '' ? null : Math.round(num(raw) * 100) / 100;
    if (raw !== '' && !isFinite(nuovo)) { toast('Scrivi solo il numero, per esempio 2.700'); return; }
    S.conto = nuovo === null ? null : { saldo: nuovo, data: todayISO() };
    try { if (db) await db.doc('config/conto').set(S.conto || { saldo: '' }); }
    catch (e) { toast('Non sono riuscito a salvare il saldo. Riprova.'); }
    setTimeout(renderQuandoLibero, 50);
  });
}

/* ---------- SPESE DELLA COMMESSA ---------- */
// costi = [{ voce, importo, data }] su progetti e su fatture senza progetto. Tolti dal guadagno, non dalle tasse.
// Vecchie fatture importate hanno solo il numero "costiCommessa": lo trattiamo come una voce.
function costiDi(x, dataDefault) {
  if (Array.isArray(x.costi)) return x.costi;
  return num(x.costiCommessa) > 0 ? [{ voce: 'Costi commessa', importo: num(x.costiCommessa), data: dataDefault || '' }] : [];
}
const costiFattura = f => costiDi(f, f.dataPagamento || f.dataEmissione);
function speseCommesseAnno(y) {
  const Y = String(y); let t = 0;
  const add = arr => arr.forEach(c => { if (String(c.data || '').startsWith(Y)) t += num(c.importo); });
  S.progetti.forEach(p => add(costiDi(p)));
  S.fatture.forEach(f => add(costiFattura(f)));
  return t;
}
function mountCosti(box, iniziali, titolo) {
  const costi = (iniziali || []).map(c => ({ ...c }));
  const sec = document.createElement('div'); sec.className = 'sub-sec costi-sec';
  sec.innerHTML = `<h4>${esc(titolo || 'Spese della commessa')} <span class="aside"></span></h4>
    <div class="hint" style="margin:-2px 0 8px">Collaboratori pagati da te, stampe, materiali… Si tolgono dal tuo guadagno, non dalle tasse.</div>
    <div class="clist"></div>
    <div class="cadd"><input class="c-voce" placeholder="Voce (es. Stampa brochure)" aria-label="Voce di spesa"><input class="c-imp" inputmode="decimal" placeholder="€" aria-label="Importo"><input class="c-data" type="date" value="${todayISO()}" aria-label="Data"><button type="button" class="btn sm">Aggiungi</button></div>`;
  box.appendChild(sec);
  const list = sec.querySelector('.clist'), tot = sec.querySelector('h4 .aside');
  const iV = sec.querySelector('.c-voce'), iI = sec.querySelector('.c-imp'), iD = sec.querySelector('.c-data');
  const draw = () => {
    list.innerHTML = costi.length ? costi.map((c, i) => `<div class="crow"><span class="cv">${esc(c.voce || 'Spesa')}</span><span class="cd">${c.data ? fmtD(c.data) : ''}</span><b>${euro(num(c.importo))}</b><button type="button" class="x" data-i="${i}" aria-label="Togli ${esc(c.voce || 'spesa')}">×</button></div>`).join('') : '<div class="empty" style="padding:4px 2px 8px">Nessuna spesa.</div>';
    tot.textContent = costi.length ? euro(costi.reduce((s, c) => s + num(c.importo), 0)) : '';
    list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { costi.splice(+b.dataset.i, 1); draw(); });
  };
  const riga = () => num(iI.value) > 0 ? { voce: iV.value.trim() || 'Spesa', importo: num(iI.value), data: iD.value || todayISO() } : null;
  const add = () => { const r = riga(); if (!r) { iI.focus(); return; } costi.push(r); iV.value = ''; iI.value = ''; draw(); iV.focus(); };
  sec.querySelector('.cadd button').onclick = add;
  [iV, iI, iD].forEach(el => el.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  draw();
  // restituisce l'elenco, compresa una voce scritta ma non ancora aggiunta
  return { sec, get: () => { const r = riga(); return r ? [...costi, r] : costi.slice(); } };
}

/* ---------- AGENDA ---------- */
// Appuntamenti Google copiati ogni mattina in config/agenda { aggiornato, eventi: [{ titolo, inizio, fine, tuttoIlGiorno, luogo, cal, calNome }] }
// più le scadenze di ALDO. (task, progetti, fatture) nei prossimi 7 giorni e quelle già passate.
const CAL_COL = { tonka: 'var(--verde)', tg: 'var(--lilla)' };
const GIORNI_L = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];
function scadenzeAldo() {
  const out = [];
  S.task.filter(t => !t.completato && t.scadenza).forEach(t => {
    const pr = t.progettoId && S.progetti.find(x => x.id === t.progettoId);
    out.push({ d: t.scadenza, tipo: 'Task', t: t.titolo, c: pr ? [pr.clienteId && cliente(pr.clienteId) ? cNome(pr.clienteId) : '', pr.titolo].filter(Boolean).join(' · ') : '', open: pr ? () => formProgetto(pr) : null });
  });
  S.progetti.filter(p => p.stato !== 'completato' && p.scadenza).forEach(p => out.push({ d: p.scadenza, tipo: 'Progetto', t: p.titolo, c: cNome(p.clienteId), open: () => formProgetto(p) }));
  S.fatture.filter(f => (f.stato === 'inviata' || f.stato === 'scaduta') && f.dataScadenza).forEach(f => out.push({ d: f.dataScadenza, tipo: 'Fattura', t: 'Fattura ' + (f.numero ? 'n. ' + f.numero : cNome(f.clienteId)), c: (f.numero ? cNome(f.clienteId) + ' · ' : '') + euro(num(f.importo)), open: () => formFattura(f) }));
  return out;
}
let agendaTutta = false; // Dashboard: false = oggi + 2 giorni, true = tutta la settimana
function renderAgenda(box) {
  if (!box) return;
  let nascosti = 0;
  const oggi = todayISO();
  const giorni = [...Array(7)].map((_, i) => { const d = new Date(); d.setDate(d.getDate() + i); return isoLocale(d); });
  const ald = scadenzeAldo();
  const late = ald.filter(x => x.d < oggi).sort((a, b) => a.d.localeCompare(b.d));
  const ev = (S.agenda && Array.isArray(S.agenda.eventi)) ? S.agenda.eventi : [];
  const giornoEv = e => e.tuttoIlGiorno ? String(e.inizio).slice(0, 10) : isoLocale(new Date(e.inizio));
  const nelGiorno = (e, g) => e.tuttoIlGiorno ? (g >= String(e.inizio).slice(0, 10) && g < String(e.fine || e.inizio).slice(0, 10) || g === String(e.inizio).slice(0, 10)) : giornoEv(e) === g;
  const ora = e => e.tuttoIlGiorno ? 'Giornata' : new Date(e.inizio).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const acts = [];
  const rigaAldo = (x, badge) => { acts.push(x.open); return `<div class="ag-row ag-aldo" ${x.open ? `data-ai="${acts.length - 1}" tabindex="0" role="button"` : ''}>
      <span class="ag-time"><span class="badge ${badge || 'b-gray'}">${x.tipo}</span></span>
      <div class="ag-main"><div class="ag-t">${esc(x.t)}</div>${x.c ? `<div class="ag-s">${esc(x.c)}</div>` : ''}</div>
      ${badge === 'b-red' ? `<span class="ag-late">${fmtD(x.d)}</span>` : ''}</div>`; };
  const adesso = Date.now();
  const rigaEv = e => `<div class="ag-row ${!e.tuttoIlGiorno && e.fine && new Date(e.fine).getTime() < adesso ? 'ag-past' : ''}">
      <span class="ag-time">${ora(e)}</span><i class="ag-dot" style="background:${CAL_COL[e.cal] || 'var(--muted)'}"></i>
      <div class="ag-main"><div class="ag-t">${esc(e.titolo || '(senza titolo)')}</div>${e.luogo ? `<div class="ag-s">${esc(e.luogo)}</div>` : ''}</div></div>`;
  let html = late.length ? `<div class="ag-day"><div class="ag-h ag-h-late">In ritardo</div>${late.map(x => rigaAldo(x, 'b-red')).join('')}</div>` : '';
  giorni.forEach((g, i) => {
    const eg = ev.filter(e => nelGiorno(e, g)).sort((a, b) => (b.tuttoIlGiorno ? 1 : 0) - (a.tuttoIlGiorno ? 1 : 0) || String(a.inizio).localeCompare(String(b.inizio)));
    const ag = ald.filter(x => x.d === g);
    if (!eg.length && !ag.length && i > 0) return;
    if (!agendaTutta && i > 2) { nascosti += eg.length + ag.length; return; }
    const d = new Date(g + 'T12:00:00');
    const nome = i === 0 ? 'Oggi' : i === 1 ? 'Domani' : GIORNI_L[d.getDay()].replace(/^./, c => c.toUpperCase());
    html += `<div class="ag-day"><div class="ag-h">${nome} <span>${d.getDate()} ${d.toLocaleDateString('it-IT', { month: 'short' })}</span></div>
      ${eg.map(rigaEv).join('')}${ag.map(x => rigaAldo(x)).join('')}
      ${!eg.length && !ag.length ? '<div class="ag-empty">Niente in programma.</div>' : ''}</div>`;
  });
  const up = S.agenda && S.agenda.aggiornato;
  let foot;
  if (!up) foot = '<span>Calendario Google non ancora collegato.</span>';
  else {
    const t = new Date(up), vecchio = Date.now() - t.getTime() > 30 * 3600e3;
    const quando = isoLocale(t) === oggi ? 'oggi' : 'il ' + t.toLocaleDateString('it-IT', { day: 'numeric', month: 'short' });
    foot = `<span class="${vecchio ? 'ag-stale' : ''}">Calendario aggiornato ${quando} alle ${t.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}${vecchio ? ' · aggiornamento in ritardo' : ''}</span>`;
  }
  foot += `<span class="ag-leg"><i style="background:${CAL_COL.tonka}"></i>Tonka <i style="background:${CAL_COL.tg}"></i>Train Graphic</span>`;
  const more = nascosti ? `<button type="button" class="lnk ag-more" id="ag-more">Vedi tutta la settimana (${nascosti} ${nascosti === 1 ? 'altro impegno' : 'altri impegni'})</button>`
    : (agendaTutta ? '<button type="button" class="lnk ag-more" id="ag-more">Mostra solo i prossimi giorni</button>' : '');
  box.innerHTML = `<div class="agenda">${html}</div>${more}<div class="ag-foot">${foot}</div>`;
  box.querySelectorAll('[data-ai]').forEach(r => bindOpen(r, () => acts[+r.dataset.ai] && acts[+r.dataset.ai]()));
}

/* ---------- TASK ---------- */
function taskDueBadge(t) {
  if (!t.scadenza || t.completato) return '';
  const d = daysTo(t.scadenza);
  const [label, cls] = d < 0 ? ['Scaduto', 'b-red'] : d === 0 ? ['Oggi', 'b-amber'] : d === 1 ? ['Domani', 'b-amber'] : [fmtD(t.scadenza), 'b-gray'];
  return ` <span class="badge ${cls} tdue">${label}</span>`;
}
function renderTasks(box, progettoId) {
  // Dashboard (progettoId null): i task completati spariscono dalla lista ma restano nella commessa
  const list = S.task.filter(t => progettoId ? t.progettoId === progettoId : (!t.completato || showDone))
    .sort((a, b) => (a.completato - b.completato) || (kTask(a) - kTask(b)));
  box.innerHTML = `
    <div class="task-add"><input placeholder="Aggiungi task…" aria-label="Nuovo task" data-focuskey="taskadd-${progettoId || 'home'}"><button class="btn sm" type="button">Aggiungi</button></div>
    ${list.length ? '' : `<div class="empty">${progettoId || S.task.length === 0 ? 'Nessun task.' : 'Niente da fare, tutto completato.'}</div>`}
    ${list.map(t => {
      const p = !progettoId && t.progettoId ? S.progetti.find(x => x.id === t.progettoId) : null;
      return `<div class="task ${t.completato ? 'done' : ''}" data-id="${t.id}">
        ${t.completato ? '<span class="grip off" aria-hidden="true"></span>' : '<span class="grip" aria-hidden="true"><svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></svg></span>'}<button type="button" class="check ${t.completato ? 'on' : ''}" aria-label="${t.completato ? 'Segna da fare' : 'Segna fatto'}"></button>
        <div class="t${p ? ' link' : ''}"${p ? ` role="button" tabindex="0" aria-label="Apri la commessa ${esc(p.titolo)}"` : ''}><span class="tt">${esc(t.titolo)}</span>${taskDueBadge(t)}${p ? `<div class="tsub">${p.clienteId && cliente(p.clienteId) ? `<b>${esc(cNome(p.clienteId))}</b><i>·</i>` : ''}<span>${esc(p.titolo)}</span></div>` : ''}</div>
        <button type="button" class="ed" aria-label="Modifica task"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg></button>
        <button type="button" class="x" aria-label="Elimina task">×</button></div>`;
    }).join('')}`;
  const inp = box.querySelector('input');
  const add = async () => {
    const t = inp.value.trim(); if (!t || !db) return;
    inp.value = '';
    // i task nuovi vanno in cima
    const aperti = S.task.filter(x => !x.completato);
    const ordine = aperti.length ? Math.min(...aperti.map(kTask)) - 1 : Date.now();
    await create('task', { titolo: t, completato: false, progettoId: progettoId || null, scadenza: null, ordine });
  };
  box.querySelector('.task-add button').onclick = add;
  // la maniglia risponde al tocco da sola (il telefono non "aggancia" il tocco al pallino accanto) e non apre nulla
  box.querySelectorAll('.grip').forEach(g => g.addEventListener('click', e => e.stopPropagation()));
  if (!box.dataset.dnd) {
    box.dataset.dnd = '1';
    trascinabile({ root: box, item: '.task:not(.done)', lists: () => [box], onDrop: ({ order }) => riordinaTask(order) });
  }
  inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  box.querySelectorAll('.task').forEach(el => {
    const t = S.task.find(x => x.id === el.dataset.id);
    el.querySelector('.check').onclick = () => put('task', t.id, { ...t, completato: !t.completato });
    // dalla lista generale: toccando il task si apre la commessa intera
    const link = el.querySelector('.t.link');
    if (link) {
      // tocco sul testo: apre la commessa; matita: modifica qui (come per gli altri task)
      bindOpen(link, () => { if (link.querySelector('.tedit-wrap')) return; const pr = S.progetti.find(x => x.id === t.progettoId); if (pr) formProgetto(pr); });
      el.querySelector('.ed').onclick = () => { if (!link.querySelector('.tedit-wrap')) editTask(el, t, box, progettoId); };
    } else {
      // dentro la commessa (o task senza commessa): toccando il testo o la matita si modifica il titolo
      const cell = el.querySelector('.t');
      cell.classList.add('editable'); cell.setAttribute('role', 'button'); cell.tabIndex = 0; cell.setAttribute('aria-label', 'Modifica task ' + (t.titolo || ''));
      // i tocchi dentro l'editor già aperto (titolo, data, ×, Fatto) non devono riaprirlo da capo
      const start = () => { if (!cell.querySelector('.tedit-wrap')) editTask(el, t, box, progettoId); };
      bindOpen(cell, start);
      el.querySelector('.ed').onclick = start;
    }
    // elimina subito ma si può annullare per qualche secondo
    el.querySelector('.x').onclick = () => {
      const copia = { ...t };
      remove('task', t.id).then(() => toast(`Task eliminato: ${copia.titolo || ''}`, { label: 'Annulla', fn: () => put('task', copia.id, copia) })).catch(() => {});
    };
  });
}
function editTask(el, t, box, progettoId) {
  const cell = el.querySelector('.t');
  const wrap = document.createElement('div'); wrap.className = 'tedit-wrap';
  wrap.innerHTML = `<input class="tedit" type="text" aria-label="Titolo del task" value="${esc(t.titolo || '')}">
    <div class="tedit-row">
      ${dateField('class="tedit-date" aria-label="Scadenza del task (facoltativa)"', t.scadenza)}
      <button type="button" class="btn sm tedit-ok">Fatto</button>
    </div>`;
  cell.replaceChildren(wrap); cell.removeAttribute('role'); cell.removeAttribute('aria-label');
  const inp = wrap.querySelector('.tedit'), dateInp = wrap.querySelector('.tedit-date');
  inp.enterKeyHint = 'done'; inp.focus(); inp.select();
  let done = false;
  const finish = save => {
    if (done) return; done = true;
    if (save) {
      const v = inp.value.trim(), d = dateInp.value || null;
      if (v && (v !== t.titolo || d !== (t.scadenza || null))) {
        const upd = { ...t, titolo: v, scadenza: d };
        Object.assign(t, upd);
        put('task', t.id, upd).catch(() => {});
      }
    }
    renderTasks(box, progettoId);
  };
  const onKeyDone = e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
  };
  inp.onkeydown = onKeyDone; dateInp.onkeydown = onKeyDone;
  wrap.querySelector('.tedit-ok').onclick = () => finish(true);
  // si salva quando il focus esce del tutto dal blocco titolo+data (non ad ogni singolo campo)
  wrap.addEventListener('focusout', () => setTimeout(() => { if (!wrap.contains(document.activeElement)) finish(true); }, 80));
}

/* ---------- NOTE ---------- */
// nota = { testo, links: [{ t: 'c' | 'p', id }], cartellaId, pinned, createdAt, updatedAt }. La prima riga del testo è il titolo.
// cartella = { nome, parentId } (parentId null = livello principale)
let noteQuery = '';
let noteFolder = 'all';     // 'all' (Tutte) | 'base' (cartella Note) | id cartella
let noteSel = null;         // nota aperta
let notePane = 'folders';   // su telefono si vede una colonna alla volta: 'folders' | 'list' | 'note'
let noteFocus = false;      // dopo "Nuova nota" il cursore va nel titolo
let noteDraft = null;       // modifiche non ancora salvate { id, patch }
let noteSaveT = null;
let noteLastSaved = null;   // ultimo salvataggio: se arriva un aggiornamento più vecchio non lo sovrascrive
const noteNuove = new Set(); // note create in questa sessione (solo queste possono sparire se lasciate vuote)
const folderClosed = new Set();
const isNarrow = () => matchMedia('(max-width: 900px)').matches;
const ic = (d, s = 18, col) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="${col || 'currentColor'}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const I_FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const I_FOLDER_PLUS = I_FOLDER + '<path d="M12 10.5v5M9.5 13h5"/>';
const I_ALL = '<path d="M4 6h16M4 12h16M4 18h10"/>';
const I_PIN = '<path d="M12 17v5"/><path d="M8.5 3h7l-1 6 3 3v2h-11v-2l3-3z"/>';
const I_TRASH = '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>';
const I_COMPOSE = '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>';

const dataNota = n => n.updatedAt || n.createdAt || '';
const noteOrdinate = () => S.note.slice().sort((a, b) => String(dataNota(b)).localeCompare(String(dataNota(a))));
const titoloNota = n => (String(n.testo || '').split('\n').find(l => l.trim()) || 'Nuova nota').trim();
function anteprimaNota(n) {
  const righe = String(n.testo || '').split('\n').map(l => l.trim()).filter(Boolean);
  return righe.slice(1).join(' · ').slice(0, 160);
}
// collegamenti ancora validi (se un cliente o progetto viene eliminato, l'etichetta sparisce)
function linkValidi(n) {
  return (n.links || []).filter(l => l.t === 'c' ? cliente(l.id) : S.progetti.some(p => p.id === l.id));
}
function nomeLink(l) {
  if (l.t === 'c') return cNome(l.id);
  const p = S.progetti.find(x => x.id === l.id);
  return p ? p.titolo : '—';
}
// etichetta: per i progetti mostra prima il cliente (il nome della commessa spesso non lo contiene)
function etichettaLink(l) {
  if (l.t === 'c') return cNome(l.id);
  const p = S.progetti.find(x => x.id === l.id);
  return p ? (p.clienteId && cliente(p.clienteId) ? cNome(p.clienteId) + ' · ' : '') + p.titolo : '—';
}
const chipLink = (l, rm) => `<span class="lchip ${l.t === 'c' ? 'lc' : 'lp'}">@${esc(etichettaLink(l))}${rm ? `<button type="button" data-rm="${l.t}:${l.id}" aria-label="Scollega ${esc(nomeLink(l))}">×</button>` : ''}</span>`;
// note di un progetto, o di un cliente (anche quelle che citano un suo progetto)
function noteDi(t, id) {
  const pids = t === 'c' ? S.progetti.filter(p => p.clienteId === id).map(p => p.id) : [];
  return noteOrdinate().filter(n => (n.links || []).some(l => (l.t === t && l.id === id) || (l.t === 'p' && pids.includes(l.id))));
}
// riga compatta (Dashboard, dentro progetti e clienti)
function rigaNota(n) {
  const links = linkValidi(n), ant = anteprimaNota(n);
  return `<div class="row nrow" data-nid="${n.id}" tabindex="0" role="button">
    <div class="main"><div class="ttl">${esc(titoloNota(n))}</div>
      ${ant ? `<div class="sub">${esc(ant)}</div>` : ''}
      ${links.length ? `<div class="ntags">${links.map(l => chipLink(l)).join('')}</div>` : ''}</div>
    <span class="small ndate">${dataNota(n) ? fmtD(dataNota(n).slice(0, 10)) : ''}</span></div>`;
}
function bindNoteRows(box, before) {
  if (!box) return;
  box.querySelectorAll('[data-nid]').forEach(r => bindOpen(r, () => { if (before) before(); openNota(r.dataset.nid); }));
}
// sezione "Note" dentro progetto/cliente
function sezioneNote(t, id, close) {
  const list = noteDi(t, id);
  const sec = document.createElement('div'); sec.className = 'sub-sec';
  sec.innerHTML = `<h4>Note${list.length ? ` <span class="aside">${list.length}</span>` : ''}<button type="button" class="lnk nadd">+ Nuova nota</button></h4>
    <div class="rows">${list.length ? list.map(rigaNota).join('') : '<div class="empty">Nessuna nota collegata.</div>'}</div>`;
  bindNoteRows(sec, close);
  sec.querySelector('.nadd').onclick = () => { close(); nuovaNota([{ t, id }]); };
  return sec;
}

/* cartelle */
const cartella = id => S.cartelle.find(c => c.id === id);
const genitore = c => (c.parentId && c.parentId !== c.id && cartella(c.parentId)) ? c.parentId : null;
const figli = id => S.cartelle.filter(c => genitore(c) === id);
function discendenti(id, seen = new Set()) {
  figli(id).forEach(c => { if (!seen.has(c.id) && c.id !== id) { seen.add(c.id); discendenti(c.id, seen); } });
  return seen;
}
const cartellaDi = n => (n.cartellaId && cartella(n.cartellaId)) ? n.cartellaId : null;
function noteInCartella(f) {
  if (f === 'all') return S.note;
  if (f === 'base') return S.note.filter(n => !cartellaDi(n));
  const ids = discendenti(f); ids.add(f);
  return S.note.filter(n => ids.has(cartellaDi(n)));
}
const nomeCartella = f => f === 'all' ? 'Tutte' : (!f || f === 'base') ? 'Note' : (cartella(f)?.nome || 'Note');
function percorsoCartella(id) {
  const out = []; let c = id && cartella(id), guard = 0;
  while (c && guard++ < 20) { out.unshift(c.nome); c = genitore(c) && cartella(genitore(c)); }
  return out.join(' / ') || 'Note';
}
// albero piatto (per i menu a tendina)
function alberoCartelle(parent = null, depth = 0, out = [], seen = new Set()) {
  figli(parent).slice().sort(byName).forEach(c => {
    if (seen.has(c.id) || depth > 12) return;
    seen.add(c.id); out.push({ c, depth }); alberoCartelle(c.id, depth + 1, out, seen);
  });
  return out;
}

/* salvataggio automatico */
function draftNota(id, patch, subito) {
  const n = S.note.find(x => x.id === id); if (!n) return;
  Object.assign(n, patch, { updatedAt: new Date().toISOString() });
  const dEl = noteSel === id && document.querySelector('#ned .ndatefull'); if (dEl) dEl.textContent = dataLunga(n.updatedAt);
  noteDraft = { id, patch: { ...(noteDraft && noteDraft.id === id ? noteDraft.patch : {}), ...patch, updatedAt: n.updatedAt } };
  clearTimeout(noteSaveT); noteSaveT = setTimeout(flushNoteSave, subito ? 0 : 700);
}
function flushNoteSave(ridisegna = true) {
  clearTimeout(noteSaveT); noteSaveT = null;
  if (!noteDraft || !db) return;
  const d = noteDraft; noteDraft = null;
  const n = S.note.find(x => x.id === d.id); if (!n) return;
  Object.assign(n, d.patch);
  noteLastSaved = { id: d.id, patch: d.patch, t: Date.now() };
  put('note', n.id, { ...n }).catch(() => {});
  if (ridisegna) noteSoft();
}
function salvaNota(n) { flushNoteSave(); put('note', n.id, { ...n }).catch(() => {}); }
// una nota nuova lasciata vuota sparisce, come sul Mac
function cleanupEmpty(id) {
  if (!id || !noteNuove.has(id)) return;
  const n = S.note.find(x => x.id === id);
  if (n && !String(n.testo || '').trim() && !(n.links || []).length) {
    noteNuove.delete(id);
    S.note = S.note.filter(x => x.id !== id);
    if (noteSel === id) noteSel = null;
    remove('note', id).catch(() => {});
  }
}
function lasciaNota() { flushNoteSave(); cleanupEmpty(noteSel); }

/* apertura da altre sezioni */
function openNota(id) {
  if (id !== noteSel) lasciaNota();
  noteSel = id; notePane = 'note'; noteQuery = '';
  const n = S.note.find(x => x.id === id);
  if (n && noteFolder !== 'all' && !noteInCartella(noteFolder).includes(n)) noteFolder = 'all';
  if (tab !== 'note') goTab('note'); else { render(); scrollWrapTop(); }
}
async function nuovaNota(links) {
  if (!db) return;
  lasciaNota();
  const folder = tab === 'note' && noteFolder !== 'all' && noteFolder !== 'base' && cartella(noteFolder) ? noteFolder : null;
  const now = new Date().toISOString();
  const data = { testo: '', links: links || [], cartellaId: folder, pinned: false, updatedAt: now };
  let id;
  try { id = await create('note', data); } catch (e) { return; }
  if (!id) return;
  noteNuove.add(id);
  if (!S.note.some(n => n.id === id)) S.note.push({ id, ...data, createdAt: now });
  noteSel = id; notePane = 'note'; noteQuery = ''; noteFocus = true;
  if (tab !== 'note') goTab('note'); else { render(); scrollWrapTop(); }
}
function scrollWrapTop() { window.scrollTo(0, 0); const w = document.querySelector('.wrap'); if (w) w.scrollTop = 0; }
function goPane(p) {
  if (notePane === 'note' && p !== 'note') lasciaNota();
  notePane = p; render(); scrollWrapTop();
}
function moveNota(id, folderId) {
  const n = S.note.find(x => x.id === id); if (!n) return;
  flushNoteSave();
  n.cartellaId = folderId || null;
  salvaNota(n);
  drawFolders(); drawList(); if (noteSel === id) drawEditor();
}

/* vista */
function vNote(v) {
  if (noteSel && !S.note.some(n => n.id === noteSel)) noteSel = null;
  if (noteFolder !== 'all' && noteFolder !== 'base' && !cartella(noteFolder)) noteFolder = 'all';
  if (!noteSel && !isNarrow()) { const l = listaNote(); noteSel = (l.find(n => n.pinned) || l[0])?.id || null; }
  v.innerHTML = `<div class="nwrap pane-${notePane}">
    <aside class="ncol nfold" id="nfold" aria-label="Cartelle"></aside>
    <section class="ncol nlist" id="nlistc" aria-label="Elenco note">
      <div class="nlh">
        <button type="button" class="nback" data-pane="folders">‹ Cartelle</button>
        <div class="nlh-row"><div style="min-width:0"><div class="nlh-t"></div><div class="nlh-n"></div></div>
          <button type="button" class="nbtn" id="nnew" aria-label="Nuova nota" title="Nuova nota">${ic(I_COMPOSE, 20)}</button></div>
        <input class="search" id="nsearch" type="search" placeholder="Cerca in tutte le note…" aria-label="Cerca note" value="${esc(noteQuery)}">
      </div>
      <div id="nitems"></div>
    </section>
    <section class="ncol ned" id="ned" aria-label="Nota"></section></div>`;
  v.querySelector('#nnew').onclick = () => nuovaNota();
  v.querySelectorAll('.nlh [data-pane]').forEach(b => b.onclick = () => goPane(b.dataset.pane));
  const s = v.querySelector('#nsearch');
  s.oninput = () => { noteQuery = s.value; drawFolders(); drawList(); };
  drawFolders(); drawList(); drawEditor();
  if (noteFocus) { noteFocus = false; const t = document.getElementById('ntitle'); if (t) t.focus(); }
}
// aggiornamento leggero mentre si scrive: non tocca la nota aperta
function noteSoft() { if (tab !== 'note' || !document.getElementById('nfold')) return; drawFolders(); drawList(); }

function drawFolders() {
  const box = document.getElementById('nfold'); if (!box) return;
  const q = noteQuery.trim();
  const row = (f, label, icon, depth, caret, more) => `<div class="frow ${noteFolder === f && !q ? 'on' : ''}" data-f="${f}"${f !== 'all' ? ` data-drop="${f}"` : ''} tabindex="0" role="button" style="--d:${depth}">
      ${caret || '<span class="fcaret"></span>'}${ic(icon, 18)}<span class="fname">${esc(label)}</span><span class="fcount">${noteInCartella(f).length}</span>
      ${more ? `<button type="button" class="fmore" data-edit="${f}" aria-label="Opzioni cartella ${esc(label)}">…</button>` : ''}</div>`;
  const tree = (parent, depth, seen) => figli(parent).slice().sort(byName).map(c => {
    if (seen.has(c.id) || depth > 12) return '';
    seen.add(c.id);
    const kids = figli(c.id).length > 0, closed = folderClosed.has(c.id);
    const caret = kids ? `<button type="button" class="fcaret" data-toggle="${c.id}" aria-expanded="${!closed}" aria-label="${closed ? 'Apri' : 'Chiudi'} ${esc(c.nome)}">${closed ? '›' : '⌄'}</button>` : '';
    return row(c.id, c.nome, I_FOLDER, depth, caret, true) + (kids && !closed ? tree(c.id, depth + 1, seen) : '');
  }).join('');
  box.innerHTML = `<div class="nfh"><span>Cartelle</span><button type="button" class="nbtn" id="fnew" aria-label="Nuova cartella" title="Nuova cartella">${ic(I_FOLDER_PLUS, 20)}</button></div>
    ${row('all', 'Tutte', I_ALL, 0)}${row('base', 'Note', I_FOLDER, 0)}
    ${S.cartelle.length ? '<div class="fsep"></div>' + tree(null, 0, new Set()) : '<div class="fhint">Crea cartelle con il tasto in alto, anche una dentro l\'altra.</div>'}`;
  box.querySelector('#fnew').onclick = () => formCartella(null, null);
  box.querySelectorAll('.frow').forEach(r => bindOpen(r, () => {
    lasciaNota();
    noteFolder = r.dataset.f; noteQuery = ''; noteSel = null; notePane = 'list';
    render(); if (isNarrow()) scrollWrapTop();
  }));
  box.querySelectorAll('[data-toggle]').forEach(b => b.onclick = e => {
    e.stopPropagation(); const id = b.dataset.toggle;
    folderClosed.has(id) ? folderClosed.delete(id) : folderClosed.add(id); drawFolders();
  });
  box.querySelectorAll('[data-edit]').forEach(b => b.onclick = e => { e.stopPropagation(); formCartella(cartella(b.dataset.edit)); });
  // trascina una nota su una cartella per spostarla (da computer)
  box.querySelectorAll('[data-drop]').forEach(r => {
    r.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; r.classList.add('drop'); });
    r.addEventListener('dragleave', () => r.classList.remove('drop'));
    r.addEventListener('drop', e => {
      e.preventDefault(); r.classList.remove('drop');
      const id = e.dataTransfer.getData('text/plain'); if (id) moveNota(id, r.dataset.drop === 'base' ? null : r.dataset.drop);
    });
  });
}

function listaNote() {
  const q = noteQuery.trim().toLowerCase().replace(/^@/, '');
  const src = q ? S.note : noteInCartella(noteFolder);
  return src.filter(n => !q || [n.testo, ...linkValidi(n).map(etichettaLink)].join(' ').toLowerCase().includes(q))
    .sort((a, b) => String(dataNota(b)).localeCompare(String(dataNota(a))));
}
function dataBreve(iso) {
  if (!iso) return '';
  const d = new Date(iso), oggi = new Date();
  if (d.toDateString() === oggi.toDateString()) return d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  const giorni = (new Date(oggi.toDateString()) - new Date(d.toDateString())) / 864e5;
  if (giorni === 1) return 'ieri';
  if (giorni > 1 && giorni < 7) return d.toLocaleDateString('it-IT', { weekday: 'long' });
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function dataLunga(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) + ' alle ore ' + d.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}
function itemNota(n) {
  const links = linkValidi(n);
  return `<div class="nitem ${n.id === noteSel ? 'on' : ''}" data-nid="${n.id}" tabindex="0" role="button"${isNarrow() ? '' : ' draggable="true"'}>
    <div class="nt">${n.pinned ? `<span class="npin-mini">${ic(I_PIN, 13)}</span>` : ''}${esc(titoloNota(n))}</div>
    <div class="nmeta"><b>${esc(dataBreve(dataNota(n)))}</b>${esc(anteprimaNota(n) || 'Nessun altro testo')}</div>
    <div class="nfolder">${ic(I_FOLDER, 13)}<span>${esc(nomeCartella(cartellaDi(n) || 'base'))}${links.length ? ' · @' + esc(etichettaLink(links[0])) + (links.length > 1 ? ' +' + (links.length - 1) : '') : ''}</span></div>
  </div>`;
}
function drawList() {
  const col = document.getElementById('nlistc'); if (!col) return;
  const list = listaNote(), q = noteQuery.trim();
  col.querySelector('.nlh-t').textContent = q ? 'Risultati' : nomeCartella(noteFolder);
  col.querySelector('.nlh-n').textContent = list.length + (list.length === 1 ? ' nota' : ' note');
  const pin = list.filter(n => n.pinned), rest = list.filter(n => !n.pinned);
  const box = col.querySelector('#nitems');
  box.innerHTML = list.length
    ? (pin.length ? `<div class="ngh">In evidenza</div>${pin.map(itemNota).join('')}${rest.length ? '<div class="ngh">Altre note</div>' : ''}` : '') + rest.map(itemNota).join('')
    : `<div class="empty" style="padding:16px 20px">${q ? 'Nessuna nota trovata.' : 'Nessuna nota in questa cartella.'}</div>`;
  box.querySelectorAll('[data-nid]').forEach(el => {
    bindOpen(el, () => {
      const id = el.dataset.nid;
      if (id !== noteSel) lasciaNota();
      noteSel = id; notePane = 'note';
      if (isNarrow()) { render(); scrollWrapTop(); } else { drawList(); drawEditor(); drawFolders(); }
    });
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', el.dataset.nid); e.dataTransfer.effectAllowed = 'move'; });
  });
}

function drawEditor() {
  const box = document.getElementById('ned'); if (!box) return;
  const n = S.note.find(x => x.id === noteSel);
  const back = `<button type="button" class="nback" data-pane="list">‹ ${esc(noteQuery.trim() ? 'Risultati' : nomeCartella(noteFolder))}</button>`;
  if (!n) {
    box.innerHTML = `<div class="ned-top">${back}</div><div class="nempty">${S.note.length ? 'Seleziona una nota o creane una nuova.' : 'Nessuna nota. Creane una con il tasto matita.'}</div>`;
    box.querySelector('[data-pane]').onclick = () => goPane('list');
    return;
  }
  const t = String(n.testo || ''), i = t.indexOf('\n');
  const tit = i < 0 ? t : t.slice(0, i), body = i < 0 ? '' : t.slice(i + 1);
  const opts = [['', 'Note'], ...alberoCartelle().map(({ c, depth }) => [c.id, '   '.repeat(depth) + c.nome])];
  box.innerHTML = `<div class="ned-top">${back}
      <span class="ndatefull">${dataNota(n) ? esc(dataLunga(dataNota(n))) : ''}</span>
      <div class="ntools">
        <button type="button" class="nbtn nproj" id="nproj" title="Crea un progetto da questa nota">${ic(ICONS.progetti, 17)}<span class="nlab">Crea progetto</span></button>
        <button type="button" class="nbtn" id="npin" aria-pressed="${!!n.pinned}" aria-label="${n.pinned ? 'Togli da In evidenza' : 'Metti in evidenza'}" title="${n.pinned ? 'Togli da In evidenza' : 'Metti in evidenza'}">${ic(I_PIN, 18)}</button>
        <span class="nmove-w" title="Sposta in cartella">${ic(I_FOLDER, 16)}<select class="nmove" id="nmove" aria-label="Sposta in cartella">${opts.map(([v, l]) => `<option value="${v}" ${(cartellaDi(n) || '') === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></span>
        <button type="button" class="nbtn ndel" id="ndel" aria-label="Elimina nota" title="Elimina nota">${ic(I_TRASH, 18)}</button>
      </div></div>
    <div class="ned-body">
      <div class="field linkf" id="nlinks"></div>
      <textarea class="ntitle" id="ntitle" rows="1" placeholder="Titolo" enterkeyhint="next" aria-label="Titolo della nota">${esc(tit)}</textarea>
      <textarea class="nbody" id="nbody" placeholder="Scrivi qui…" aria-label="Testo della nota">${esc(body)}</textarea>
    </div>`;
  const id = n.id;
  box.querySelector('[data-pane]').onclick = () => goPane('list');
  const tEl = box.querySelector('#ntitle'), bEl = box.querySelector('#nbody');
  const grow = () => { bEl.style.height = 'auto'; bEl.style.height = Math.max(bEl.scrollHeight, 260) + 'px'; };
  const growT = () => { tEl.style.height = 'auto'; tEl.style.height = tEl.scrollHeight + 'px'; };
  requestAnimationFrame(() => { grow(); growT(); });
  const edit = () => draftNota(id, { testo: tEl.value + (bEl.value ? '\n' + bEl.value : '') });
  // il titolo è una sola riga (va a capo solo visivamente): niente invii dentro
  tEl.oninput = () => { if (tEl.value.includes('\n')) { const c = tEl.selectionStart; tEl.value = tEl.value.replace(/\n+/g, ' '); tEl.setSelectionRange(c, c); } growT(); edit(); };
  bEl.oninput = () => { grow(); edit(); };
  tEl.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); bEl.focus(); bEl.setSelectionRange(0, 0); } };
  bEl.onkeydown = e => {
    if (e.key === 'Backspace' && bEl.selectionStart === 0 && bEl.selectionEnd === 0) { e.preventDefault(); tEl.focus(); const l = tEl.value.length; tEl.setSelectionRange(l, l); }
  };
  // salvataggio "silenzioso": niente ridisegno mentre si sta toccando un'altra nota (il click andrebbe perso)
  tEl.onblur = bEl.onblur = () => flushNoteSave(false);
  box.querySelector('#npin').onclick = () => { const x = S.note.find(y => y.id === id); if (!x) return; x.pinned = !x.pinned; salvaNota(x); drawList(); drawEditor(); };
  box.querySelector('#nmove').onchange = e => moveNota(id, e.target.value || null);
  box.querySelector('#nproj').onclick = () => creaProgettoDaNota(id);
  const del = box.querySelector('#ndel');
  del.onclick = () => {
    if (!del.dataset.armed) {
      del.dataset.armed = '1'; del.classList.add('armed'); del.innerHTML = 'Elimina?';
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.classList.remove('armed'); del.innerHTML = ic(I_TRASH, 18); } }, 4000);
      return;
    }
    noteDraft = null; clearTimeout(noteSaveT);
    S.note = S.note.filter(x => x.id !== id);
    remove('note', id).catch(() => {});
    noteSel = null; notePane = 'list'; render();
  };
  mountLinkField(box.querySelector('#nlinks'), (n.links || []).slice(), links => { draftNota(id, { links }, true); });
}

// crea progetto da nota: finestra "Nuovo progetto" precompilata; al salvataggio la nota viene collegata al progetto
function creaProgettoDaNota(id) {
  flushNoteSave();
  const n = S.note.find(x => x.id === id); if (!n) return;
  const t = String(n.testo || ''), i = t.indexOf('\n');
  const titolo = (i < 0 ? t : t.slice(0, i)).trim() || titoloNota(n);
  const corpo = i < 0 ? '' : t.slice(i + 1).trim();
  const links = linkValidi(n);
  let clienteId = links.find(l => l.t === 'c')?.id || '';
  if (!clienteId) { const lp = links.find(l => l.t === 'p'); clienteId = (lp && S.progetti.find(p => p.id === lp.id)?.clienteId) || ''; }
  formProgetto(null, { titolo, clienteId, descrizione: corpo, stato: 'preventivo' }, newId => {
    const x = S.note.find(y => y.id === id); if (!x) return;
    draftNota(id, { links: [...(x.links || []), { t: 'p', id: newId }] }, true);
  });
}

// campo "Collegata a": @ + nome, suggerimenti di clienti e progetti, etichette rimovibili
function mountLinkField(f, links, onChange) {
  f.innerHTML = `<label for="m-link">Collegata a</label>
    <div class="chips-in"><span class="lchips"></span><input id="m-link" type="text" autocomplete="off" enterkeyhint="done" placeholder="Scrivi @ o un nome…"></div>
    <div class="sugg" role="listbox" hidden></div>`;
  const inp = f.querySelector('input'), sugg = f.querySelector('.sugg'), chips = f.querySelector('.lchips');
  let found = [], sel = 0;
  const valido = l => l.t === 'c' ? cliente(l.id) : S.progetti.some(p => p.id === l.id);
  const drawChips = () => {
    chips.innerHTML = links.filter(valido).map(l => chipLink(l, true)).join('');
    chips.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => {
      const [t, id] = b.dataset.rm.split(':'); links = links.filter(l => !(l.t === t && l.id === id)); drawChips(); onChange(links.slice()); inp.focus();
    });
  };
  const has = (t, id) => links.some(l => l.t === t && l.id === id);
  const drawSugg = () => {
    const q = inp.value.trim().replace(/^@/, '').toLowerCase();
    if (!inp.value.trim()) { sugg.hidden = true; return; }
    const all = [
      ...S.progetti.filter(p => !has('p', p.id)).map(p => ({ t: 'p', id: p.id, l: p.titolo, s: 'Progetto' + (p.clienteId ? ' · ' + cNome(p.clienteId) : ''), k: p.titolo + ' ' + cNome(p.clienteId) })),
      ...S.clienti.filter(c => !has('c', c.id)).map(c => ({ t: 'c', id: c.id, l: c.nome, s: 'Cliente', k: c.nome })),
    ];
    found = all.filter(x => !q || String(x.k || '').toLowerCase().includes(q)).slice(0, 8);
    sel = 0;
    sugg.innerHTML = found.length ? found.map((x, i) => `<button type="button" role="option" data-i="${i}" class="${i === sel ? 'on' : ''}"><span>@${esc(x.l)}</span><small>${esc(x.s)}</small></button>`).join('') : '<div class="small" style="padding:10px 12px">Nessun cliente o progetto trovato.</div>';
    sugg.hidden = false;
    sugg.querySelectorAll('[data-i]').forEach(b => {
      b.onmousedown = e => e.preventDefault(); // non perdere il focus dal campo
      b.onclick = () => pick(found[+b.dataset.i]);
    });
  };
  const pick = x => { if (!x) return; links.push({ t: x.t, id: x.id }); inp.value = ''; sugg.hidden = true; drawChips(); onChange(links.slice()); inp.focus(); };
  inp.oninput = drawSugg;
  inp.onkeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); if (!sugg.hidden) pick(found[sel]); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (sugg.hidden || !found.length) return; e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : found.length - 1)) % found.length;
      sugg.querySelectorAll('[data-i]').forEach((b, i) => b.classList.toggle('on', i === sel));
    }
    else if (e.key === 'Escape' && !sugg.hidden) { e.preventDefault(); e.stopPropagation(); sugg.hidden = true; }
    else if (e.key === 'Backspace' && !inp.value) { const i = links.map(l => !!valido(l)).lastIndexOf(true); if (i >= 0) { links.splice(i, 1); drawChips(); onChange(links.slice()); } }
  };
  inp.onblur = () => setTimeout(() => { sugg.hidden = true; }, 150);
  drawChips();
}

function formCartella(c, parentId) {
  const editing = !!c;
  const vietate = editing ? discendenti(c.id).add(c.id) : new Set();
  openModal({
    title: editing ? 'Modifica cartella' : 'Nuova cartella',
    fields: [
      { k: 'nome', label: 'Nome', req: true },
      { k: 'parentId', label: 'Dentro a', type: 'select', options: [['', 'Livello principale'], ...alberoCartelle().filter(({ c: x }) => !vietate.has(x.id)).map(({ c: x, depth }) => [x.id, '   '.repeat(depth) + x.nome])] },
    ],
    values: { nome: editing ? c.nome : '', parentId: editing ? (genitore(c) || '') : (parentId || '') },
    hint: editing ? 'Se elimini la cartella, le sue note (anche quelle delle sottocartelle) tornano in "Note".' : '',
    buttons: editing ? [{ label: 'Nuova sottocartella', cls: 'ghost', fn: close => { close(); formCartella(null, c.id); } }] : [],
    onDelete: editing ? async () => {
      const ids = discendenti(c.id); ids.add(c.id);
      for (const n of S.note.filter(n => ids.has(cartellaDi(n)))) await put('note', n.id, { ...n, cartellaId: null });
      for (const id of ids) await remove('cartelle', id);
      if (ids.has(noteFolder)) noteFolder = 'all';
    } : null,
    onSave: async val => {
      const data = { nome: val.nome, parentId: val.parentId || null };
      if (editing) await put('cartelle', c.id, { ...c, ...data });
      else {
        const id = await create('cartelle', data);
        if (id) { lasciaNota(); noteFolder = id; noteSel = null; if (!S.cartelle.some(x => x.id === id)) S.cartelle.push({ id, ...data }); }
      }
      if (data.parentId) folderClosed.delete(data.parentId);
    },
  });
}

/* ---------- PROGETTI ---------- */
function vProgetti(v) {
  v.innerHTML = `
    <div class="page-head"><div><h1>Progetti</h1><div class="lede">Tocca per modificare, trascina per riordinare o cambiare colonna. Da telefono tieni premuta la maniglia ⋮⋮.</div></div>
      <button class="btn" id="new">+ Nuovo progetto</button></div>
    <div class="kseg" role="group" aria-label="Stato">${STATI_P.map(([k, l]) => `<button type="button" data-k="${k}" aria-pressed="${kCol === k}">${l}<span class="n">${S.progetti.filter(p => statoP(p) === k).length}</span></button>`).join('')}</div>
    <div class="kanban">${STATI_P.map(([k, l, c]) => {
      const list = progettiColonna(k);
      const tot = list.reduce((s, p) => s + num(p.importo), 0);
      return `<div class="col ${kCol === k ? '' : 'off'}" data-k="${k}"><div class="col-h"><span class="dot" style="background:${c}"></span>${l}<span class="n">${list.length}</span></div>
        ${tot ? `<div class="col-h" style="padding-top:0"><span class="tot">Totale ${euro(tot)}</span></div>` : ''}
        <div class="cards" data-k="${k}">${list.length ? list.map(p => cardProgetto(p)).join('') : '<div class="empty" style="padding:8px 4px">Nessun progetto</div>'}</div></div>`;
    }).join('')}</div>`;
  v.querySelector('#new').onclick = () => formProgetto(null);
  v.querySelectorAll('.kseg button').forEach(b => b.onclick = () => { kCol = b.dataset.k; render(); });
  v.querySelectorAll('.card').forEach(el => {
    const p = S.progetti.find(x => x.id === el.dataset.id);
    bindOpen(el, () => formProgetto(p));
    el.querySelectorAll('.mv button').forEach(b => b.onclick = e => {
      e.stopPropagation();
      const i = STATI_P.findIndex(s => s[0] === statoP(p)) + (+b.dataset.d);
      if (STATI_P[i]) spostaProgetto(p.id, STATI_P[i][0]);
    });
  });
  v.querySelectorAll('.kanban .grip').forEach(g => g.addEventListener('click', e => e.stopPropagation()));
  trascinabile({
    root: v.querySelector('.kanban'), item: '.card', lists: () => [...v.querySelectorAll('.kanban .cards')].filter(x => x.offsetParent),
    extraDrops: () => [...v.querySelectorAll('.kseg button')],
    onDrop: ({ id, to, order, extra }) => {
      if (extra) { if (extra.dataset.k !== statoP(S.progetti.find(x => x.id === id) || {})) spostaProgetto(id, extra.dataset.k); return; }
      riordinaProgetti(to.dataset.k, order, id);
    },
  });
}

function cardProgetto(p) {
  const i = STATI_P.findIndex(s => s[0] === statoP(p));
  const tasks = S.task.filter(t => t.progettoId === p.id);
  const done = tasks.filter(t => t.completato).length;
  const late = p.scadenza && p.stato !== 'completato' && daysTo(p.scadenza) < 0;
  const fatt = fatturaDiProgetto(p.id);
  return `<div class="card" data-id="${p.id}" tabindex="0" role="button"><span class="grip" aria-hidden="true"><svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></svg></span>
    <div class="cl">${esc(cNome(p.clienteId))}</div>
    <div class="tt">${esc(p.titolo)}</div>
    <div class="meta"><span class="amt">${num(p.importo) ? euro(num(p.importo)) : '—'}${num(p.extra) ? ` <span class="badge b-amber" style="margin-left:4px">EXTRA ${euro(num(p.extra))}</span>` : ''}</span>${p.scadenza ? `<span class="${late ? 'late' : ''}">${fmtD(p.scadenza)}</span>` : ''}</div>
    <div class="foot">
      ${badgeFatturazione(p)}
      ${tasks.length ? `<span class="badge b-gray">✓ ${done}/${tasks.length}</span>` : ''}
      <span class="mv">${i > 0 ? '<button type="button" data-d="-1" aria-label="Stato precedente">‹</button>' : ''}${i < STATI_P.length - 1 ? '<button type="button" data-d="1" aria-label="Stato successivo">›</button>' : ''}</span>
    </div></div>`;
}

function badgeFatturazione(p) {
  const res = residuo(p), linked = fattureDiProgetto(p.id);
  if (p.stato === 'completato' && res > 0) return `<span class="badge b-red">Da fatturare ${euro(res)}</span>`;
  if (!linked.length) return p.stato === 'completato' && !num(p.importo) ? '<span class="badge b-gray">Senza compenso</span>' : '';
  if (res > 0) return `<span class="badge b-gray">Fatturati ${euro(fatturatoProgetto(p))}</span>`;
  const aperte = linked.filter(f => f.stato !== 'pagata');
  return aperte.length ? `<span class="badge ${aperte.some(f => statoF(f) === 'scaduta') ? 'b-red' : 'b-blue'}">Da incassare</span>` : '<span class="badge b-green">Pagato</span>';
}

function clienteOptions() { return [['', 'Nessuno'], ...S.clienti.slice().sort(byName).map(c => [c.id, c.nome])]; }

// preset: valori iniziali di un progetto nuovo (es. da una nota); onCreated(id): chiamata dopo la creazione
function formProgetto(p, preset, onCreated) {
  const editing = !!p;
  p = p || { titolo: '', clienteId: '', descrizione: '', stato: 'in_corso', importo: '', extra: '', scadenza: '', note: '', ...(preset || {}) };
  const pending = []; let pendingInp = null; // task da creare insieme al progetto nuovo
  let createdId = null; // se un salvataggio fallisce a metà, il secondo tentativo non crea un progetto doppio
  let costiUI = null;
  const linked = editing ? fattureDiProgetto(p.id) : [];
  const res = editing ? residuo(p) : 0;
  // "Descrizione" e "Note" erano due campi identici e senza differenza d'uso: un solo campo, più ampio.
  // Per le commesse già salvate con entrambi valorizzati, li unisco in visualizzazione senza perdere nulla.
  const noteUnite = [p.descrizione, p.note].filter(v => v && v.trim()).join('\n\n');
  openModal({
    title: editing ? 'Modifica progetto' : 'Nuovo progetto',
    fields: [
      { k: 'titolo', label: 'Titolo', req: true },
      { k: 'clienteId', label: 'Cliente', type: 'select', options: clienteOptions(), half: true },
      { k: 'stato', label: 'Stato', type: 'select', options: STATI_P.map(s => [s[0], s[1]]), half: true },
      { k: 'importo', label: 'Valore commessa (€)', type: 'number', half: true },
      { k: 'extra', label: 'EXTRA (€)', type: 'number', half: true },
      { k: 'scadenza', label: 'Scadenza', type: 'date', half: true },
      { k: 'descrizione', label: 'Descrizione e note', type: 'textarea', big: true },
    ],
    values: { ...p, stato: statoP(p), descrizione: noteUnite },
    hint: 'EXTRA = parte fatturata da collaboratori: non la devi fatturare tu e non conta per limite e tasse.',
    extra: editing ? (box, close) => {
      const sec = document.createElement('div'); sec.className = 'sub-sec';
      sec.innerHTML = `<h4>Task del progetto</h4><div></div>
        <h4 style="margin-top:14px">Fatture collegate</h4>
        <div class="small">${linked.length ? linked.map(f => `${fmtD(f.dataEmissione)} · <b>${euro(quotaFattura(f, p.id))}</b>${multiProgetto(f) ? ` <span style="opacity:.7">di ${euro(num(f.importo))}, fattura con ${f.righe.length} progetti</span>` : ''}${isExtra(f) ? ' (EXTRA)' : ''} · ${STATI_F[f.stato]?.[0] || ''}`).join('<br>') + (res > 0 ? `<br>Resta da fatturare: <b>${euro(res)}</b>` : '') : 'Nessuna fattura collegata.'}</div>`;
      box.appendChild(sec);
      costiUI = mountCosti(box, costiDi(p));
      box.appendChild(sezioneNote('p', p.id, close));
      const tb = sec.querySelector('div');
      renderTasks(tb, p.id);
      // non toccare la lista mentre si modifica un task o si sta scrivendo un task nuovo; altrimenti aggiorna e rimetti il cursore
      return () => {
        const a = document.activeElement;
        if (tb.querySelector('.tedit') || (tb.contains(a) && a.value)) return;
        const refocus = tb.contains(a) && a.dataset && a.dataset.focuskey;
        renderTasks(tb, p.id);
        if (refocus) { const el = tb.querySelector('[data-focuskey]'); if (el) el.focus({ preventScroll: true }); }
      };
    } : box => {
      // progetto nuovo: task scritti a mano, creati al salvataggio
      const sec = document.createElement('div'); sec.className = 'sub-sec';
      sec.innerHTML = `<h4>Task</h4><div class="task-add"><input placeholder="Aggiungi task…" aria-label="Nuovo task" enterkeyhint="done"><button class="btn sm" type="button">Aggiungi</button></div><div class="ptasks"></div>`;
      box.appendChild(sec);
      costiUI = mountCosti(box, []);
      const inp = pendingInp = sec.querySelector('input'), list = sec.querySelector('.ptasks');
      const draw = () => {
        list.innerHTML = pending.length ? pending.map((t, i) => `<div class="task"><span class="check" aria-hidden="true"></span><div class="t"><span class="tt">${esc(t)}</span></div><button type="button" class="x" data-i="${i}" aria-label="Togli il task ${esc(t)}">×</button></div>`).join('')
          : '<div class="empty" style="padding:8px 2px">I task che aggiungi qui vengono creati insieme al progetto.</div>';
        list.querySelectorAll('[data-i]').forEach(b => b.onclick = () => { pending.splice(+b.dataset.i, 1); draw(); });
      };
      const add = () => { const v = inp.value.trim(); if (!v) return; pending.push(v); inp.value = ''; draw(); inp.focus(); };
      sec.querySelector('.task-add button').onclick = add;
      inp.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
      draw();
      return null;
    },
    buttons: [
      editing && res > 0 ? { label: 'Crea fattura', cls: 'ghost', fn: close => { close(); formFattura(null, { clienteId: p.clienteId, progettoId: p.id, importo: res, note: p.titolo }); } } : null,
      editing ? { label: 'Duplica', cls: 'ghost', fn: async close => {
        // copia cliente, importo e descrizione; azzera scadenza e stato (riparte da Preventivo) e non porta con sé task né fatture
        const dup = { titolo: (p.titolo || '') + ' (copia)', clienteId: p.clienteId || null, descrizione: noteUnite, note: '', importo: num(p.importo), extra: num(p.extra), stato: 'preventivo', scadenza: null };
        const newId = await create('progetti', dup);
        close();
        if (newId) formProgetto({ id: newId, ...dup });
      } } : null,
    ].filter(Boolean),
    onDelete: editing ? async () => {
      await remove('progetti', p.id);
      for (const t of S.task.filter(t => t.progettoId === p.id)) await remove('task', t.id);
    } : null,
    onSave: async val => {
      const data = { ...p, ...val, importo: num(val.importo), extra: num(val.extra), clienteId: val.clienteId || null, scadenza: val.scadenza || null, note: '', costi: costiUI ? costiUI.get() : costiDi(p) };
      if (editing) { await put('progetti', p.id, data); return; }
      const newId = createdId || await create('progetti', data);
      if (!newId) return;
      createdId = newId;
      if (!S.progetti.some(x => x.id === newId)) S.progetti.push({ id: newId, ...data });
      if (pendingInp && pendingInp.value.trim()) { pending.push(pendingInp.value.trim()); pendingInp.value = ''; } // task scritto ma non ancora aggiunto
      while (pending.length) { await create('task', { titolo: pending[0], completato: false, progettoId: newId, scadenza: null }); pending.shift(); }
      if (onCreated) onCreated(newId);
    },
  });
}

/* ---------- FATTURE ---------- */
const MESI_L = ['Gennaio','Febbraio','Marzo','Aprile','Maggio','Giugno','Luglio','Agosto','Settembre','Ottobre','Novembre','Dicembre'];
let fattYear = String(year);
const annoF = f => (f.dataEmissione || '').slice(0, 4) || String(year);

function vFatture(v) {
  const anni = [...new Set([String(year), ...S.fatture.map(annoF)])].sort((a, b) => b.localeCompare(a));
  if (!anni.includes(fattYear)) fattYear = String(year);
  v.innerHTML = `
    <div class="page-head"><div><h1>Fatture</h1><div class="lede">Registro delle fatture emesse e dei pagamenti.</div></div>
      <button class="btn" id="new">+ Nuova fattura</button></div>
    <div class="filters ychips" role="group" aria-label="Anno">${anni.map(y => `<button class="fchip" aria-pressed="${fattYear === y}" data-y="${y}">${y}</button>`).join('')}</div>
    <div class="fgrid">
      <aside class="fside" id="fside" aria-label="Contabilità"></aside>
      <div class="fmain">
        ${(() => { const ap = S.fatture.filter(f => f.stato === 'inviata' || f.stato === 'scaduta'); const sc = ap.filter(f => f.stato === 'scaduta' || (f.dataScadenza && daysTo(f.dataScadenza) < 0)); return `<button type="button" class="fstrip" id="fstrip"><span><small>Da incassare · ${ap.length} ${ap.length === 1 ? 'fattura' : 'fatture'}${sc.length ? ` · <b class="fs-red">${sc.length} scadut${sc.length === 1 ? 'a' : 'e'}</b>` : ''}</small><strong>${euro(ap.reduce((a, f) => a + num(f.importo), 0))}</strong></span><span class="chev" aria-hidden="true">›</span></button>`; })()}
        <input class="search" id="fsearch" type="search" placeholder="Cerca cliente, numero, descrizione…" aria-label="Cerca fatture" value="${esc(fattQuery)}">
        <div class="filters">
          ${[['tutte', 'Tutte'], ...Object.entries(STATI_F).map(([k, v]) => [k, v[0]])].map(([k, l]) => `<button class="fchip" aria-pressed="${fattFilter === k}" data-f="${k}">${l}</button>`).join('')}
          <span class="total">Totale <b id="ftot"></b></span>
        </div>
        <div class="stack" id="flist"></div>
      </div>
    </div>`;
  v.querySelector('#new').onclick = () => formFattura(null);
  v.querySelector('#fstrip').onclick = () => dettaglioRiepilogo('inc');
  v.querySelectorAll('[data-f]').forEach(b => b.onclick = () => { fattFilter = b.dataset.f; render(); });
  v.querySelectorAll('[data-y]').forEach(b => b.onclick = () => { fattYear = b.dataset.y; render(); });
  const inp = v.querySelector('#fsearch');
  inp.oninput = () => { fattQuery = inp.value; renderFList(v); };
  renderFSide(v);
  renderFList(v);
}

// pannello contabilità: segue l'anno scelto (non la ricerca né i filtri di stato)
function renderFSide(v) {
  const imp = S.imp;
  const inAnno = S.fatture.filter(f => annoF(f) === fattYear && f.stato !== 'bozza');
  const fatturato = inAnno.reduce((s, f) => s + num(f.importo), 0);
  const pagate = S.fatture.filter(f => f.stato === 'pagata' && dataIncasso(f).startsWith(fattYear));
  const incassato = pagate.reduce((s, f) => s + num(f.importo), 0);
  const incFiscale = pagate.reduce((s, f) => s + fiscale(f), 0);
  const mesi = fattYear === String(year) ? new Date().getMonth() + 1 : 12;
  const st = stimaTasse(incFiscale), tasse = st.tasse, inps = st.inps;
  const costiAnno = speseCommesseAnno(fattYear);
  const netto = Math.max(0, st.netto - costiAnno);
  // da incassare: tutte le fatture non pagate, di qualsiasi anno
  const scaduta = f => f.stato === 'scaduta' || (f.dataScadenza && daysTo(f.dataScadenza) < 0);
  const aperte = S.fatture.filter(f => f.stato === 'inviata' || f.stato === 'scaduta')
    .sort((a, b) => String(a.dataScadenza || a.dataEmissione || '').localeCompare(String(b.dataScadenza || b.dataEmissione || '')));
  const totAperte = aperte.reduce((s, f) => s + num(f.importo), 0);
  const box = v.querySelector('#fside');
  box.innerHTML = `
    <div class="panel">
      <h2>Da incassare<span class="aside">${aperte.length} fatture</span></h2>
      <div class="bigv">${euro(totAperte)}</div>
      <div class="rows">${aperte.length ? aperte.map(f => `<div class="row" data-id="${f.id}" tabindex="0" role="button">
          <div class="main"><div class="ttl">${esc(cNome(f.clienteId))}</div>
            <div class="sub">${f.numero ? 'n. ' + esc(f.numero) + ' · ' : ''}${f.dataScadenza ? 'scade ' + fmtD(f.dataScadenza) : 'emessa ' + fmtD(f.dataEmissione)}${descrFatt(f) ? ' · ' + esc(descrFatt(f)) : ''}</div></div>
          <div class="rt"><span class="amt">${euro(num(f.importo))}</span>${scaduta(f) ? '<span class="badge b-red">Scaduta</span>' : ''}</div>
        </div>`).join('') : '<div class="empty">Nessuna fattura da incassare.</div>'}</div>
    </div>
    <div class="panel">
      <h2>Fatturato e incassato<span class="aside">${fattYear}</span></h2>
      <div class="kv"><span>Fatturato</span><b>${euro(fatturato)}</b></div>
      <div class="kv"><span>Incassato</span><b>${euro(incassato)}</b></div>
      <div class="kv"><span>Media mensile fatturato</span><b>${euro(fatturato / mesi)}</b></div>
    </div>
    <div class="panel">
      <h2>Tasse e netto stimati<span class="aside">${fattYear}</span></h2>
      <div class="kv"><span>Incassato da te (senza EXTRA)</span><b>${euro(incFiscale)}</b></div>
      <div class="kv"><span>Imposta sostitutiva</span><b>${euro(tasse)}</b></div>
      <div class="kv"><span>INPS</span><b>${euro(inps)}</b></div>
      <div class="kv"><span>Spese commesse</span><b>${euro(costiAnno)}</b></div>
      <div class="kv tot"><span>Netto stimato</span><b>${euro(netto)}</b></div>
      <p class="hint" style="margin-top:10px">Stima indicativa, non sostituisce il commercialista.</p>
    </div>`;
  box.querySelectorAll('.row').forEach(r => bindOpen(r, () => formFattura(S.fatture.find(f => f.id === r.dataset.id))));
}

function rigaFattura(f) {
  return `<div class="row" data-id="${f.id}" tabindex="0" role="button">
      <div class="main"><div class="ttl">${esc(cNome(f.clienteId))}${f.numero ? ` <span class="small">n. ${esc(f.numero)}</span>` : ''}</div>
        <div class="sub">${isExtra(f) ? '<span class="badge b-amber" style="margin-right:6px">EXTRA</span>' : ''}Emessa ${fmtD(f.dataEmissione)}${f.dataScadenza ? ' · scade ' + fmtD(f.dataScadenza) : ''}${f.note ? ' · ' + esc(f.note) : ''}</div></div>
      <div class="rt"><span class="amt">${euro(num(f.importo))}</span>
        ${badgeF(f)}
        ${f.stato === 'inviata' || f.stato === 'scaduta' ? `<button type="button" class="qpay" data-pay="${f.id}">✓ Pagata</button>` : ''}</div>
    </div>`;
}

function renderFList(v) {
  const q = fattQuery.trim().toLowerCase();
  const list = S.fatture.filter(f => annoF(f) === fattYear)
    .filter(f => fattFilter === 'tutte' || statoF(f) === fattFilter)
    .filter(f => !q || [cNome(f.clienteId), f.numero, f.note, String(num(f.importo))].join(' ').toLowerCase().includes(q))
    .sort((a, b) => String(b.dataEmissione || '').localeCompare(String(a.dataEmissione || '')));
  // le bozze non contano nel totale (tranne quando si filtrano proprio le bozze)
  v.querySelector('#ftot').textContent = euro(list.filter(f => fattFilter === 'bozza' || f.stato !== 'bozza').reduce((s, f) => s + num(f.importo), 0));
  // gruppi per mese di emissione, dal più recente
  const gruppi = [];
  list.forEach(f => {
    const m = (f.dataEmissione || '').slice(5, 7);
    let g = gruppi[gruppi.length - 1];
    if (!g || g.m !== m) gruppi.push(g = { m, items: [] });
    g.items.push(f);
  });
  const box = v.querySelector('#flist');
  box.innerHTML = gruppi.length ? gruppi.map(g => {
    const tot = g.items.filter(f => f.stato !== 'bozza').reduce((s, f) => s + num(f.importo), 0);
    const nome = g.m ? MESI_L[+g.m - 1] : 'Senza data';
    return `<div class="panel mgroup"><h2>${nome}<span class="aside">${g.items.length} ${g.items.length === 1 ? 'fattura' : 'fatture'} · <b>${euro(tot)}</b></span></h2>
      <div class="rows">${g.items.map(rigaFattura).join('')}</div></div>`;
  }).join('') : `<div class="panel"><div class="empty">${q || fattFilter !== 'tutte' ? 'Nessuna fattura trovata.' : 'Nessuna fattura nel ' + fattYear + '.'}</div></div>`;
  box.querySelectorAll('.row').forEach(r => bindOpen(r, () => formFattura(S.fatture.find(f => f.id === r.dataset.id))));
  box.querySelectorAll('.qpay').forEach(b => b.onclick = async e => {
    e.stopPropagation();
    const f = S.fatture.find(x => x.id === b.dataset.pay); if (!f || !db) return;
    b.disabled = true; b.textContent = '…';
    const prima = { ...f };
    try { await put('fatture', f.id, { ...f, stato: 'pagata', dataPagamento: f.dataPagamento || todayISO() }); avvisoAccantona(f, () => put('fatture', prima.id, prima)); }
    catch (err) { b.disabled = false; b.textContent = 'Riprova'; }
  });
}

function formFattura(f, preset) {
  const editing = !!f;
  let costiUI = null, progUI = null;
  f = f || { numero: '', clienteId: '', progettoId: '', importo: '', extra: '', dataEmissione: todayISO(), dataScadenza: '', dataPagamento: '', stato: 'inviata', note: '', ...(preset || {}) };
  openModal({
    title: editing ? 'Modifica fattura' : 'Nuova fattura',
    fields: [
      { k: 'numero', label: 'Numero', half: true },
      { k: 'importo', label: 'Importo totale (€)', type: 'number', req: true, half: true },
      { k: 'extra', label: 'EXTRA: fatturata da un collaboratore, conta nell\'incassato ma non nelle tasse', type: 'checkbox' },
      { k: 'clienteId', label: 'Cliente', type: 'select', options: clienteOptions() },
      { k: 'dataEmissione', label: 'Data emissione', type: 'date', req: true, half: true },
      { k: 'dataScadenza', label: 'Scadenza pagamento', type: 'date', half: true },
      { k: 'stato', label: 'Stato', type: 'select', options: Object.entries(STATI_F).map(([k, v]) => [k, v[0]]), half: true },
      { k: 'dataPagamento', label: 'Data incasso', type: 'date', half: true },
      { k: 'note', label: 'Note', type: 'textarea' },
    ],
    values: { ...f, extra: isExtra(f) },
    hint: 'Le tasse si calcolano sull\'incassato: la data incasso decide in quale anno conta.',
    extra: box => {
      progUI = mountProgettiFattura(box, f, editing);
      costiUI = mountCosti(box, costiFattura(f), 'Spese (fattura senza progetto)');
      const toggle = () => { costiUI.sec.hidden = progUI.ids().length > 0; };
      progUI.onChange(toggle); toggle();
      return null;
    },
    buttons: [
      editing && f.stato !== 'pagata' ? { label: 'Segna pagata', cls: 'ghost', fn: () => {
        // usa quello che c'è nella finestra (anche modifiche non ancora salvate) e salva
        const st = document.getElementById('m-stato'), dp = document.getElementById('m-dataPagamento');
        if (st) st.value = 'pagata'; if (dp && !dp.value) dp.value = todayISO();
        setTimeout(() => { const fm = st && st.closest('form'); if (fm) fm.requestSubmit(); }, 0);
      } } : null,
      editing ? { label: 'Duplica', cls: 'ghost', fn: async close => {
        // stesso cliente/progetto/importo; numero e date da ricompilare, riparte da Bozza
        const dup = { numero: '', clienteId: f.clienteId || null, progettoId: f.progettoId || null, ...(multiProgetto(f) ? { righe: f.righe.map(r => ({ ...r })) } : {}), importo: num(f.importo), extra: isExtra(f), dataEmissione: todayISO(), dataScadenza: null, dataPagamento: null, stato: 'bozza', note: f.note || '' };
        const newId = await create('fatture', dup);
        close();
        if (newId) formFattura({ id: newId, ...dup });
      } } : null,
    ].filter(Boolean),
    onDelete: editing ? () => remove('fatture', f.id) : null,
    onSave: async val => {
      // se la spunta EXTRA non è stata toccata, tieni il valore originale (anche una vecchia quota EXTRA parziale)
      const extraVal = (!!val.extra === isExtra(f) && typeof f.extra === 'number' && f.extra > 0) ? f.extra : !!val.extra;
      const righe = progUI ? progUI.righe() : [];
      const data = { ...f, ...val, costi: costiUI && !costiUI.sec.hidden ? costiUI.get() : costiFattura(f), importo: num(val.importo), extra: extraVal, clienteId: val.clienteId || null, progettoId: righe[0] ? righe[0].progettoId : null,
        dataScadenza: val.dataScadenza || null, dataPagamento: val.stato === 'pagata' ? (val.dataPagamento || todayISO()) : (val.dataPagamento || null) };
      if (righe.length > 1) data.righe = righe; else delete data.righe; // con un solo progetto vale tutta la fattura
      if (righe.length > 1 && typeof data.extra === 'number') data.extra = data.extra > 0; // quota EXTRA parziale solo per fatture a progetto singolo
      if (editing) await put('fatture', f.id, data); else await create('fatture', data);
      // appena diventa pagata: quanto mettere da parte per tasse e INPS
      if (data.stato === 'pagata' && f.stato !== 'pagata') setTimeout(() => avvisoAccantona(data), 50);
    },
  });
}

// Sezione "Progetti" della fattura: si spuntano i progetti del cliente scelto (anche più d'uno).
// Con 2 o più progetti ogni riga ha il suo importo (precompilato con quanto resta da fatturare) e il totale si aggiorna da solo.
function mountProgettiFattura(box, f, editing) {
  const sel = new Map(); // progettoId -> importo (stringa come scritta)
  if (multiProgetto(f)) f.righe.forEach(r => sel.set(r.progettoId, String(num(r.importo))));
  else if (f.progettoId) sel.set(f.progettoId, String(num(f.importo) || ''));
  const listeners = [];
  const sec = document.createElement('div'); sec.className = 'sub-sec pf-sec';
  const cliSel = document.getElementById('m-clienteId'), impInp = document.getElementById('m-importo');
  const anchor = cliSel && cliSel.closest('.field');
  if (anchor) anchor.after(sec); else box.appendChild(sec);
  let totaleToccato = editing; // in modifica non riscrivo il totale finché non si cambia qualcosa nei progetti
  impInp && impInp.addEventListener('input', () => { totaleToccato = true; });
  const sommaRighe = () => [...sel.values()].reduce((a, v) => a + num(v), 0);
  function aggiornaTotale() {
    if (sel.size > 1 && impInp) { impInp.value = fN(sommaRighe()); totaleToccato = false; }
    else if (sel.size === 1 && impInp && !impInp.value) { impInp.value = [...sel.values()][0] || ''; }
  }
  function draw() {
    const cid = cliSel ? cliSel.value : '';
    const delCliente = S.progetti.filter(p => cid && p.clienteId === cid && (sel.has(p.id) || (statoP(p) !== 'preventivo' && residuo(p) > 0) || statoP(p) === 'in_corso' || statoP(p) === 'in_revisione'));
    const altriScelti = [...sel.keys()].map(id => S.progetti.find(p => p.id === id)).filter(p => p && !delCliente.includes(p));
    const elenco = [...delCliente, ...altriScelti].sort(byName);
    const multi = sel.size > 1;
    const resto = S.progetti.filter(p => !elenco.includes(p)).sort((a, b) => cNome(a.clienteId).localeCompare(cNome(b.clienteId), 'it') || byName(a, b));
    const diff = multi && impInp ? num(impInp.value) - sommaRighe() : 0;
    sec.innerHTML = `<h4>Progetti <span class="aside">${sel.size ? (multi ? `${sel.size} progetti in questa fattura` : 'tutta la fattura su questo progetto') : 'nessuno'}</span></h4>
      ${elenco.length ? `<div class="pf-list">${elenco.map(p => { const on = sel.has(p.id), r = residuo(p); return `<label class="pf-row${on ? ' on' : ''}">
          <input type="checkbox" data-pid="${p.id}" ${on ? 'checked' : ''}>
          <span class="pf-t"><b>${esc(p.titolo)}</b><small>${p.clienteId !== cid ? esc(cNome(p.clienteId)) + ' · ' : ''}${r > 0 ? 'resta ' + euro(r) : STATI_P.find(x => x[0] === statoP(p))[1]}</small></span>
          ${on && multi ? `<input class="pf-imp" data-imp="${p.id}" inputmode="decimal" aria-label="Importo per ${esc(p.titolo)}" value="${esc(sel.get(p.id))}">` : ''}
        </label>`; }).join('')}</div>` : `<div class="empty" style="padding:4px 2px 8px">${cid ? 'Nessun progetto aperto per questo cliente.' : 'Scegli il cliente per vedere i suoi progetti.'}</div>`}
      ${multi && Math.abs(diff) >= 0.5 ? `<div class="pf-warn">L'importo totale è ${euro(num(impInp.value))}, la somma dei progetti ${euro(sommaRighe())} (${diff > 0 ? '+' : '−'}${euro(Math.abs(diff))}${Math.abs(diff - 2) < 0.01 ? ', bollo' : ''}).</div>` : ''}
      <div class="pf-add"><select aria-label="Aggiungi un altro progetto"><option value="">+ Aggiungi un altro progetto…</option>${resto.map(p => `<option value="${p.id}">${esc(cNome(p.clienteId))} · ${esc(p.titolo)}</option>`).join('')}</select></div>`;
    sec.querySelectorAll('[data-pid]').forEach(cb => cb.onchange = () => {
      const p = S.progetti.find(x => x.id === cb.dataset.pid);
      if (cb.checked) sel.set(p.id, String(Math.round((residuo(p) || num(p.importo) || 0) * 100) / 100)); else sel.delete(p.id);
      if (sel.size === 1 && !multiProgetto(f) && impInp && !totaleToccato) impInp.value = [...sel.values()][0];
      aggiornaTotale(); draw(); listeners.forEach(fn => fn());
    });
    sec.querySelectorAll('[data-imp]').forEach(inp => {
      inp.oninput = () => { sel.set(inp.dataset.imp, inp.value); aggiornaTotale(); refreshWarn(); };
    });
    const add = sec.querySelector('.pf-add select');
    add.onchange = () => {
      const p = S.progetti.find(x => x.id === add.value); if (!p) return;
      sel.set(p.id, String(Math.round((residuo(p) || num(p.importo) || 0) * 100) / 100));
      if (cliSel && !cliSel.value && p.clienteId) cliSel.value = p.clienteId;
      aggiornaTotale(); draw(); listeners.forEach(fn => fn());
    };
  }
  // avviso differenza senza ridisegnare (non perdere il cursore nel campo importo)
  function refreshWarn() {
    const old = sec.querySelector('.pf-warn'); const diff = impInp ? num(impInp.value) - sommaRighe() : 0;
    const txt = sel.size > 1 && Math.abs(diff) >= 0.5 ? `L'importo totale è ${euro(num(impInp.value))}, la somma dei progetti ${euro(sommaRighe())} (${diff > 0 ? '+' : '−'}${euro(Math.abs(diff))}${Math.abs(diff - 2) < 0.01 ? ', bollo' : ''}).` : '';
    if (!txt) { old && old.remove(); return; }
    if (old) old.textContent = txt; else { const w = document.createElement('div'); w.className = 'pf-warn'; w.textContent = txt; sec.querySelector('.pf-add').before(w); }
  }
  cliSel && cliSel.addEventListener('change', draw);
  impInp && impInp.addEventListener('input', refreshWarn);
  draw();
  return {
    ids: () => [...sel.keys()],
    righe: () => [...sel.entries()].map(([progettoId, v]) => ({ progettoId, importo: num(v) })),
    onChange: fn => listeners.push(fn),
  };
}

/* ---------- CLIENTI ---------- */
let clientiFiltro = 'tutti', clientiOrd = 'incassare';
const PAST = ['var(--lilla)', 'var(--rosa)', 'var(--giallo)', 'var(--verde)'];
const iniziali = n => String(n || '?').replace(/[()]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
const coloreDi = id => PAST[[...String(id)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PAST.length];
function vClienti(v) {
  v.innerHTML = `
    <div class="page-head"><div><h1>Clienti</h1><div class="lede">${S.clienti.length} clienti</div></div>
      <button class="btn" id="new">+ Nuovo cliente</button></div>
    <input class="search" id="csearch" type="search" placeholder="Cerca nome, email, telefono, P.IVA…" aria-label="Cerca clienti" value="${esc(clientiQuery)}">
    <div class="filters cfilters">
      ${[['tutti', 'Tutti'], ['aperte', 'Con fatture aperte'], ['attivi', 'Con progetti attivi']].map(([k, l]) => `<button class="fchip" aria-pressed="${clientiFiltro === k}" data-cf="${k}">${l}</button>`).join('')}
      <label class="csort">Ordina <select id="csort" aria-label="Ordina clienti">${[['incassare', 'Da incassare'], ['fatturato', 'Fatturato'], ['nome', 'Nome']].map(([k, l]) => `<option value="${k}" ${clientiOrd === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
    </div>
    <div class="panel"><div class="rows" id="clist"></div></div>`;
  v.querySelector('#new').onclick = () => formCliente(null);
  v.querySelectorAll('[data-cf]').forEach(b => b.onclick = () => { clientiFiltro = b.dataset.cf; v.querySelectorAll('[data-cf]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderCList(v); });
  v.querySelector('#csort').onchange = e => { clientiOrd = e.target.value; renderCList(v); };
  const inp = v.querySelector('#csearch');
  inp.oninput = () => { clientiQuery = inp.value; renderCList(v); };
  renderCList(v);
}

function renderCList(v) {
  const q = clientiQuery.trim().toLowerCase();
  const dati = S.clienti.map(c => {
    const prjAttivi = S.progetti.filter(p => p.clienteId === c.id && p.stato !== 'completato' && statoP(p) !== 'preventivo').length;
    const fatt = S.fatture.filter(f => f.clienteId === c.id && f.stato !== 'bozza');
    return { c, prjAttivi, totale: fatt.reduce((s, f) => s + num(f.importo), 0), aperto: fatt.filter(f => f.stato !== 'pagata').reduce((s, f) => s + num(f.importo), 0) };
  });
  const ord = { nome: (a, b) => byName(a.c, b.c), fatturato: (a, b) => b.totale - a.totale || byName(a.c, b.c), incassare: (a, b) => b.aperto - a.aperto || b.totale - a.totale || byName(a.c, b.c) }[clientiOrd];
  const list = dati
    .filter(x => clientiFiltro === 'tutti' || (clientiFiltro === 'aperte' ? x.aperto > 0 : x.prjAttivi > 0))
    .filter(({ c }) => !q || [c.nome, c.email, c.telefono, c.partitaIva].join(' ').toLowerCase().includes(q))
    .sort(ord);
  const box = v.querySelector('#clist');
  box.innerHTML = list.length ? list.map(({ c, prjAttivi, totale, aperto }) => {
    const sub = [c.email, c.telefono, c.partitaIva].filter(Boolean).map(esc);
    if (prjAttivi) sub.unshift(`${prjAttivi} ${prjAttivi === 1 ? 'progetto attivo' : 'progetti attivi'}`);
    return `<div class="row crow-c" data-id="${c.id}" tabindex="0" role="button">
      <span class="cav" style="background:${coloreDi(c.id)}" aria-hidden="true">${esc(iniziali(c.nome))}</span>
      <div class="main"><div class="ttl">${esc(c.nome)}</div>${sub.length ? `<div class="sub">${sub.join(' · ')}</div>` : ''}</div>
      <div class="rt">
        <span class="amt">${euro(totale)}</span>
        ${aperto ? `<span class="badge b-amber">${euro(aperto)} da incassare</span>` : ''}
      </div>
    </div>`;
  }).join('') : `<div class="empty">${q ? 'Nessun cliente trovato.' : clientiFiltro !== 'tutti' ? 'Nessun cliente con questo filtro.' : 'Nessun cliente.'}</div>`;
  box.querySelectorAll('.row').forEach(r => bindOpen(r, () => formCliente(S.clienti.find(c => c.id === r.dataset.id))));
}

function formCliente(c) {
  const editing = !!c;
  c = c || { nome: '', email: '', telefono: '', partitaIva: '', note: '' };
  openModal({
    title: editing ? 'Modifica cliente' : 'Nuovo cliente',
    fields: [
      { k: 'nome', label: 'Nome', req: true },
      { k: 'email', label: 'Email', type: 'email', half: true },
      { k: 'telefono', label: 'Telefono', half: true },
      { k: 'partitaIva', label: 'P.IVA / C.F.' },
      { k: 'note', label: 'Note', type: 'textarea' },
    ],
    values: c,
    extra: editing ? (box, close) => {
      const own = S.fatture.filter(f => f.clienteId === c.id)
        .sort((a, b) => String(b.dataEmissione || '').localeCompare(String(a.dataEmissione || '')));
      const sec = document.createElement('div'); sec.className = 'sub-sec';
      sec.innerHTML = `<h4>Fatture emesse${own.length ? ` <span class="aside">${own.length}</span>` : ''}</h4>
        <div class="rows">${own.length ? own.map(f => `<div class="row" data-id="${f.id}" tabindex="0" role="button">
            <div class="main"><div class="ttl">${f.numero ? 'n. ' + esc(f.numero) : 'Senza numero'}</div>
              <div class="sub">${isExtra(f) ? '<span class="badge b-amber" style="margin-right:6px">EXTRA</span>' : ''}Emessa ${fmtD(f.dataEmissione)}${f.note ? ' · ' + esc(f.note) : ''}</div></div>
            <div class="rt"><span class="amt">${euro(num(f.importo))}</span>${badgeF(f)}</div>
          </div>`).join('') : '<div class="empty">Nessuna fattura emessa verso questo cliente.</div>'}</div>`;
      box.appendChild(sec);
      sec.querySelectorAll('.row').forEach(r => bindOpen(r, () => { close(); formFattura(S.fatture.find(x => x.id === r.dataset.id)); }));
      box.appendChild(sezioneNote('c', c.id, close));
      return null;
    } : null,
    onDelete: editing ? () => remove('clienti', c.id) : null,
    onSave: async val => { if (editing) await put('clienti', c.id, { ...c, ...val }); else await create('clienti', val); },
  });
}

/* ---------- SPESE ---------- */
const annuo = s => num(s.importo) * (FREQ[s.frequenza]?.[1] ?? 0);
function vSpese(v) {
  const att = S.spese.filter(s => s.attivo !== false);
  const tot = att.reduce((s, x) => s + annuo(x), 0);
  const cats = Object.keys(CAT_S).filter(k => S.spese.some(s => (s.categoria || 'altro') === k));
  v.innerHTML = `
    <div class="page-head"><div><h1>Spese</h1><div class="lede">Costi fissi della tua attività.</div></div>
      <button class="btn" id="new">+ Nuova spesa</button></div>
    <div class="stack">
      <div class="grid g-stats">
        <div class="panel stat"><div class="l">Costo annuo</div><div class="v">${euro(tot)}</div><div class="s">${att.length} voci attive</div></div>
        <div class="panel stat"><div class="l">Media mensile</div><div class="v">${euro(tot / 12)}</div><div class="s">al mese</div></div>
      </div>
      ${cats.length ? cats.map(k => {
        const voci = S.spese.filter(s => (s.categoria || 'altro') === k).sort((a, b) => annuo(b) - annuo(a));
        return `<div class="panel"><h2>${CAT_S[k]}<span class="aside">${euro(voci.filter(s => s.attivo !== false).reduce((s, x) => s + annuo(x), 0))} / anno</span></h2><div class="rows">
          ${voci.map(s => `<div class="row" data-id="${s.id}" tabindex="0" role="button" style="${s.attivo === false ? 'opacity:.45' : ''}">
            <div class="main"><div class="ttl">${esc(s.descrizione)}</div><div class="sub">${FREQ[s.frequenza]?.[0] || ''}${s.frequenza !== 'una_tantum' ? ' · ' + euro(annuo(s)) + '/anno' : ''}${s.attivo === false ? ' · disattivata' : ''}</div></div>
            <span class="amt">${euro(num(s.importo))}</span></div>`).join('')}
        </div></div>`;
      }).join('') : '<div class="panel"><div class="empty-act"><p>Nessuna spesa. Aggiungi abbonamenti, software e costi fissi.</p><button type="button" class="btn ghost sm" data-empty="spesa">+ Nuova spesa</button></div></div>'}
    </div>`;
  v.querySelector('#new').onclick = () => formSpesa(null);
  const es = v.querySelector('[data-empty="spesa"]'); if (es) es.onclick = () => formSpesa(null);
  v.querySelectorAll('.row').forEach(r => bindOpen(r, () => formSpesa(S.spese.find(s => s.id === r.dataset.id))));
}

function formSpesa(s) {
  const editing = !!s;
  s = s || { descrizione: '', categoria: 'software', importo: '', frequenza: 'mensile', note: '', attivo: true };
  openModal({
    title: editing ? 'Modifica spesa' : 'Nuova spesa',
    fields: [
      { k: 'descrizione', label: 'Descrizione', req: true },
      { k: 'categoria', label: 'Categoria', type: 'select', options: Object.entries(CAT_S), half: true },
      { k: 'frequenza', label: 'Frequenza', type: 'select', options: Object.entries(FREQ).map(([k, v]) => [k, v[0]]), half: true },
      { k: 'importo', label: 'Importo (€) per periodo', type: 'number', req: true },
      { k: 'note', label: 'Note', type: 'textarea' },
      { k: 'attivo', label: 'Spesa attiva (conta nel totale)', type: 'checkbox' },
    ],
    values: s,
    onDelete: editing ? () => remove('spese', s.id) : null,
    onSave: async val => { const d = { ...s, ...val, importo: num(val.importo) }; if (editing) await put('spese', s.id, d); else await create('spese', d); },
  });
}

/* ---------- IMPOSTAZIONI ---------- */
// numeri all'italiana per i campi: 85.000 · 1.752,43 · 15,62
const fN = x => { const n = Math.round(num(x) * 100) / 100; const [a, b] = String(Math.abs(n)).split('.'); return (n < 0 ? '-' : '') + a.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (b ? ',' + b : ''); };
const sfx = (input, u) => `<span class="ifx">${input}<i aria-hidden="true">${u}</i></span>`;
function vImp(v) {
  const i = S.imp;
  const pc = x => +(num(x) * 100).toFixed(2);
  v.innerHTML = `
    <div class="page-head"><div>${BACK_BTN}<h1>Impostazioni</h1><div class="lede">Parametri usati per i calcoli del regime forfettario.</div></div><button class="btn" type="submit" form="impf" id="imp-top">Salva</button></div>
    <form id="impf" class="impf">
      <div class="panel"><h2>Profilo</h2><div class="fields">
        <div class="field"><label for="i-nome">Nome nel saluto</label><input id="i-nome" value="${esc(i.nome)}"></div>
      </div></div>
      <div class="panel"><h2>Regime forfettario</h2><div class="fields">
        <div class="field half"><label for="i-coef">Coefficiente di redditività</label>${sfx(`<input id="i-coef" inputmode="decimal" value="${fN(pc(i.coefficiente))}">`, '%')}</div>
        <div class="field half"><label for="i-tax">Imposta sostitutiva</label>${sfx(`<input id="i-tax" inputmode="decimal" value="${fN(pc(i.aliquotaTasse))}">`, '%')}</div>
        <div class="field half"><label for="i-lim">Limite annuo</label>${sfx(`<input id="i-lim" inputmode="decimal" value="${fN(num(i.limite))}">`, '€')}</div>
      </div></div>
      <div class="panel"><h2>Contributi INPS</h2><div class="fields">
        <div class="field"><label for="i-itipo">Tipo di contributi</label><select id="i-itipo">${Object.entries(INPS_TIPI).map(([k, l]) => `<option value="${k}" ${(i.inpsTipo || 'separata') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
        <div class="field half" data-inps="separata"><label for="i-inps">Aliquota INPS</label>${sfx(`<input id="i-inps" inputmode="decimal" value="${fN(pc(i.aliquotaInps))}">`, '%')}</div>
        <div class="field" data-inps="fisso"><label for="i-ifisso">Contributi fissi annui</label>${sfx(`<input id="i-ifisso" inputmode="decimal" value="${num(i.inpsFisso) ? fN(num(i.inpsFisso)) : ''}" placeholder="es. 3.000">`, '€')}<span class="hint">Il totale dell'anno delle 4 rate trimestrali.</span></div>
        <div class="field half" data-inps="fisso"><label for="i-imin">Minimale di reddito · facoltativo</label>${sfx(`<input id="i-imin" inputmode="decimal" value="${num(i.inpsMinimale) ? fN(num(i.inpsMinimale)) : ''}" placeholder="es. 18.555">`, '€')}</div>
        <div class="field half" data-inps="fisso"><label for="i-iecc">Oltre il minimale · facoltativo</label>${sfx(`<input id="i-iecc" inputmode="decimal" value="${num(i.inpsEccedenza) ? fN(pc(i.inpsEccedenza)) : ''}" placeholder="es. 15,62">`, '%')}</div>
        <div class="field cb"><input type="checkbox" id="i-deduci" ${i.deduciInps === false ? '' : 'checked'}><label for="i-deduci">Sottrai i contributi INPS dall'imponibile prima di calcolare l'imposta</label></div>
      </div></div>
      <div class="panel"><h2>Anno ${year - 1}<span class="aside">per gli acconti versati nel ${year}</span></h2><div class="fields">
        <div class="field half"><label for="i-pimp">Imposta sostitutiva ${year - 1}</label>${sfx(`<input id="i-pimp" inputmode="decimal" value="${num(i.prevAnno) === year - 1 && i.prevImposta !== undefined && i.prevImposta !== '' ? fN(num(i.prevImposta)) : ''}" placeholder="dai dati di ALDO">`, '€')}</div>
        <div class="field half"><label for="i-pinps">INPS ${(i.inpsTipo || 'separata') === 'separata' ? 'gestione separata' : 'oltre il minimale'} ${year - 1}</label>${sfx(`<input id="i-pinps" inputmode="decimal" value="${num(i.prevAnno) === year - 1 && i.prevInpsVar !== undefined && i.prevInpsVar !== '' ? fN(num(i.prevInpsVar)) : ''}" placeholder="dai dati di ALDO">`, '€')}</div>
        <p class="hint" style="grid-column:1/-1;margin-top:-4px">Li trovi nella dichiarazione o negli F24 di giugno e novembre. Se lasci vuoto, ALDO li stima dagli incassi del ${year - 1} che ha registrati.</p>
      </div></div>
      <details class="panel imp-info"><summary>Come calcola ALDO tasse e contributi</summary>
        <p class="hint">Imponibile = incassato (senza EXTRA) × coefficiente. INPS: percentuale sull'imponibile oppure contributi fissi, più l'eventuale percentuale sulla parte oltre il minimale. Imposta sull'imponibile, al netto dei contributi se la casella è attiva. Stima indicativa, non sostituisce il commercialista.</p>
      </details>
      <div class="actions imp-actions"><span class="spacer"></span><span class="small" id="imp-ok">${impSaved ? 'Salvato' : ''}</span><button class="btn" type="submit">Salva</button></div>
      <div class="err" id="imp-err"></div>
    </form>
    <div class="panel imp-bk" id="bk">
      <h2>Backup</h2>
      <p class="small">Scarica un file Excel con tutti i dati di ALDO.: fatture, progetti, clienti, spese e task, un foglio per tipo. Fallo una volta al mese o prima di mandare i dati al commercialista.</p>
      <p class="small" style="margin-top:8px">Ultimo backup: <b>${S.backup?.ultimo ? fmtD(S.backup.ultimo.slice(0, 10)) : 'mai'}</b></p>
      <div style="margin-top:14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap"><button class="btn" type="button" id="bk-btn">Esporta backup Excel</button><span class="small" id="bk-msg">${esc(bkNote)}</span></div>
    </div>
    <div class="panel imp-acc">
      <h2>Account</h2>
      <p class="small">Sei collegato come <b>${esc((window.aldoUser && window.aldoUser.email) || '')}</b>. I tuoi dati sono visibili solo a te.</p>
      <div style="margin-top:14px"><button class="btn ghost" type="button" id="logout-btn">Esci</button></div>
    </div>
    ${window.aldoUser && window.aldoUser.admin ? `<div class="panel imp-inv">
      <h2>Inviti</h2>
      <p class="small">Solo le email in questo elenco possono entrare in ALDO. Ognuno vede soltanto i propri dati. Dopo l'invito, la persona apre il sito e accede con Google oppure tocca "Hai ricevuto un invito? Crea la password".</p>
      <div class="rows" id="inv-list" style="margin-top:10px"><div class="empty">Carico…</div></div>
      <form id="inv-form" class="cadd" style="grid-template-columns:minmax(0,1fr) auto;margin-top:10px" novalidate><input type="email" id="inv-mail" placeholder="email della persona da invitare" autocomplete="off"><button class="btn sm" type="submit">Invita</button></form>
      <div class="err" id="inv-err"></div>
    </div>` : ''}`;
  v.querySelector('[data-back]').onclick = goBack;
  v.querySelector('#logout-btn').onclick = () => window.aldoLogout && window.aldoLogout();
  if (v.querySelector('#inv-list') && window.aldoInviti) {
    if (invStop) invStop();
    const box = v.querySelector('#inv-list'), ierr = v.querySelector('#inv-err');
    invStop = window.aldoInviti.ascolta(list => {
      if (!document.body.contains(box)) { if (invStop) { invStop(); invStop = null; } return; }
      if (!list) { box.innerHTML = '<div class="empty">Non riesco a leggere gli inviti.</div>'; return; }
      box.innerHTML = list.length ? list.sort((a, b) => a.email.localeCompare(b.email)).map(i => `<div class="crow"><span class="cv">${esc(i.email)}</span>${i.email === String(window.aldoUser.email || '').toLowerCase() ? '<span class="cd">tu</span>' : `<button type="button" class="x" data-inv="${esc(i.email)}" aria-label="Togli invito">✕</button>`}</div>`).join('') : '<div class="empty">Nessun invito.</div>';
      box.querySelectorAll('[data-inv]').forEach(b => b.onclick = async () => { try { await window.aldoInviti.togli(b.dataset.inv); } catch (e) { ierr.textContent = 'Non sono riuscito a togliere l\'invito.'; } });
    });
    v.querySelector('#inv-form').onsubmit = async e => {
      e.preventDefault(); ierr.textContent = '';
      const inp = v.querySelector('#inv-mail'), m = inp.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m)) { ierr.textContent = 'Scrivi un\'email valida.'; return; }
      try { await window.aldoInviti.aggiungi(m); inp.value = ''; } catch (er) { ierr.textContent = 'Invito non salvato. Riprova.'; }
    };
  }
  const tipoSel = v.querySelector('#i-itipo');
  const mostraInps = () => v.querySelectorAll('[data-inps]').forEach(el => { el.hidden = (el.dataset.inps === 'separata') !== (tipoSel.value === 'separata'); });
  tipoSel.onchange = mostraInps; mostraInps();
  const bkBtn = v.querySelector('#bk-btn'), bkMsg = v.querySelector('#bk-msg');
  bkBtn.onclick = async () => {
    bkBtn.disabled = true; bkMsg.textContent = 'Preparo il file…';
    try {
      const dl = window.claude ? await window.claude.use('downloads') : null;
      if (!dl) { bkMsg.textContent = 'Il download non è disponibile in questa vista.'; return; }
      const data = await buildBackupXlsx();
      bkMsg.textContent = 'Conferma il download…';
      await dl.save({ filename: 'ALDO-backup-' + todayISO() + '.xlsx', data });
      bkNote = 'Backup scaricato.'; bkMsg.textContent = bkNote;
      setTimeout(() => { bkNote = ''; }, 5000);
      if (db) db.doc('config/backup').set({ ultimo: new Date().toISOString() }).catch(() => {});
    } catch (e) {
      const c = e && e.code;
      bkMsg.textContent = c === 'declined' ? 'Download annullato.' : c === 'rate_limited' ? 'C\'è già un download in attesa: riprova tra poco.'
        : c === 'lib' ? 'Non riesco a preparare il file Excel: controlla la connessione e riprova.' : 'Download non riuscito (' + (c || 'errore') + ').';
    } finally { bkBtn.disabled = false; }
  };
  v.querySelector('#impf').addEventListener('input', e => { e.currentTarget.dataset.dirty = '1'; });
  v.querySelector('#impf').addEventListener('change', e => { e.currentTarget.dataset.dirty = '1'; });
  v.querySelector('#impf').onsubmit = async e => {
    e.preventDefault();
    const g = id => v.querySelector(id).value;
    try {
      await db.doc('config/impostazioni').set({ nome: g('#i-nome').trim(), coefficiente: num(g('#i-coef')) / 100, aliquotaTasse: num(g('#i-tax')) / 100, aliquotaInps: num(g('#i-inps')) / 100, limite: num(g('#i-lim')),
        inpsTipo: g('#i-itipo'), inpsFisso: num(g('#i-ifisso')), inpsMinimale: num(g('#i-imin')), inpsEccedenza: num(g('#i-iecc')) / 100, deduciInps: v.querySelector('#i-deduci').checked,
        prevAnno: year - 1, prevImposta: g('#i-pimp').trim() === '' ? '' : num(g('#i-pimp')), prevInpsVar: g('#i-pinps').trim() === '' ? '' : num(g('#i-pinps')) });
      impSaved = true; document.activeElement?.blur?.(); render();
      setTimeout(() => { impSaved = false; if (tab === 'impostazioni' && !document.querySelector('.overlay') && !document.getElementById('impf')?.dataset.dirty) render(); }, 2500);
    } catch (err) { v.querySelector('#imp-err').textContent = 'Salvataggio non riuscito. Riprova.'; }
  };
}

/* ---------- backup ---------- */
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  return new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    sc.onload = () => window.XLSX ? res(window.XLSX) : rej({ code: 'lib' });
    sc.onerror = () => rej({ code: 'lib' });
    document.head.appendChild(sc);
  });
}
async function buildBackupXlsx() {
  const X = await loadXLSX();
  const pNome = id => S.progetti.find(p => p.id === id)?.titolo || '';
  const statoPL = p => STATI_P.find(s => s[0] === statoP(p))?.[1] || '';
  const byDate = (a, b) => String(a.dataEmissione || '').localeCompare(String(b.dataEmissione || ''));
  const sheets = {
    Fatture: S.fatture.slice().sort(byDate).map(f => ({ 'Data emissione': f.dataEmissione || '', Numero: f.numero || '', Cliente: cNome(f.clienteId), Importo: num(f.importo),
      EXTRA: isExtra(f) ? 'Sì' : '', Spese: costiFattura(f).reduce((a, c) => a + num(c.importo), 0), Stato: STATI_F[f.stato]?.[0] || f.stato || '', 'Scadenza pagamento': f.dataScadenza || '', 'Data incasso': f.dataPagamento || '', Progetto: multiProgetto(f) ? f.righe.map(r => pNome(r.progettoId) + ' ' + num(r.importo)).join(' | ') : pNome(f.progettoId), Note: f.note || '' })),
    Progetti: S.progetti.slice().sort((a, b) => STATI_P.findIndex(s => s[0] === statoP(a)) - STATI_P.findIndex(s => s[0] === statoP(b))).map(p => ({ Stato: statoPL(p), Cliente: cNome(p.clienteId), Titolo: p.titolo || '',
      'Valore commessa': num(p.importo), EXTRA: num(p.extra), 'Già fatturato': fatturatoProgetto(p), 'Da fatturare': residuo(p), 'Spese commessa': costiDi(p).reduce((a, c) => a + num(c.importo), 0), Scadenza: p.scadenza || '', 'Descrizione e note': [p.descrizione, p.note].filter(v => v && v.trim()).join(' | ') })),
    Clienti: S.clienti.slice().sort(byName).map(c => ({ Nome: c.nome || '', Email: c.email || '', Telefono: c.telefono || '', 'P.IVA / C.F.': c.partitaIva || '', Note: c.note || '',
      'Fatturato totale': S.fatture.filter(f => f.clienteId === c.id && f.stato !== 'bozza').reduce((s, f) => s + num(f.importo), 0) })),
    Spese: S.spese.map(x => ({ Descrizione: x.descrizione || '', Categoria: CAT_S[x.categoria] || x.categoria || '', Importo: num(x.importo), Frequenza: FREQ[x.frequenza]?.[0] || '', 'Costo annuo': annuo(x), Attiva: x.attivo === false ? 'No' : 'Sì', Note: x.note || '' })),
    Task: S.task.map(t => ({ Task: t.titolo || '', Fatto: t.completato ? 'Sì' : '', Progetto: pNome(t.progettoId) })),
    Note: noteOrdinate().map(n => ({ Data: dataNota(n).slice(0, 10), Cartella: percorsoCartella(cartellaDi(n)), 'In evidenza': n.pinned ? 'Sì' : '', Titolo: titoloNota(n), 'Collegata a': linkValidi(n).map(nomeLink).join(', '), Testo: n.testo || '' })),
  };
  const wb = X.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = rows.length ? X.utils.json_to_sheet(rows) : X.utils.aoa_to_sheet([['Nessun dato']]);
    if (rows.length) ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.min(48, Math.max(k.length, ...rows.map(r => String(r[k]).length)) + 2) }));
    X.utils.book_append_sheet(wb, ws, name);
  }
  const imp = S.imp;
  X.utils.book_append_sheet(wb, X.utils.aoa_to_sheet([['Parametro', 'Valore'], ['Coefficiente redditività', num(imp.coefficiente)], ['Imposta sostitutiva', num(imp.aliquotaTasse)],
    ['Tipo contributi INPS', INPS_TIPI[imp.inpsTipo || 'separata']], ['Aliquota INPS (gestione separata)', num(imp.aliquotaInps)], ['Contributi fissi annui', num(imp.inpsFisso)], ['Minimale di reddito', num(imp.inpsMinimale)], ['% oltre il minimale', num(imp.inpsEccedenza)], ['Contributi sottratti dall\'imponibile', imp.deduciInps === false ? 'No' : 'Sì'], ['Limite annuo', num(imp.limite)], ['Imposta anno precedente (' + (imp.prevAnno || '') + ')', imp.prevImposta === '' || imp.prevImposta === undefined ? '' : num(imp.prevImposta)], ['INPS variabile anno precedente', imp.prevInpsVar === '' || imp.prevInpsVar === undefined ? '' : num(imp.prevInpsVar)], ['Esportato il', new Date().toLocaleString('it-IT')]]), 'Impostazioni');
  return new Blob([X.write(wb, { type: 'array', bookType: 'xlsx' })]);
}

/* ---------- data facoltativa con tasto per svuotarla ---------- */
// il selettore data nativo (soprattutto su iPhone) non ha un modo chiaro per cancellare: la × lo svuota
function dateField(attrs, val) {
  return `<span class="dwrap${val ? '' : ' is-empty'}"><input ${attrs} type="date" value="${esc(val || '')}"><button type="button" class="dclr" aria-label="Rimuovi data" title="Rimuovi data" tabindex="-1">✕</button></span>`;
}
// la × non prende il focus (altrimenti sparendo farebbe chiudere l'editor del task)
document.addEventListener('mousedown', e => { if (e.target.closest && e.target.closest('.dclr')) e.preventDefault(); });
document.addEventListener('click', e => {
  const b = e.target.closest('.dclr'); if (!b) return;
  const w = b.closest('.dwrap'), i = w.querySelector('input');
  i.value = ''; w.classList.add('is-empty');
  i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true }));
});
const dateSync = e => { const w = e.target.closest && e.target.closest('.dwrap'); if (w) w.classList.toggle('is-empty', !e.target.value); };
document.addEventListener('input', dateSync); document.addEventListener('change', dateSync);

/* ---------- modal ---------- */
let modalRefresh = null;
function openModal({ title, fields, values, extra, buttons = [], onDelete, onSave, hint }) {
  const ov = document.createElement('div');
  ov.className = 'overlay';
  const fid = k => 'm-' + k;
  ov.innerHTML = `<form class="sheet" novalidate>
    <h3><button type="button" class="xclose" data-a="x" aria-label="Chiudi">✕</button><span class="ttl">${esc(title)}</span><button type="submit" class="btn hsave">Salva</button></h3>
    <div class="err"></div>
    <div class="fields">${fields.map(f => {
      const val = values[f.k];
      if (f.type === 'checkbox') return `<div class="field cb"><input type="checkbox" id="${fid(f.k)}" ${val !== false ? 'checked' : ''}><label for="${fid(f.k)}">${f.label}</label></div>`;
      let input;
      if (f.type === 'select') input = `<select id="${fid(f.k)}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${String(val ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
      else if (f.type === 'textarea') input = `<textarea id="${fid(f.k)}" class="${f.big ? 'lg' : ''}">${esc(val)}</textarea>`;
      else if (f.type === 'date' && !f.req) input = dateField(`id="${fid(f.k)}"`, val);
      else input = `<input id="${fid(f.k)}" type="${f.type === 'number' ? 'text' : (f.type || 'text')}" ${f.type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(f.type === 'number' && val !== '' && val != null ? fN(val) : val)}">`;
      return `<div class="field ${f.half ? 'half' : ''}"><label for="${fid(f.k)}">${f.label}${f.req ? ' *' : ''}</label>${input}</div>`;
    }).join('')}</div>
    ${hint ? `<p class="hint" style="margin-top:10px">${esc(hint)}</p>` : ''}
    <div class="actions">
      ${onDelete ? '<button type="button" class="danger" data-a="del">Elimina</button>' : ''}
      <span class="spacer"></span>
      ${buttons.map((b, i) => `<button type="button" class="btn ${b.cls || ''}" data-b="${i}">${esc(b.label)}</button>`).join('')}
      <button type="button" class="btn ghost cancel" data-a="cancel">Annulla</button>
      <button type="submit" class="btn">Salva</button>
    </div>
  </form>`;
  document.body.appendChild(ov);
  const form = ov.querySelector('form');
  const err = ov.querySelector('.err');
  let busy = false;
  const mioRefresh = extra ? extra(ov.querySelector('.fields'), close) : null;
  modalRefresh = mioRefresh;
  const onKey = e => { if (e.key === 'Escape' && !busy) close(); };
  let chiusa = false;
  function close() { if (chiusa) return; chiusa = true; ov.remove(); if (modalRefresh === mioRefresh) modalRefresh = null; document.removeEventListener('keydown', onKey); render(); }
  document.addEventListener('keydown', onKey);
  ov.addEventListener('mousedown', e => { if (e.target === ov) close(); });
  ov.querySelector('[data-a="cancel"]').onclick = close;
  ov.querySelector('[data-a="x"]').onclick = close;
  const first = ov.querySelector('input:not([type=checkbox]), select, textarea'); if (first && !matchMedia('(pointer: coarse)').matches) first.focus();
  // un'operazione alla volta: un doppio tocco su Salva non crea doppioni
  const guard = async fn => {
    if (busy) return;
    if (!db) { err.textContent = 'Database non disponibile: ricarica la pagina.'; return; }
    busy = true; ov.querySelectorAll('button[type="submit"], [data-b], [data-a="del"]').forEach(b => b.disabled = true);
    try { await fn(); } catch (e) { err.textContent = 'Operazione non riuscita (' + (e && e.code || 'errore') + '). Riprova.'; }
    finally { busy = false; if (ov.isConnected) ov.querySelectorAll('button[type="submit"], [data-b], [data-a="del"]').forEach(b => b.disabled = false); }
  };
  buttons.forEach((b, i) => ov.querySelector(`[data-b="${i}"]`).onclick = () => guard(() => b.fn(close)));
  if (onDelete) {
    const del = ov.querySelector('[data-a="del"]');
    del.onclick = () => {
      if (del.dataset.armed) { guard(async () => { await onDelete(); close(); }); return; }
      del.dataset.armed = '1'; del.textContent = 'Conferma eliminazione';
      setTimeout(() => { if (del.isConnected) { delete del.dataset.armed; del.textContent = 'Elimina'; } }, 4000);
    };
  }
  form.onsubmit = e => {
    e.preventDefault();
    const val = {};
    for (const f of fields) {
      const el = ov.querySelector('#' + fid(f.k));
      val[f.k] = f.type === 'checkbox' ? el.checked : el.value.trim();
      if (f.req && !val[f.k]) { err.textContent = `Compila il campo "${f.label}".`; el.focus(); return; }
    }
    guard(async () => { await onSave(val); close(); });
  };
}

/* ---------- ORDINE A MANO (task e progetti) ---------- */
// task: campo "ordine"; i task vecchi senza ordine usano la data di creazione (stesso ordine di prima)
const kTask = t => typeof t.ordine === 'number' ? t.ordine : (Date.parse(t.createdAt) || 0);
// progetti: "ordine" dentro la colonna; senza ordine vanno in fondo, per scadenza
const kProg = p => typeof p.ordine === 'number' ? p.ordine : 1e9;
const progettiColonna = k => S.progetti.filter(p => statoP(p) === k).sort((a, b) => (kProg(a) - kProg(b)) || (a.scadenza || '9').localeCompare(b.scadenza || '9'));
// modifiche appena fatte: restano applicate finché il database non le conferma (niente salti avanti e indietro)
const pend = {};
function applicaPend(c) { const now = Date.now(); for (const [key, v] of Object.entries(pend)) { if (now - v.t > 6000) { delete pend[key]; continue; } const [cc, id] = key.split('/'); if (cc !== c) continue; const d = S[c].find(x => x.id === id); if (d) Object.assign(d, v.patch); } }
async function salvaPatch(c, lista) {
  const now = Date.now();
  lista.forEach(([id, patch]) => { pend[c + '/' + id] = { patch: { ...(pend[c + '/' + id]?.patch || {}), ...patch }, t: now }; const d = S[c].find(x => x.id === id); if (d) Object.assign(d, patch); });
  render();
  try { await Promise.all(lista.map(([id]) => { const d = S[c].find(x => x.id === id); return d ? put(c, id, { ...d }) : null; })); }
  catch (e) { toast('Non sono riuscito a salvare il nuovo ordine. Riprova.'); }
  setTimeout(() => { lista.forEach(([id]) => { const k = c + '/' + id; if (pend[k] && pend[k].t === now) delete pend[k]; }); }, 1500);
}
// riordina un gruppo di task: si scambiano tra loro le loro posizioni, gli altri task restano dove sono
function riordinaTask(order) {
  const tasks = order.map(id => S.task.find(t => t.id === id)).filter(Boolean);
  const keys = tasks.map(kTask).sort((a, b) => a - b);
  for (let i = 1; i < keys.length; i++) if (keys[i] <= keys[i - 1]) keys[i] = keys[i - 1] + 0.001;
  const lista = tasks.map((t, i) => [t.id, { ordine: keys[i] }]).filter(([id, p], i) => kTask(tasks[i]) !== p.ordine || typeof tasks[i].ordine !== 'number');
  if (lista.length) salvaPatch('task', lista);
}
function riordinaProgetti(k, order, mossoId) {
  const lista = [];
  order.forEach((id, i) => { const p = S.progetti.find(x => x.id === id); if (!p) return; const patch = {}; if (p.ordine !== i) patch.ordine = i; if (id === mossoId && statoP(p) !== k) patch.stato = k; if (Object.keys(patch).length) lista.push([id, patch]); });
  if (lista.length) salvaPatch('progetti', lista);
}
// cambio stato con le frecce o lasciando sulla linguetta: il progetto va in cima alla nuova colonna
function spostaProgetto(id, k) {
  const col = progettiColonna(k).filter(p => p.id !== id);
  const min = col.length ? Math.min(...col.map(kProg)) : 1;
  salvaPatch('progetti', [[id, { stato: k, ordine: (min >= 1e9 ? 0 : min) - 1 }]]);
}
// Trascinamento con mouse e dito. Mouse: si prende l'elemento ovunque e lo si muove di qualche pixel.
// Dito: si tiene premuto mezzo secondo sulla maniglia (la pagina continua a scorrere normalmente altrove).
// lists(): contenitori dove si può lasciare; extraDrops(): bersagli in più (es. le linguette di stato su telefono)
function trascinabile({ root, item, lists, extraDrops, onDrop }) {
  if (!root) return;
  const NO = 'button, input, textarea, select, a, [contenteditable], .tedit-wrap, .dwrap';
  root.addEventListener('pointerdown', e => {
    if (e.button !== 0 || document.body.classList.contains('dnd')) return;
    const it = e.target.closest(item); if (!it || !root.contains(it)) return;
    const mouse = e.pointerType === 'mouse';
    const suGrip = !!e.target.closest('.grip');
    if (!mouse && !suGrip) return;
    if (!suGrip && e.target.closest(NO)) return;
    const x0 = e.clientX, y0 = e.clientY; let attivo = false, timer = null, ghost, ph, dx, dy, raf = 0, px = x0, py = y0, sopra = null;
    const cleanupWait = () => { clearTimeout(timer); window.removeEventListener('pointermove', onMove, true); window.removeEventListener('pointerup', onUp, true); window.removeEventListener('pointercancel', onCancel, true); document.removeEventListener('keydown', onKey, true); };
    const scroller = el => { for (let n = el; n && n !== document.body; n = n.parentElement) { const st = getComputedStyle(n); if (/(auto|scroll)/.test(st.overflowY) && n.scrollHeight > n.clientHeight + 2) return n; } return document.scrollingElement; };
    function avvia() {
      attivo = true;
      const r = it.getBoundingClientRect(); dx = x0 - r.left; dy = y0 - r.top;
      ghost = it.cloneNode(true); ghost.classList.add('dnd-ghost'); ghost.removeAttribute('data-id');
      Object.assign(ghost.style, { width: r.width + 'px', height: r.height + 'px', left: r.left + 'px', top: r.top + 'px' });
      ph = document.createElement('div'); ph.className = 'dnd-ph'; ph.style.height = r.height + 'px';
      it.after(ph); it.classList.add('dnd-src');
      document.body.appendChild(ghost); document.body.classList.add('dnd');
      if (navigator.vibrate && !mouse) try { navigator.vibrate(15); } catch (er) {}
      const tick = () => {
        if (!attivo) return;
        const sc = scroller(ph.parentElement || root), b = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect();
        const m = 70; if (py < b.top + m) sc.scrollTop -= Math.ceil((b.top + m - py) / 6); else if (py > b.bottom - m) sc.scrollTop += Math.ceil((py - b.bottom + m) / 6);
        posiziona(); raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }
    function posiziona() {
      ghost.style.transform = `translate(${px - x0}px, ${py - y0}px) rotate(1.5deg)`;
      const el = document.elementFromPoint(px, py);
      const ex = extraDrops ? extraDrops().find(b => b.contains(el)) : null;
      if (sopra && sopra !== ex) sopra.classList.remove('drop-on');
      sopra = ex || null; if (sopra) { sopra.classList.add('drop-on'); return; }
      const ls = lists(); const lst = ls.find(l => l.contains(el)) || (ls.length === 1 ? ls[0] : null); if (!lst) return;
      const cand = [...lst.querySelectorAll(item)].filter(x => x !== it && x.parentElement === lst);
      let prima = cand.find(x => { const r = x.getBoundingClientRect(); return py < r.top + r.height / 2; });
      if (prima) { if (ph.nextElementSibling !== prima) lst.insertBefore(ph, prima); }
      else if (cand.length) { const ult = cand[cand.length - 1]; if (ph.previousElementSibling !== ult) ult.after(ph); }
      else if (ph.parentElement !== lst) { const vuoto = lst.querySelector('.empty'); lst.insertBefore(ph, vuoto || null); }
    }
    function fine(annulla) {
      attivo = false; cancelAnimationFrame(raf); cleanupWait();
      const lst = ph.parentElement, extra = sopra; if (sopra) sopra.classList.remove('drop-on');
      const order = annulla || !lst ? null : [...lst.children].filter(x => x === ph || (x.matches(item) && x !== it)).map(x => x === ph ? it.dataset.id : x.dataset.id);
      ghost.remove(); ph.remove(); it.classList.remove('dnd-src'); document.body.classList.remove('dnd');
      // il click che segue il rilascio non deve aprire la card
      const stop = ev => { ev.stopPropagation(); ev.preventDefault(); };
      window.addEventListener('click', stop, true); setTimeout(() => window.removeEventListener('click', stop, true), 50);
      if (annulla) return;
      onDrop({ id: it.dataset.id, to: lst, order, extra });
    }
    function onMove(ev) {
      px = ev.clientX; py = ev.clientY;
      if (!attivo) {
        if (mouse && Math.hypot(px - x0, py - y0) > 6) avvia();
        else if (!mouse && Math.hypot(px - x0, py - y0) > 10) cleanupWait(); // il dito si è mosso: non è una pressione lunga
        return;
      }
      ev.preventDefault();
    }
    function onUp() { if (attivo) fine(false); else cleanupWait(); }
    function onCancel() { if (attivo) fine(true); else cleanupWait(); }
    function onKey(ev) { if (ev.key === 'Escape' && attivo) { ev.stopPropagation(); fine(true); } }
    window.addEventListener('pointermove', onMove, true); window.addEventListener('pointerup', onUp, true); window.addEventListener('pointercancel', onCancel, true); document.addEventListener('keydown', onKey, true);
    if (!mouse) { timer = setTimeout(avvia, 450); e.preventDefault(); }
  });
}

function bindOpen(el, fn) {
  el.addEventListener('click', fn);
  el.addEventListener('keydown', e => { if (e.target === el && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fn(); } });
}

/* ---------- boot ---------- */
// ridisegna senza rubare ciò che si sta scrivendo: se un campo ha del testo aspetta che lo si lasci (con un attimo di margine
// così il tocco che ha fatto uscire dal campo arriva a destinazione); un campo vuoto con data-focuskey riprende il cursore
function renderQuandoLibero() {
  if (document.querySelector('.overlay')) return;
  const imf = document.getElementById('impf');
  if (imf && imf.dataset.dirty) return; // Impostazioni con modifiche non salvate: aggiorna dopo il salvataggio
  const a = document.activeElement;
  if (a && a.closest && a.closest('#view') && /INPUT|TEXTAREA|SELECT/.test(a.tagName) && a.value) {
    if (!a.dataset.waitRender) { a.dataset.waitRender = '1'; a.addEventListener('blur', () => { delete a.dataset.waitRender; setTimeout(renderQuandoLibero, 250); }, { once: true }); }
    return;
  }
  const fk = a && a.dataset && a.dataset.focuskey;
  render();
  if (fk) { const el = document.querySelector(`[data-focuskey="${fk}"]`); if (el) el.focus({ preventScroll: true }); }
}
let premuto = false;
document.addEventListener('pointerdown', () => { premuto = true; }, true);
['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => setTimeout(() => { premuto = false; }, 60), true));
// salva subito la nota se si chiude la pagina o si passa a un'altra app
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushNoteSave(); });
window.addEventListener('pagehide', () => flushNoteSave());
render();
(async () => {
  if (window.claude) window.claude.use('dictation').then(initDettatura).catch(() => {});
  if (window.claude) window.claude.use('sample').then(f => { aiFn = f || null; renderSide(); renderChrome(); }).catch(() => {});
  db = window.claude ? await window.claude.use('db') : null;
  const st = document.getElementById('status');
  if (!db) { st.textContent = 'Database non disponibile in questa vista: i dati non possono essere caricati.'; return; }
  let pending = COLLS.length + 1;
  let t = null;
  const refresh = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      // dito o mouse ancora premuti: aspetta, altrimenti il tocco finisce su un elemento appena ridisegnato
      if (premuto) { refresh(); return; }
      const ae = document.activeElement;
      if (document.querySelector('.overlay')) { if (modalRefresh) modalRefresh(); }
      else if (tab === 'note' && ae && ae.closest && ae.closest('.ned')) noteSoft();
      else renderQuandoLibero();
      st.textContent = 'Sincronizzato · ' + new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    }, 30);
  };
  const onErr = e => { st.textContent = 'Connessione al database interrotta (' + e.code + '). Ricarica la pagina.'; };
  COLLS.forEach(c => db.collection(c).onSnapshot(snap => {
    S[c] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    applicaPend(c);
    // modifiche alla nota non ancora salvate: non farle sovrascrivere dal database
    if (c === 'note' && noteDraft) { const n = S.note.find(x => x.id === noteDraft.id); if (n) Object.assign(n, noteDraft.patch); }
    if (c === 'note' && noteLastSaved && Date.now() - noteLastSaved.t < 5000) {
      const n = S.note.find(x => x.id === noteLastSaved.id);
      if (n && String(n.updatedAt || '') < String(noteLastSaved.patch.updatedAt || '')) Object.assign(n, noteLastSaved.patch);
    }
    refresh();
  }, onErr));
  db.doc('config/aspetto').onSnapshot(snap => { const t = snap.exists ? snap.data().tema : null; if (t && t !== tema) applyTema(t); }, () => {});
  db.doc('config/agenda').onSnapshot(snap => { S.agenda = snap.exists ? snap.data() : null; if (tab === 'home') refresh(); }, () => {});
  db.doc('config/conto').onSnapshot(snap => { S.conto = snap.exists ? snap.data() : null; if (tab === 'tasse') refresh(); }, () => {});
  db.doc('config/backup').onSnapshot(snap => { S.backup = snap.exists ? snap.data() : null; if (tab === 'impostazioni') refresh(); }, () => {});
  db.doc('config/impostazioni').onSnapshot(snap => {
    S.imp = { ...DEF_IMP, ...(snap.exists ? snap.data() : {}) };
    refresh();
  }, onErr);
})();
