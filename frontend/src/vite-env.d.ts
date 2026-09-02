/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  // Opcional a propósito (BLUEPRINT §9.10/A9) — sin ella, la SDK de
  // Sentry no manda nada; desarrollo local no la necesita configurada.
  readonly VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
