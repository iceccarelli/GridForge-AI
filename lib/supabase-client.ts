"use client";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Browser Supabase client — public anon key (safe to expose; RLS protects data).
// Created lazily so a missing env at build/prerender time never throws.
let _client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
  _client = createClient(url, anon, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return _client;
}
