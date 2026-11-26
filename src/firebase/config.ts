import { initializeApp, type FirebaseApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
  type AppCheck,
} from 'firebase/app-check';
import { getRemoteConfig, fetchAndActivate, getString } from 'firebase/remote-config';
import type { PolicyMode } from '../engine/regexShield';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const isFirebaseConfigured = Boolean(
  firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId
);

let app: FirebaseApp | null = null;
let appCheck: AppCheck | null = null;

if (isFirebaseConfigured) {
  app = initializeApp(firebaseConfig);

  const siteKey = import.meta.env.VITE_RECAPTCHA_SITE_KEY;
  if (siteKey) {
    // Localhost testing ke liye auto debug token (production build mein automatically off)
    if (import.meta.env.DEV) {
      (
        self as unknown as { FIREBASE_APPCHECK_DEBUG_TOKEN?: boolean | string }
      ).FIREBASE_APPCHECK_DEBUG_TOKEN = true;
    }

    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaEnterpriseProvider(siteKey),
      isTokenAutoRefreshEnabled: true,
    });
  }
}

export async function fetchRemotePolicyMode(): Promise<PolicyMode> {
  if (!app) return 'strict_india';

  try {
    const remoteConfig = getRemoteConfig(app);
    remoteConfig.settings.minimumFetchIntervalMillis = 60_000;
    remoteConfig.defaultConfig = { redaction_mode: 'strict_india' };
    await fetchAndActivate(remoteConfig);

    const mode = getString(remoteConfig, 'redaction_mode');
    return mode === 'global_gdpr' ? 'global_gdpr' : 'strict_india';
  } catch {
    return 'strict_india';
  }
}

// FIX: Duplicate tail hata di — file exact isi single export par khatam hoti hai
export { app, appCheck, isFirebaseConfigured };