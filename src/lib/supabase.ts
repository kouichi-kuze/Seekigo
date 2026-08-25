import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.PUBLIC_SUPABASE_URL
const supabaseKey = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY

console.log('SUPABASE_URL:', supabaseUrl)
console.log('SUPABASE_KEY_EXISTS:', !!supabaseKey)

export const supabase = createClient(supabaseUrl, supabaseKey)

