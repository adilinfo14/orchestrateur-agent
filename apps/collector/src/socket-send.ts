import net from 'node:net';

/**
 * Dépose un message dans l'inbox socket d'une session (Unix socket ou named pipe Windows).
 * Format : ligne d'authentification documentée, puis un message utilisateur stream-json,
 * tel qu'indiqué par Claude Code dans son journal de débogage « [uds-messaging] Inject messages ».
 * Claude Code applique ses contrôles d'entrée (crossSessionInbound) : le message peut être
 * mis en attente ou refusé par la session, ce que le collecteur ne peut pas observer directement.
 */
export function sendViaSocket(path: string, token: string | null, text: string, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(path);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Délai dépassé sur le socket de la session')); }, timeoutMs);
    sock.once('error', (err) => { clearTimeout(timer); reject(new Error(`Socket injoignable : ${err.message}`)); });
    sock.once('connect', () => {
      if (token) sock.write(JSON.stringify({ type: 'auth', token }) + '\n');
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
      sock.end(line, () => { clearTimeout(timer); resolve(); });
    });
  });
}
