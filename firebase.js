// =====================================================
//  firebase.js  –  ERA Daily Routine Tracker
//  Firebase v9 Modular SDK – initialize ONCE here
// =====================================================

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase }    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// Credentials are injected by env-config.js (auto-generated from .env via load-env.js)
const env = window.__ENV__ || {};

if (!env.VITE_FIREBASE_API_KEY) {
  console.warn("⚠️ Firebase configuration missing! Make sure env-config.js is generated or environment variables are set in Vercel.");
}

const firebaseConfig = {
  apiKey:            env.VITE_FIREBASE_API_KEY || "MISSING_KEY",
  authDomain:        env.VITE_FIREBASE_AUTH_DOMAIN || "",
  databaseURL:       env.VITE_FIREBASE_DATABASE_URL || "",
  projectId:         env.VITE_FIREBASE_PROJECT_ID || "",
  storageBucket:     env.VITE_FIREBASE_STORAGE_BUCKET || "",
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID || "",
  appId:             env.VITE_FIREBASE_APP_ID || ""
};

const app      = initializeApp(firebaseConfig);
export const auth     = getAuth(app);
export const database = getDatabase(app);
