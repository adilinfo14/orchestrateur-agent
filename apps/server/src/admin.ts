import { createInterface } from 'node:readline/promises';
import { dbPath } from './config.ts';
import { openDb } from './db.ts';
import { audit, createEnrollCode, setPassword } from './auth.ts';

async function readSecret(prompt: string): Promise<string> {
  if (process.env.ACC_PASSWORD) return process.env.ACC_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  out._writeToOutput = (s: string) => { if (s.includes(prompt)) out.output.write(s); };
  const pw = await rl.question(prompt);
  rl.close();
  process.stdout.write('\n');
  return pw;
}

const [cmd, arg] = process.argv.slice(2);
const db = openDb(dbPath());

switch (cmd) {
  case 'set-password': {
    if (!arg) throw new Error('Usage : admin set-password <utilisateur>');
    const pw = await readSecret('Mot de passe (12 caractères min.) : ');
    setPassword(db, arg, pw);
    audit(db, 'cli', 'user.password_set', arg, null, null);
    console.log(`Mot de passe défini pour ${arg}. Les sessions ouvertes ont été révoquées.`);
    break;
  }
  case 'enroll-code': {
    const code = createEnrollCode(db);
    audit(db, 'cli', 'enroll.code_created', null, null, null);
    console.log(`Code d'inscription (15 min, usage unique) : ${code}`);
    break;
  }
  case 'delete-user': {
    if (!arg) throw new Error('Usage : admin delete-user <utilisateur>');
    db.prepare('DELETE FROM ui_sessions WHERE username = ?').run(arg);
    const r = db.prepare('DELETE FROM users WHERE username = ?').run(arg);
    audit(db, 'cli', 'user.deleted', arg, null, null);
    console.log(Number(r.changes) ? `Utilisateur ${arg} supprimé.` : `Utilisateur ${arg} introuvable.`);
    break;
  }
  case 'users': {
    console.table(db.prepare('SELECT username, created_at FROM users').all());
    break;
  }
  case 'machines': {
    console.table(db.prepare('SELECT id, name, hostname, platform, allow_control, revoked, last_seen_at FROM machines').all());
    break;
  }
  default:
    console.log('admin <set-password <utilisateur>|delete-user <utilisateur>|users|enroll-code|machines>');
}
db.close();
