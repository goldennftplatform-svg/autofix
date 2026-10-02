import { createClient } from '@supabase/supabase-js';
import type { Action, Workspace } from './domain';
import { applyAction } from './domain';
import { seed } from './seed';
import type { Enrollment } from './OnboardingWizard';
import { TERMS_VERSION, uid } from './domain';

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

export async function enrollDemo(data: Enrollment) {
  if (supabase) throw new Error('Demo enrollment is unavailable in production.');
  if (!['customer', 'provider'].includes(data.role)) throw new Error('Choose a customer or provider account.');
  if (data.role === 'provider' && data.terms !== 'accepted') throw new Error('Accept the payment schedule before submitting.');
  const update = async () => {
    const state = readDemo();
    const id = uid();
    state.profiles.push({ id, role: data.role as 'customer' | 'provider', name: data.name.trim(), email: data.email.trim(), phone: data.phone.trim(), city: data.city.trim(), zip: data.zip, approval: 'pending', funding: 0, fundingReference: data.reference || '', business: data.business || data.name, service: data.service as 'shop' | 'mobile' | 'either', specialty: data.specialty, termsAt: data.role === 'provider' ? new Date().toISOString() : null, termsVersion: data.role === 'provider' ? TERMS_VERSION : null, address: data.address || '', credential: data.credential || '' });
    state.notices.unshift({ id: uid(), userId: id, message: 'Application received. We’ll notify you after review.', createdAt: new Date().toISOString(), read: false });
    for (const admin of state.profiles.filter(p => p.role === 'admin')) state.notices.unshift({ id: uid(), userId: admin.id, message: `New application: ${data.name}`, createdAt: new Date().toISOString(), read: false });
    localStorage.setItem(DEMO_KEY, JSON.stringify(state));
    localStorage.setItem(`autofix-demo-${data.role}`, id);
    return { id, state };
  };
  return navigator.locks ? navigator.locks.request('autofix-demo', update) : update();
}
