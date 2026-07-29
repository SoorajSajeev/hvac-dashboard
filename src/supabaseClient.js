import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = "https://xmnpvguxhnnumwimhsvo.supabase.co";
const SUPABASE_KEY = "sb_publishable_uxRRYKxXbIkYCQD2ftblzA_sJ9n8knY";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);