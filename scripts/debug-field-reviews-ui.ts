/** Quick read-only check for field review UI data (no mutations). */
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'
import { fetchAdminFieldReviews } from '../src/lib/admin/field-reviews'

config()

const url = process.env.PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('env missing')
  process.exit(1)
}

const admin = createClient(url, key, { auth: { persistSession: false } })

for (const status of ['pending', 'accepted', 'rejected'] as const) {
  const rows = await fetchAdminFieldReviews(admin, { status })
  console.log(status, rows.length, rows.slice(0, 3).map((r) => ({ id: r.id, field: r.field_name, event: r.event_id })))
}
