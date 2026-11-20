# ALDO.

Gestionale per freelance in regime forfettario: progetti, fatture, clienti, spese, tasse, note e task.
Ogni persona accede con il proprio account e vede solo i propri dati.

## Com'è fatto

- `public/` è il sito: HTML, CSS e JavaScript senza build.
- `public/app.js` è la logica di ALDO (nata come Artifact di claude.ai).
- `public/cloud.js` collega l'app a Firebase: login, database per utente, download.
- `firestore.rules` impedisce a chiunque di leggere i dati di un altro utente.

## Messa online

1. Crea un progetto su https://console.firebase.google.com (regione database: `europe-west`).
2. Attiva Authentication (Email/password e Google) e Firestore.
3. Copia la configurazione web in `public/firebase-config.js`.
4. `npm i -g firebase-tools && firebase login && firebase use --add && firebase deploy`

## Accesso solo su invito

Entrano solo le email presenti nella collezione `inviti` (id del documento = email in minuscolo).

Primo avvio, una volta sola, dalla Console Firebase > Firestore:
1. Crea la collezione `inviti` con un documento il cui id è la tua email (minuscolo). Campi a piacere.
2. Accedi ad ALDO una volta, poi in Authentication copia il tuo "UID utente".
3. Crea la collezione `admins` con un documento il cui id è quel UID.

Da quel momento gli altri inviti li gestisci da ALDO: Impostazioni > Inviti.
