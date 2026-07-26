import tls from 'tls';
import { URL } from 'url';
import { SslAudit } from '../../schemas/audit.schema';

export async function checkSsl(targetUrl: string, timeoutMs = 3000): Promise<SslAudit> {
  const parsedUrl = new URL(targetUrl);
  if (parsedUrl.protocol !== 'https:') {
    return null;
  }

  const hostname = parsedUrl.hostname;
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : 443;

  return new Promise((resolve) => {
    let resolved = false;

    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: false,
      },
      () => {
        if (resolved) return;
        resolved = true;

        try {
          const cert = socket.getPeerCertificate();
          if (!cert || Object.keys(cert).length === 0) {
            socket.destroy();
            return resolve(null);
          }

          const validTo = new Date(cert.valid_to);
          const now = new Date();
          const msUntilExpiry = validTo.getTime() - now.getTime();
          const daysUntilExpiry = Math.floor(msUntilExpiry / (1000 * 60 * 60 * 24));

          const isValid = socket.authorized && msUntilExpiry > 0;
          let issuer = 'Unknown';
          if (cert.issuer) {
            const rawIssuer = cert.issuer.O || cert.issuer.CN || cert.issuer.OU || 'Unknown';
            issuer = Array.isArray(rawIssuer) ? rawIssuer.join(', ') : rawIssuer;
          }

          socket.destroy();
          resolve({
            isValid,
            issuer,
            daysUntilExpiry,
          });
        } catch {
          socket.destroy();
          resolve(null);
        }
      },
    );

    socket.setTimeout(timeoutMs, () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(null);
      }
    });

    socket.on('error', () => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(null);
      }
    });
  });
}
