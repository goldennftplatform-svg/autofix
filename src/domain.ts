export type Role = 'customer' | 'provider' | 'admin';
export type Approval = 'pending' | 'approved' | 'needs_info' | 'rejected';
export type Status = 'open' | 'claimed' | 'estimated' | 'authorized' | 'in_progress' | 'completion_submitted' | 'completed' | 'cancelled' | 'disputed';
export type Service = 'shop' | 'mobile' | 'either';
export type Profile = { id: string; role: Role; name: string; email: string; phone: string; city: string; zip: string; approval: Approval; funding: number; fundingReference: string; business: string; service: Service; specialty: string; termsAt: string | null; termsVersion: string | null; address: string; credential: string };
export type LineItem = { description: string; amount: number };
export type Ticket = { id: string; customerId: string; providerId: string | null; title: string; description: string; vehicle: string; mileage: number; city: string; zip: string; service: Service; category: string; drivable: boolean; availability: string; status: Status; createdAt: string; estimate: LineItem[]; customerConsent: boolean; fundingAuthorized: boolean; completionSummary: string; invoice: LineItem[]; completedAt: string | null; dueAt: string | null; paymentStatus: 'not_scheduled' | 'scheduled' | 'paid' | 'on_hold'; paidAt: string | null; paymentReference: string; photos: string[]; invoiceReference: string };
export type Notice = { id: string; userId: string; message: string; createdAt: string; read: boolean; ticketId?: string };
export type Audit = { id: string; ticketId: string | null; actorId: string; action: string; at: string };
export type Workspace = { profiles: Profile[]; tickets: Ticket[]; notices: Notice[]; audit: Audit[] };
export type Action = { type: string; ticketId?: string; profileId?: string; payload?: Record<string, unknown> };
export const TERMS_VERSION = '2026-10-v1';
export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export const date = (value: string | null) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Los_Angeles' }).format(new Date(value)) : 'Not scheduled';
export const total = (items: LineItem[]) => items.reduce((sum, item) => sum + item.amount, 0);
export const statusLabel: Record<Status, string> = { open: 'Open request', claimed: 'Claimed', estimated: 'Estimate ready', authorized: 'Authorized', in_progress: 'In progress', completion_submitted: 'Confirm completion', completed: 'Completed', cancelled: 'Cancelled', disputed: 'Disputed' };
export const approvalLabel: Record<Approval, string> = { pending: 'Pending review', approved: 'Approved', needs_info: 'More information needed', rejected: 'Not approved' };
export const serviceLabel: Record<Service, string> = { shop: 'In-shop service', mobile: 'Mobile service', either: 'Shop or mobile' };
export const uid = () => crypto.randomUUID();
export const committed = (state: Workspace, customerId: string, except?: string) => state.tickets.filter(t => t.customerId === customerId && t.id !== except && t.fundingAuthorized && t.status !== 'cancelled').reduce((sum, t) => sum + total(t.estimate), 0);
export const matches = (p: Profile, t: Ticket) => (p.service === 'either' || t.service === 'either' || p.service === t.service) && p.city.toLowerCase() === t.city.toLowerCase() && (p.specialty === 'General repair' || p.specialty === t.category);

// Add calendar days in Washington local time, including across DST boundaries.
export function paymentDue(iso: string, days = 32) {
  const parts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(d).map(p => [p.type, p.value]));
  const p = parts(new Date(iso));
  const wall = new Date(Date.UTC(+p.year, +p.month - 1, +p.day + days, +p.hour, +p.minute, +p.second));
  let candidate = wall.getTime() + 8 * 3600000;
  for (let i = 0; i < 3; i++) {
    const q = parts(new Date(candidate));
    candidate += wall.getTime() - Date.UTC(+q.year, +q.month - 1, +q.day, +q.hour, +q.minute, +q.second);
  }
  return new Date(candidate).toISOString();
}

function validLines(value: unknown): LineItem[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Add at least one invoice or estimate line.');
  const lines = value as LineItem[];
  if (lines.length > 30 || lines.some(l => typeof l.description !== 'string' || !l.description.trim() || !Number.isSafeInteger(l.amount) || l.amount <= 0 || l.amount > 10000000)) throw new Error('Every line needs a description and a positive amount.');
  return lines.map(l => ({ description: l.description.trim(), amount: l.amount }));
}

// Pure demo state machine. Production authorization is independently enforced in SQL.
export function applyAction(previous: Workspace, actorId: string, action: Action, now = new Date().toISOString()): Workspace {
  const state = structuredClone(previous);
  const actor = state.profiles.find(p => p.id === actorId);
  if (!actor) throw new Error('Sign in to continue.');
  const payload = action.payload || {};
  const require = (condition: boolean, message: string) => { if (!condition) throw new Error(message); };
  const notify = (userId: string, message: string, ticketId?: string) => state.notices.unshift({ id: uid(), userId, message, ticketId, createdAt: now, read: false });
  if (action.type === 'read_notices') {
    state.notices.filter(n => n.userId === actorId).forEach(n => n.read = true);
    return state;
  }
  if (action.type === 'accept_terms') {
    require(actor.role === 'provider', 'Provider access required.');
    actor.termsAt = now; actor.termsVersion = TERMS_VERSION;
  } else if (action.type === 'review_profile') {
    require(actor.role === 'admin', 'Administrator access required.');
    const p = state.profiles.find(p => p.id === action.profileId);
    require(!!p && p.role !== 'admin', 'Profile not found.');
    require(['approved', 'pending', 'needs_info', 'rejected'].includes(String(payload.approval)), 'Invalid approval status.');
    const funding = Number(payload.funding ?? p!.funding);
    require(Number.isSafeInteger(funding) && funding >= committed(state, p!.id), 'Funding cannot be lower than existing commitments.');
    p!.approval = payload.approval as Approval; p!.funding = funding;
    p!.fundingReference = String(payload.reference || p!.fundingReference);
    notify(p!.id, `Your application status: ${approvalLabel[p!.approval]}.`);
  } else if (action.type === 'create_ticket') {
    require(actor.role === 'customer' && actor.approval === 'approved', 'Your application must be approved before submitting a ticket.');
    for (const field of ['title', 'description', 'vehicle', 'availability', 'category']) require(typeof payload[field] === 'string' && String(payload[field]).trim().length > 0, `Please complete ${field}.`);
    require(['shop', 'mobile', 'either'].includes(String(payload.service)), 'Choose a service type.');
    const ticket: Ticket = { id: uid(), customerId: actorId, providerId: null, title: String(payload.title), description: String(payload.description), vehicle: String(payload.vehicle), mileage: Number(payload.mileage || 0), city: actor.city, zip: actor.zip, service: payload.service as Service, category: String(payload.category), drivable: payload.drivable === true, availability: String(payload.availability), status: 'open', createdAt: now, estimate: [], customerConsent: false, fundingAuthorized: false, completionSummary: '', invoice: [], completedAt: null, dueAt: null, paymentStatus: 'not_scheduled', paidAt: null, paymentReference: '', photos: (payload.photos as string[]) || [], invoiceReference: '' };
    state.tickets.unshift(ticket);
    state.profiles.filter(p => p.role === 'provider' && p.approval === 'approved' && matches(p, ticket)).forEach(p => notify(p.id, `New nearby request: ${ticket.title}`, ticket.id));
    action = { ...action, ticketId: ticket.id };
  } else {
    const t = state.tickets.find(t => t.id === action.ticketId);
    require(!!t, 'Ticket not found.');
    const ticket = t!;
    const provider = actor.role === 'provider' && ticket.providerId === actorId && actor.approval === 'approved' && actor.termsVersion === TERMS_VERSION;
    const customer = actor.role === 'customer' && ticket.customerId === actorId;
    const admin = actor.role === 'admin';
    switch (action.type) {
      case 'claim':
        require(actor.role === 'provider' && actor.approval === 'approved' && !!actor.termsAt && actor.termsVersion === TERMS_VERSION, 'Provider approval and payment-terms acceptance are required.');
        require(ticket.status === 'open' && ticket.providerId === null && matches(actor, ticket), 'This ticket is no longer available or outside your service area.');
        ticket.providerId = actorId; ticket.status = 'claimed';
        state.profiles.filter(p => p.id !== actorId && p.role === 'provider' && p.approval === 'approved' && matches(p, ticket)).forEach(p => notify(p.id, `Request taken: ${ticket.title}. Removed from available jobs.`));
        break;
      case 'estimate':
        require(provider && ['claimed', 'estimated'].includes(ticket.status), 'Only the assigned provider can submit an estimate before work is authorized.');
        ticket.estimate = validLines(payload.lines); ticket.customerConsent = false; ticket.fundingAuthorized = false; ticket.status = 'estimated'; break;
      case 'consent':
        require(customer && ticket.status === 'estimated', 'Only the customer can approve this estimate.'); ticket.customerConsent = true; break;
      case 'authorize': {
        require(admin && ticket.status === 'estimated', 'Only an administrator can authorize an estimate.');
        const owner = state.profiles.find(p => p.id === ticket.customerId)!;
        require(owner.approval === 'approved' && total(ticket.estimate) + committed(state, owner.id, ticket.id) <= owner.funding, 'Estimate exceeds available funding or customer approval is missing.');
        ticket.fundingAuthorized = true; break;
      }
      case 'start': require(provider && ticket.status === 'authorized' && ticket.customerConsent && ticket.fundingAuthorized, 'Customer consent and funding authorization are required.'); ticket.status = 'in_progress'; break;
      case 'complete':
        require(provider && ticket.status === 'in_progress', 'Only an in-progress assigned job can be completed.');
        require(String(payload.summary || '').trim().length > 5, 'Describe the work completed.');
        ticket.invoice = validLines(payload.lines);
        require(total(ticket.invoice) <= total(ticket.estimate), 'The final invoice cannot exceed the approved estimate.');
        ticket.completionSummary = String(payload.summary); ticket.invoiceReference = String(payload.reference || ''); ticket.status = 'completion_submitted'; break;
      case 'verify':
        require((customer || admin) && ['completion_submitted', 'disputed'].includes(ticket.status), 'Completion is not ready for verification.');
        require(ticket.status !== 'disputed' || admin, 'An administrator must resolve this dispute.');
        require(!admin || String(payload.reason || '').trim().length > 5, 'A documented reason is required for an administrator override.');
        require(ticket.invoice.length > 0, 'The provider must submit a final invoice first.');
        ticket.status = 'completed'; ticket.completedAt = now; ticket.dueAt = paymentDue(now); ticket.paymentStatus = 'scheduled'; break;
      case 'cancel': require((customer || admin) && ['open', 'claimed', 'estimated', 'authorized'].includes(ticket.status), 'This ticket cannot be cancelled.'); require(String(payload.reason || '').trim().length > 5, 'Provide a cancellation reason.'); ticket.status = 'cancelled'; ticket.fundingAuthorized = false; break;
      case 'dispute': require((customer || admin) && ['in_progress', 'completion_submitted'].includes(ticket.status), 'This ticket cannot be disputed at this stage.'); require(String(payload.reason || '').trim().length > 5, 'Provide a dispute reason.'); ticket.status = 'disputed'; break;
      case 'resolve_dispute': require(admin && ticket.status === 'disputed', 'Only an administrator can resolve a dispute.'); require(String(payload.reason || '').trim().length > 5, 'Document the dispute resolution.'); ticket.status = ticket.invoice.length ? 'completion_submitted' : 'in_progress'; break;
      case 'pay': require(admin && ticket.status === 'completed' && ticket.paymentStatus === 'scheduled', 'Only scheduled payments can be marked paid.'); require(String(payload.reference || '').trim().length > 2, 'Enter a payment reference.'); ticket.paymentStatus = 'paid'; ticket.paidAt = now; ticket.paymentReference = String(payload.reference); break;
      case 'hold': require(admin && ['scheduled', 'on_hold'].includes(ticket.paymentStatus), 'Only unpaid scheduled payments can be held or released.'); require(String(payload.reason || '').trim().length > 5, 'Document the reason for this payment change.'); ticket.paymentStatus = ticket.paymentStatus === 'on_hold' ? 'scheduled' : 'on_hold'; break;
      default: throw new Error('Unknown action.');
    }
    if (ticket.status === 'estimated' && ticket.customerConsent && ticket.fundingAuthorized) ticket.status = 'authorized';
    const message = `${ticket.title}: ${action.type === 'pay' ? 'payment recorded' : statusLabel[ticket.status].toLowerCase()}.`;
    [ticket.customerId, ticket.providerId, ...state.profiles.filter(p => p.role === 'admin').map(p => p.id)].filter((id): id is string => !!id && id !== actorId).forEach(id => notify(id, message, ticket.id));
  }
  state.audit.unshift({ id: uid(), ticketId: action.ticketId || null, actorId, action: `${action.type}${payload.reason ? ': ' + payload.reason : ''}${action.profileId ? ' · ' + action.profileId : ''}`, at: now });
  return state;
}
