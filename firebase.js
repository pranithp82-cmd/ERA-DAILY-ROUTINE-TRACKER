// =====================================================
//  firebase.js  –  ERA Daily Routine Tracker
//  Firebase v9 Modular SDK – initialize ONCE here
// =====================================================

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDatabase }    from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

// Credentials are injected by env-config.js (auto-generated from .env via load-env.js)
const env = window.__ENV__ || {};

const getVal = (key) => env[`VITE_${key}`] || env[key] || "";

const firebaseConfig = {
  apiKey:            getVal("FIREBASE_API_KEY"),
  authDomain:        getVal("FIREBASE_AUTH_DOMAIN"),
  databaseURL:       getVal("FIREBASE_DATABASE_URL"),
  projectId:         getVal("FIREBASE_PROJECT_ID"),
  storageBucket:     getVal("FIREBASE_STORAGE_BUCKET"),
  messagingSenderId: getVal("FIREBASE_MESSAGING_SENDER_ID"),
  appId:             getVal("FIREBASE_APP_ID")
};

if (!firebaseConfig.apiKey) {
  console.warn("⚠️ Firebase configuration missing! Make sure env-config.js is generated or environment variables are set in Vercel.");
}

const app      = initializeApp(firebaseConfig);
export const auth     = getAuth(app);
export const database = getDatabase(app);
