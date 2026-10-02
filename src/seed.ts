import type { Profile, Ticket, Workspace } from './domain';
import { TERMS_VERSION, paymentDue } from './domain';

const ago = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
const profile = (id: string, name: string, role: Profile['role'], extras: Partial<Profile> = {}): Profile => ({ id, name, role, email: `${name.split(' ')[0].toLowerCase()}@example.com`, phone: '(206) 555-0142', city: 'Seattle', zip: '98103', approval: 'approved', funding: 250000, fundingReference: 'DEMO-WA-2026', business: '', service: 'either', specialty: 'General repair', termsAt: null, termsVersion: null, address: '', credential: '', ...extras });
const ticket = (id: string, title: string, vehicle: string, category: string, extras: Partial<Ticket> = {}): Ticket => ({ id, title, vehicle, category, customerId: 'customer-1', providerId: null, description: 'I rely on my car to get to work and would appreciate a diagnosis and repair. The issue started earlier this week.', mileage: 112400, city: 'Seattle', zip: '98103', service: 'either', drivable: true, availability: 'Weekdays after 3 pm, or Saturday morning', status: 'open', createdAt: ago(0), estimate: [], customerConsent: false, fundingAuthorized: false, completionSummary: '', invoice: [], completedAt: null, dueAt: null, paymentStatus: 'not_scheduled', paidAt: null, paymentReference: '', photos: [], invoiceReference: '', ...extras });
export function seed(): Workspace {
  return {
    profiles: [
      profile('provider-1', 'Alex Morgan', 'provider', { business: 'Evergreen Auto Care', termsAt: ago(14), termsVersion: TERMS_VERSION, address: '4801 Aurora Ave N, Seattle, WA', credential: 'Demo registration — not verified' }),
      profile('customer-1', 'Jordan Davis', 'customer'),
      profile('customer-2', 'Sam Rivera', 'customer', { zip: '98115' }),
      profile('customer-3', 'Taylor Kim', 'customer', { approval: 'pending', funding: 0, fundingReference: '' }),
      profile('provider-2', 'Morgan Lee', 'provider', { approval: 'pending', business: 'On the Go Mechanics', service: 'mobile', termsAt: ago(1), termsVersion: TERMS_VERSION, funding: 0 }),
      profile('admin-1', 'Casey Wilson', 'admin', { funding: 0 }),
    ],
    tickets: [
      ticket('AF-1048', 'Front brakes making a grinding noise', '2014 Honda Civic', 'Brakes', { description: 'There is a grinding noise when I brake, especially at low speeds. The brake pedal feels normal but I would like the front pads and rotors checked.', service: 'shop', createdAt: ago(0.03) }),
      ticket('AF-1047', 'Car won’t start — battery check', '2017 Toyota Corolla', 'Electrical', { customerId: 'customer-2', description: 'The dashboard lights come on but the engine only clicks. The car is parked at home and I need someone who can come to me.', service: 'mobile', drivable: false, createdAt: ago(0.1), mileage: 86300 }),
      ticket('AF-1046', 'Check engine light & rough idle', '2015 Ford Focus', 'Engine', { customerId: 'customer-2', createdAt: ago(0.3), mileage: 124500, zip: '98115' }),
      ticket('AF-1045', 'Oil leak inspection', '2012 Subaru Outback', 'General repair', { createdAt: ago(0.8), mileage: 158200, service: 'shop' }),
      ticket('AF-1044', 'Alternator replacement', '2016 Nissan Altima', 'Electrical', { providerId: 'provider-1', status: 'in_progress', createdAt: ago(3), estimate: [{ description: 'Alternator and belt', amount: 34000 }, { description: 'Labor and electrical test', amount: 18000 }], customerConsent: true, fundingAuthorized: true }),
      ticket('AF-1043', 'Replace rear brake pads', '2013 Hyundai Elantra', 'Brakes', { providerId: 'provider-1', customerId: 'customer-2', status: 'completed', createdAt: ago(12), estimate: [{ description: 'Rear brake service', amount: 38500 }], invoice: [{ description: 'Rear brake service', amount: 38500 }], customerConsent: true, fundingAuthorized: true, completedAt: ago(7), dueAt: paymentDue(ago(7)), paymentStatus: 'scheduled', completionSummary: 'Replaced rear pads, inspected rotors, and completed a road test.', invoiceReference: 'INV-DEMO-1043' }),
    ],
    notices: [{ id: 'notice-1', userId: 'provider-1', message: 'New nearby request: Front brakes making a grinding noise', ticketId: 'AF-1048', createdAt: ago(0.03), read: false }, { id: 'notice-2', userId: 'provider-1', message: 'Your provider account is approved. Welcome to Auto Fix!', createdAt: ago(2), read: false }],
    audit: [{ id: 'audit-1', ticketId: 'AF-1043', actorId: 'customer-2', action: 'verify', at: ago(7) }],
  };
}
