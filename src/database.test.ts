import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import type { Workspace } from './domain';

// Real PostgreSQL (WASM) executes the actual migration and RPCs. Only the
// hosted auth/storage scaffolding is mocked; no domain SQL is replaced.
const db = new PGlite();
const ids = { customer: '11111111-1111-4111-8111-111111111111', provider: '22222222-2222-4222-8222-222222222222', admin: '33333333-3333-4333-8333-333333333333', stranger: '44444444-4444-4444-8444-444444444444', rival: '55555555-5555-4555-8555-555555555555' };
let ticketId: string;
let secondId: string;
const lines = [{ description: 'Repair and parts', amount: 60000 }];
async function as(who: keyof typeof ids | null) { await db.query("select set_config('request.jwt.claim.sub', $1, false)", [who ? ids[who] : '']); }
async function workspace() { const r = await db.query<{ value: Workspace }>('select public.get_workspace() as value'); return r.rows[0].value; }
async function action(type: string, payload = {}, id: string | null = ticketId, profile: string | null = null) { return db.query('select public.perform_action($1,$2::uuid,$3::uuid,$4::jsonb)', [type, id, profile, JSON.stringify(payload)]); }

beforeAll(async () => {
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key, email text);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text);
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    create publication supabase_realtime;
    grant usage on schema public,auth,storage to authenticated,anon;
    grant select,insert on storage.objects to authenticated;
  `);
  await db.exec(readFileSync(new URL('../supabase/migrations/202610020001_autofix.sql', import.meta.url), 'utf8'));
  await db.exec(readFileSync(new URL('../supabase/migrations/202610020002_provider_onboarding.sql', import.meta.url), 'utf8'));
  for (const [who, id] of Object.entries(ids)) await db.query('insert into auth.users(id,email) values($1,$2)', [id, `${who}@example.com`]);
  for (const who of ['customer', 'provider', 'admin', 'stranger', 'rival'] as const) {
    await as(who);
    await db.query('select public.onboard($1::jsonb)', [JSON.stringify({ role: who === 'provider' || who === 'rival' ? 'provider' : 'customer', name: `${who} Person`, phone: '2065550100', city: 'Seattle', zip: '98103', business: 'Test shop', service: 'either', specialty: 'General repair', address: '100 Example Road', credential: 'Test registration', terms: 'accepted', ...(who === 'rival' ? { service: 'mobile', business: '', address: '', credential: '' } : {}) })]);
  }
  await db.query("update profiles set role='admin',approval='approved' where id=$1", [ids.admin]);
  await as('admin');
  await action('review_profile', { approval: 'approved', funding: 100000, reference: 'WA-TEST' }, null, ids.customer);
  await action('review_profile', { approval: 'approved', funding: 0 }, null, ids.provider);
  await action('review_profile', { approval: 'approved', funding: 0 }, null, ids.rival);
  await db.exec('set role authenticated');
}, 60000);
afterAll(async () => { await db.close(); });

describe.sequential('production database access and repair lifecycle', () => {
  it('onboards independent mobile mechanics without requiring a shop address or business name', async () => {
    await as('rival');
    const p = (await workspace()).profiles.find(p => p.id === ids.rival)!;
    expect(p.business).toBe('rival Person');
    expect(p.service).toBe('mobile');
    expect(p.address).toBe('');
    expect(p.termsVersion).toBe('2026-10-v1');
  });
  it('forbids anonymous workspace access', async () => {
    await as(null); await expect(workspace()).rejects.toThrow(/Sign in/);
  });
  it('forbids direct table reads and writes for authenticated clients', async () => {
    await as('customer');
    await expect(db.query('select * from public.profiles')).rejects.toThrow(/permission denied/);
    await expect(db.query("update public.profiles set role='admin'")).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from public.audit_events")).rejects.toThrow(/permission denied/);
  });
  it('blocks self-registration as admin and approval bypasses', async () => {
    await as('stranger');
    await expect(db.query("select public.onboard('{\"role\":\"admin\"}')")).rejects.toThrow(/Choose customer/);
    await expect(action('create_ticket', {}, null)).rejects.toThrow(/approved/);
    await expect(action('review_profile', { approval: 'approved', funding: 100000 }, null, ids.stranger)).rejects.toThrow(/Administrator/);
  });
  it('creates a private request and matching notifications', async () => {
    await as('customer');
    const payload = { title: 'Brake service', description: 'Grinding noise when stopping.', vehicle: '2014 Honda Civic', mileage: 110000, availability: 'Private availability details', category: 'Brakes', service: 'either', drivable: true, photos: [] };
    await action('create_ticket', payload, null);
    ticketId = (await workspace()).tickets[0].id;
    await action('create_ticket', { ...payload, title: 'Second repair' }, null);
    secondId = (await workspace()).tickets.find(t => t.id !== ticketId)!.id;
    await as('provider');
    const ws = await workspace();
    expect(ws.tickets).toHaveLength(2);
    expect(ws.tickets[0].customerId).toBe('');
    expect(ws.tickets[0].availability).toBe('Shared after assignment');
    expect(ws.profiles.some(p => p.id === ids.customer)).toBe(false);
    expect(ws.notices.some(n => n.ticketId === ticketId)).toBe(true);
  });
  it('claims once and reveals only necessary contact details', async () => {
    await as('provider'); await action('claim');
    await expect(action('claim')).rejects.toThrow(/no longer available/);
    const owner = (await workspace()).profiles.find(p => p.id === ids.customer)!;
    expect(owner.email).toBe('customer@example.com');
    expect(owner.funding).toBe(0);
    expect(owner.fundingReference).toBeUndefined();
  });
  it('removes a taken ticket from another mechanic’s feed and sends an immediate realtime notification', async () => {
    await as('rival');
    const ws = await workspace();
    expect(ws.tickets.some(t => t.id === ticketId)).toBe(false);
    expect(ws.tickets.some(t => t.id === secondId)).toBe(true);
    expect(ws.notices.some(n => n.message === 'Request taken: Brake service. Removed from available jobs.')).toBe(true);
    await expect(action('claim')).rejects.toThrow(/no longer available/);
    await as('provider');
    expect((await workspace()).tickets.find(t => t.id === ticketId)!.status).toBe('claimed');
  });
  it('prevents other customers from accessing the ticket or its history', async () => {
    await as('stranger'); const ws = await workspace();
    expect(ws.tickets).toHaveLength(0);
    expect(ws.audit.some(a => a.ticketId === ticketId)).toBe(false);
    await expect(action('consent')).rejects.toThrow(/Only the customer/);
  });
  it('requires both approvals and blocks malformed estimates', async () => {
    await as('provider');
    await expect(action('estimate', { lines: [{ description: 'Broken cents', amount: 1.5 }] })).rejects.toThrow(/Invalid amount/);
    await action('estimate', { lines });
    await expect(action('start')).rejects.toThrow(/consent/);
    await as('customer'); await action('consent');
    await as('provider'); await expect(action('start')).rejects.toThrow(/consent/);
    await as('admin'); await action('authorize');
    expect((await workspace()).tickets.find(t => t.id === ticketId)!.status).toBe('authorized');
  });
  it('reserves funding across tickets and prevents reductions below commitments', async () => {
    await as('provider'); await action('claim', {}, secondId); await action('estimate', { lines }, secondId);
    await as('admin');
    await expect(action('authorize', {}, secondId)).rejects.toThrow(/exceeds/);
    await expect(action('review_profile', { approval: 'approved', funding: 50000 }, null, ids.customer)).rejects.toThrow(/commitments/);
  });
  it('protects private photo access and notification rows', async () => {
    await as('stranger');
    const photos = await db.query<{ allowed: boolean }>('select public.can_read_photo($1) as allowed', [`${ids.customer}/photo.jpg`]);
    expect(photos.rows[0].allowed).toBe(false);
    const rows = await db.query<{ user_id: string }>('select user_id from public.notifications');
    expect(rows.rows.every(r => r.user_id === ids.stranger)).toBe(true);
  });
  it('enforces invoice ceilings, allows dispute resolution, and schedules only verified completion', async () => {
    await as('provider'); await action('start');
    await as('customer'); await action('dispute', { reason: 'Please review the replacement part.' });
    await as('admin'); await action('resolve_dispute', { reason: 'Replacement part confirmed with both parties.' });
    await as('provider');
    await expect(action('complete', { summary: 'Work completed and road tested', lines: [{ description: 'Over budget', amount: 90000 }] })).rejects.toThrow(/exceed/);
    await action('complete', { summary: 'New brakes installed and road tested.', lines, reference: 'INV-TEST' });
    expect((await workspace()).tickets.find(t => t.id === ticketId)!.dueAt).toBeNull();
    await as('customer'); await action('verify');
    const t = (await workspace()).tickets.find(t => t.id === ticketId)!;
    expect(t.paymentStatus).toBe('scheduled');
    const days = await db.query<{ days: number }>("select (($1::timestamptz at time zone 'America/Los_Angeles')::date - ($2::timestamptz at time zone 'America/Los_Angeles')::date) as days", [t.dueAt, t.completedAt]);
    expect(days.rows[0].days).toBe(32);
    await expect(action('verify')).rejects.toThrow(/not ready/);
    await expect(action('pay', { reference: 'fake-payment' })).rejects.toThrow(/administrator/);
  });
  it('requires reasons for holds and a payment reference for administrator disbursement records', async () => {
    await as('admin');
    await expect(action('hold', {})).rejects.toThrow(/reason/);
    await action('hold', { reason: 'Review funding transfer.' });
    await expect(action('pay', { reference: 'TRANSFER' })).rejects.toThrow(/scheduled/);
    await action('hold', { reason: 'Funding transfer confirmed.' });
    await expect(action('pay', {})).rejects.toThrow(/reference/);
    await action('pay', { reference: 'TRANSFER-123' });
    expect((await workspace()).tickets.find(t => t.id === ticketId)!.paymentStatus).toBe('paid');
  });
});
