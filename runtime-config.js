/*
 * Browser-safe runtime configuration for AfterTalk.
 *
 * Deployment: set enabled to true and replace functionUrl and publishableKey.
 * Only use a Supabase publishable key here. Never put a Supabase secret key,
 * provider API key, or any other secret in a browser-delivered file.
 */
(function attachAfterTalkConfig(root) {
  root.AfterTalkConfig = Object.freeze({
    enabled: true,
    functionUrl: 'https://ewvfvueqawdcapqdeuac.supabase.co/functions/v1/generate-action',
    transcriptionUrl: 'https://ewvfvueqawdcapqdeuac.supabase.co/functions/v1/transcribe-note',
    publishableKey: 'sb_publishable_Q_xMVHG3J1p4dPdLD3NKFQ_I6-tz4QQ',
    timeoutMs: 12000,
    transcriptionTimeoutMs: 45000,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
