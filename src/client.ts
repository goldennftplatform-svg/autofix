import { createClient } from '@supabase/supabase-js';
import type { Action, Workspace } from './domain';
import { applyAction } from './domain';
import { seed } from './seed';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const supabase = url && key ? createClient(url, key) : null;
export const DEMO_KEY = 'autofix-demo-v1';
export function readDemo(): Workspace {
  try { const raw = localStorage.getItem(DEMO_KEY); if (raw) return JSON.parse(raw); } catch { /* Fall back to demo seed if local storage was cleared. */ }
  const state = seed(); localStorage.setItem(DEMO_KEY, JSON.stringify(state)); return state;
}
export async function loadWorkspace(): Promise<Workspace> {
  if (!supabase) return readDemo();
  const { data, error } = await supabase.rpc('get_workspace');
  if (error) throw error;
  return data as Workspace;
}
export async function dispatchAction(actorId: string, action: Action): Promise<Workspace> {
  if (supabase) {
    const { error } = await supabase.rpc('perform_action', { p_action: action.type, p_ticket_id: action.ticketId || null, p_profile_id: action.profileId || null, p_payload: action.payload || {} });
    if (error) throw error;
    return loadWorkspace();
  }
  const update = async () => {
    const state = applyAction(readDemo(), actorId, action);
    localStorage.setItem(DEMO_KEY, JSON.stringify(state)); return state;
  };
  return navigator.locks ? navigator.locks.request('autofix-demo', update) : update();
}
