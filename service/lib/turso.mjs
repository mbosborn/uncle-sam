/**
 * Opens the Turso (libSQL) database named by TURSO_DATABASE_URL / TURSO_AUTH_TOKEN, or returns null when
 * no URL is configured. Remote databases use the pure-fetch build (libsql:// is spoken over https, so no native
 * module ends up in a Vercel function bundle); file: and :memory: URLs, used by the local dev server and the
 * tests, need the Node build.
 */
export async function createTursoClient(env = process.env) {
  const url = typeof env.TURSO_DATABASE_URL === 'string' ? env.TURSO_DATABASE_URL.trim() : '';
  if (!url) return null;
  const local = /^(file:|:memory:)/i.test(url);
  const { createClient } = local ? await import('@libsql/client') : await import('@libsql/client/web');
  const token = typeof env.TURSO_AUTH_TOKEN === 'string' ? env.TURSO_AUTH_TOKEN.trim() : '';
  return createClient({ url, ...(token ? { authToken: token } : {}) });
}
