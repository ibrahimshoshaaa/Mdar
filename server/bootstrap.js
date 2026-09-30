import { Pool } from 'pg';
import { hashPassword } from './security.js';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const rl = createInterface({ input: stdin, output: stdout });
try {
  const email = (await rl.question('Admin email: ')).trim().toLowerCase();
  const password = await rl.question('Admin password (input visible; run in private terminal): ');
  const hash = await hashPassword(password);
  const count = await pool.query("SELECT count(*)::int AS count FROM users WHERE role='admin'");
  if (count.rows[0].count !== 0) throw new Error('An admin already exists');
  await pool.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin')",[email,hash]);
  stdout.write('Admin created.\n');
} finally { rl.close(); await pool.end(); }
