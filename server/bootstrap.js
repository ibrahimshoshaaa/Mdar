import { Pool } from 'pg';
import { hashPassword } from './security.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if(process.env.CI&&(!process.env.ADMIN_BOOTSTRAP_EMAIL||!process.env.ADMIN_BOOTSTRAP_PASSWORD))throw new Error('Set ADMIN_BOOTSTRAP_EMAIL and ADMIN_BOOTSTRAP_PASSWORD secrets first');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rl = createInterface({ input: stdin, output: stdout });
try {
  const email = (process.env.ADMIN_BOOTSTRAP_EMAIL||await rl.question('Admin email: ')).trim().toLowerCase();
  const password = process.env.ADMIN_BOOTSTRAP_PASSWORD||await rl.question('Admin password (input visible; run in private terminal): ');
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Invalid admin email');
  const hash = await hashPassword(password);
  const count = await pool.query("SELECT count(*)::int AS count FROM users WHERE role='admin'");
  if (count.rows[0].count !== 0) throw new Error('An admin already exists');
  await pool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin')",[email,hash]);
  stdout.write('Admin created.\n');
} finally { rl.close(); await pool.end(); }
