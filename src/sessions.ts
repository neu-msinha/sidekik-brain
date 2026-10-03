import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SessionStore } from "./state.js";

/** Finds a session's org: brain's own state first, then the `sessions` table (owned by gateway, readable by brain). */
export interface SessionDirectory {
  orgOf(sessionId: string): Promise<string | undefined>;
}

export class StoreFirstDirectory implements SessionDirectory {
  private readonly cache = new Map<string, string>();
  private readonly db: SupabaseClient | undefined;

  constructor(
    private readonly store: SessionStore,
    supabase?: { url: string; serviceRoleKey: string },
  ) {
    this.db = supabase ? createClient(supabase.url, supabase.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } }) : undefined;
  }

  async orgOf(sessionId: string): Promise<string | undefined> {
    const live = this.store.get(sessionId)?.org_id;
    if (live) return live;
    const cached = this.cache.get(sessionId);
    if (cached || !this.db) return cached;
    const { data, error } = await this.db.from("sessions").select("org_id").eq("id", sessionId).maybeSingle();
    if (error || !data) return undefined;
    const org = String((data as { org_id: string }).org_id);
    this.cache.set(sessionId, org);
    return org;
  }
}
