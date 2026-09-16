import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * Reads a dotenv file without a dependency. Real environment variables win.
 *
 * A missing file is not an error: production passes everything through the real environment, and
 * a required value being absent is reported by whichever step needs it, in its own terms.
 */
export function loadEnv(file) {
  let text = '';
  if (file) {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      text = '';
    }
  }
  const env = {};
  for (const line of text.split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { ...env, ...process.env };
}
