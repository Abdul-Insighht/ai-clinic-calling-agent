import { getDbPool } from '../src/db/client.ts';

async function update() {
  const pool = getDbPool();
  const res = await pool.query(
    'UPDATE aibitsol.businesses SET timezone = $1 WHERE id = $2',
    ['Asia/Karachi', '22222222-2222-4222-8222-222222222222']
  );
  console.log('Successfully updated timezone to Asia/Karachi, rows affected:', res.rowCount);
  await pool.end();
}

update().catch((err) => {
  console.error(err);
  process.exit(1);
});
