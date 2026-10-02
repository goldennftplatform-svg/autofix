import { describe, expect, it } from 'vitest';
import { applyAction, committed, paymentDue, total } from './domain';
import { seed } from './seed';
import type { Action, Workspace } from './domain';

const estimate = [{ description: 'Front brake pads and labor', amount: 42000 }];
function next(s: Workspace, who: string, type: string, payload?: Action['payload'], id = 'AF-1048') { return applyAction(s, who, { type, ticketId: id, payload }); }
function authorized() {
  let s = next(seed(), 'provider-1', 'claim');
  s = next(s, 'provider-1', 'estimate', { lines: estimate });
  s = next(s, 'customer-1', 'consent');
  return next(s, 'admin-1', 'authorize');
}

describe('repair lifecycle and funding', () => {
  it('requires approval before a customer can submit requests', () => {
    expect(() => applyAction(seed(), 'customer-3', { type: 'create_ticket', payload: {} })).toThrow(/approved/);
  });
  it('requires provider approval and current payment terms', () => {
    expect(() => next(seed(), 'provider-2', 'claim')).toThrow(/approval/);
    const s = seed(); s.profiles[0].termsVersion = 'old';
    expect(() => next(s, 'provider-1', 'claim')).toThrow(/payment-terms/);
  });
  it('does not allow the same ticket to be claimed twice', () => {
    const s = next(seed(), 'provider-1', 'claim');
    expect(() => next(s, 'provider-1', 'claim')).toThrow(/no longer available/);
  });
  it('requires both consent and funding, in either approval order', () => {
    let s = next(seed(), 'provider-1', 'claim');
    s = next(s, 'provider-1', 'estimate', { lines: estimate });
    s = next(s, 'admin-1', 'authorize');
    expect(() => next(s, 'provider-1', 'start')).toThrow(/consent/);
    s = next(s, 'customer-1', 'consent');
    expect(next(s, 'provider-1', 'start').tickets[0].status).toBe('in_progress');
  });
  it('rejects client attempts to approve funding or record payments', () => {
    expect(() => next(authorized(), 'provider-1', 'authorize')).toThrow(/administrator/);
    expect(() => next(seed(), 'customer-2', 'pay', { reference: 'fake' }, 'AF-1043')).toThrow(/scheduled payments/);
  });
  it('resets both approvals when an unstarted estimate is revised', () => {
    let s = next(seed(), 'provider-1', 'claim');
    s = next(s, 'provider-1', 'estimate', { lines: estimate });
    s = next(s, 'customer-1', 'consent');
    s = next(s, 'provider-1', 'estimate', { lines: [{ description: 'Updated parts', amount: 45000 }] });
    expect(s.tickets[0].customerConsent).toBe(false);
    expect(s.tickets[0].fundingAuthorized).toBe(false);
  });
  it('prevents overspending reserved funds across tickets', () => {
    let s = authorized();
    expect(committed(s, 'customer-1')).toBe(94000);
    s = next(s, 'provider-1', 'claim', undefined, 'AF-1045');
    s = next(s, 'provider-1', 'estimate', { lines: [{ description: 'Repair', amount: 200000 }] }, 'AF-1045');
    expect(() => next(s, 'admin-1', 'authorize', undefined, 'AF-1045')).toThrow(/exceeds/);
    expect(() => applyAction(s, 'admin-1', { type: 'review_profile', profileId: 'customer-1', payload: { approval: 'approved', funding: 100 } })).toThrow(/commitments/);
  });
  it('rejects invalid cents and over-budget invoices', () => {
    let s = next(seed(), 'provider-1', 'claim');
    expect(() => next(s, 'provider-1', 'estimate', { lines: [{ description: 'Parts', amount: 1.5 }] })).toThrow(/positive amount/);
    s = next(authorized(), 'provider-1', 'start');
    expect(() => next(s, 'provider-1', 'complete', { summary: 'Installed new brake pads.', lines: [{ description: 'Service', amount: 999999 }] })).toThrow(/exceed/);
  });
  it('schedules exactly once only after verified completion, then allows admin to record payment', () => {
    let s = next(authorized(), 'provider-1', 'start');
    s = next(s, 'provider-1', 'complete', { summary: 'Replaced brake pads and road tested.', lines: estimate, reference: 'INV-1' });
    expect(s.tickets[0].dueAt).toBeNull();
    s = applyAction(s, 'customer-1', { type: 'verify', ticketId: 'AF-1048' }, '2026-10-20T19:00:00.000Z');
    const t = s.tickets[0];
    expect(t.dueAt).toBe('2026-11-21T20:00:00.000Z');
    expect(t.paymentStatus).toBe('scheduled');
    expect(() => next(s, 'customer-1', 'verify')).toThrow(/not ready/);
    s = next(s, 'admin-1', 'pay', { reference: 'TRANSFER-123' });
    expect(s.tickets[0].paymentStatus).toBe('paid');
    expect(total(s.tickets[0].invoice)).toBe(42000);
  });
  it('holds payments without losing the original due date', () => {
    let s = next(seed(), 'admin-1', 'hold', { reason: 'Funding transfer under review' }, 'AF-1043');
    const due = s.tickets.find(t => t.id === 'AF-1043')!.dueAt;
    expect(() => next(s, 'admin-1', 'pay', { reference: 'ref-1' }, 'AF-1043')).toThrow();
    s = next(s, 'admin-1', 'hold', { reason: 'Funding transfer now confirmed' }, 'AF-1043');
    expect(s.tickets.find(t => t.id === 'AF-1043')!.dueAt).toBe(due);
  });
  it('resolves disputes with a reason and resumes work without bypassing an invoice', () => {
    let s = next(authorized(), 'provider-1', 'start');
    s = next(s, 'customer-1', 'dispute', { reason: 'The replacement part seems incorrect.' });
    expect(() => next(s, 'admin-1', 'verify', { reason: 'Override without invoice' })).toThrow(/invoice/);
    s = next(s, 'admin-1', 'resolve_dispute', { reason: 'Correct part ordered; both parties agree.' });
    expect(s.tickets[0].status).toBe('in_progress');
  });
  it('releases reservations for cancellations and emits activity and participant notifications', () => {
    const s = next(authorized(), 'customer-1', 'cancel', { reason: 'No longer need this repair.' });
    expect(committed(s, 'customer-1')).toBe(52000);
    expect(s.notices.some(n => n.userId === 'provider-1' && n.ticketId === 'AF-1048')).toBe(true);
    expect(s.audit[0].action).toContain('No longer need');
  });
});

describe('Washington calendar-day scheduling', () => {
  it('accounts for spring daylight saving time', () => expect(paymentDue('2026-02-20T20:00:00Z')).toBe('2026-03-24T19:00:00.000Z'));
  it('accounts for fall daylight saving time', () => expect(paymentDue('2026-10-20T19:00:00Z')).toBe('2026-11-21T20:00:00.000Z'));
  it('rolls over the end of the year', () => expect(paymentDue('2026-12-20T20:00:00Z')).toBe('2027-01-21T20:00:00.000Z'));
});
