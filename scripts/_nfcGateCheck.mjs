import fs from 'fs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { Client } = require('pg')
const j = JSON.parse(fs.readFileSync(`${process.env.HOME}/.master.json`, 'utf8'))
const url = j.DB_URL || j.db_url || j.databaseUrl || j.postgres || j.PG_URL
if (!url) {
  console.error('no db url; matching keys', Object.keys(j).filter(k => /db|pg|sql/i.test(k)))
  process.exit(1)
}
const db = new Client({ connectionString: url })
await db.connect()
const { rows } = await db.query(
  `SELECT tag_id, uid, nfc_link_state,
          (private_key IS NOT NULL AND TRIM(private_key) <> '') AS has_pk,
          linked_owner_eoa
   FROM nfc_cards
   WHERE LOWER(COALESCE(linked_owner_eoa,'')) = LOWER($1)
      OR CAST(tag_id AS TEXT) ILIKE $2
      OR CAST(uid AS TEXT) ILIKE $2
   LIMIT 20`,
  ['0x55a9b9331aea882bb715689b7c691a9d7f387e1a', '%beamio_nfc_29%']
)
console.log(JSON.stringify(rows, null, 2))
await db.end()
