import { useState } from 'react';
import type { FormEvent } from 'react';
import { ArrowLeft, ArrowRight, Check, Clock3, ShieldCheck, Truck, Wrench } from 'lucide-react';

export type Enrollment = Record<string, string>;
const specialties = ['General repair', 'Brakes', 'Engine', 'Electrical', 'Tires & suspension', 'Maintenance'];

export default function OnboardingWizard({ busy, initialRole = 'provider', identity, demo, submit }: {
  busy: boolean;
  initialRole?: string;
  identity?: { name: string; email: string };
  demo: boolean;
  submit: (data: Enrollment) => Promise<boolean>;
}) {
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const [data, setData] = useState<Enrollment>(() => {
    const base = { role: initialRole, service: 'mobile', specialty: 'General repair', name: identity?.name || '', email: identity?.email || '', phone: '', city: '', zip: '', business: '', address: '', credential: '', reference: '', terms: '', review: '' };
    try {
      const draft = JSON.parse(sessionStorage.getItem('autofix-enrollment') || 'null');
      return draft?.role === initialRole ? { ...base, ...draft, email: identity?.email || draft.email, name: identity?.name || draft.name } : base;
    } catch { return base; }
  });
  const provider = data.role === 'provider';
  const update = (key: string, value: string) => {
    const next = { ...data, [key]: value };
    setData(next);
    sessionStorage.setItem('autofix-enrollment', JSON.stringify(next));
  };
  const field = (key: string) => ({ value: data[key] || '', onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => update(key, e.target.value) });
  const advance = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setError('');
    if (step < 2) { setStep(step + 1); return; }
    try {
      if (await submit({ ...data, business: data.business.trim() || data.name.trim() })) sessionStorage.removeItem('autofix-enrollment');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not submit. Please try again.'); }
  };
  return <div className="enrollment">
    <div className="enrollment-intro"><span className="large-icon">{provider ? <Wrench /> : <ShieldCheck />}</span><h2>{provider ? 'Your next job starts here.' : 'Let’s get you back on the road.'}</h2><p>{provider ? 'Mobile mechanic or repair shop? Three simple steps to join.' : 'Three simple steps to apply for repair assistance.'}</p></div>
    {demo && <p className="enrollment-demo">Demo application · Use sample details. No real account is created.</p>}
    <ol className="enrollment-steps" aria-label="Application progress">{['Your details', provider ? 'Your service' : 'Your location', 'Review & submit'].map((label, index) => <li key={label} className={index === step ? 'current' : index < step ? 'done' : ''} aria-current={index === step ? 'step' : undefined}><span>{index < step ? <Check size={14} /> : index + 1}</span>{label}</li>)}</ol>
    <form className="form-stack" onSubmit={advance}>
      {step === 0 && <>
        <label className="field">I’m joining as<select {...field('role')}><option value="provider">A mechanic or repair shop</option><option value="customer">A customer who needs a repair</option></select></label>
        <div className="form-grid"><label className="field">Your full name<input {...field('name')} autoComplete="name" required maxLength={120} placeholder="Alex Morgan" /></label><label className="field">Phone number<input {...field('phone')} type="tel" autoComplete="tel" required minLength={7} maxLength={30} placeholder="(206) 555-0123" /></label></div>
        <label className="field">Email address<input {...field('email')} type="email" autoComplete="email" required readOnly={!demo && !!identity?.email} placeholder="you@example.com" /></label>
        {provider && <label className="field">Business name (optional)<input {...field('business')} autoComplete="organization" maxLength={150} placeholder="Use your own name if you work independently" /></label>}
      </>}
      {step === 1 && <>
        {provider && <fieldset className="service-choices"><legend>How do you service vehicles?</legend>{[{ value: 'mobile', icon: Truck, title: 'Mobile mechanic', text: 'I go to the customer.' }, { value: 'shop', icon: Wrench, title: 'Repair shop', text: 'Customers visit my shop.' }, { value: 'either', icon: ShieldCheck, title: 'Both', text: 'I offer both options.' }].map(option => <label key={option.value} className={data.service === option.value ? 'chosen' : ''}><input type="radio" name="service" value={option.value} checked={data.service === option.value} onChange={e => update('service', e.target.value)} /><option.icon size={23} /><strong>{option.title}</strong><small>{option.text}</small></label>)}</fieldset>}
        <div className="form-grid"><label className="field">City in Washington<input {...field('city')} required autoComplete="address-level2" maxLength={100} placeholder="Seattle" /></label><label className="field">ZIP code<input {...field('zip')} required autoComplete="postal-code" inputMode="numeric" pattern="[0-9]{5}" maxLength={5} placeholder="98103" /></label></div>
        {provider ? <>
          <p className="form-hint">We’ll match available tickets to this city and your service type.</p>
          {data.service !== 'mobile' && <label className="field">Shop street address<input {...field('address')} autoComplete="street-address" required maxLength={300} placeholder="4801 Aurora Ave N" /></label>}
          <label className="field">What do you work on?<select {...field('specialty')}>{specialties.map(s => <option key={s}>{s}</option>)}</select></label>
          <label className="field">Registration or credential reference (optional)<input {...field('credential')} maxLength={300} placeholder="You can provide this during review" /></label>
        </> : <label className="field">Program or referral reference (optional)<input {...field('reference')} maxLength={200} placeholder="If your program gave you a reference" /></label>}
      </>}
      {step === 2 && <>
        <div className="enrollment-review"><h3>Looking good, {data.name.split(' ')[0]}.</h3><dl><dt>Contact</dt><dd>{data.name}<br />{data.email}<br />{data.phone}</dd><dt>{provider ? 'Service area' : 'Location'}</dt><dd>{data.city}, WA {data.zip}</dd>{provider && <><dt>Provider</dt><dd>{data.business || data.name} · {data.service === 'mobile' ? 'Mobile mechanic' : data.service === 'shop' ? 'Repair shop' : 'Shop & mobile'}</dd><dt>Specialty</dt><dd>{data.specialty}</dd></>}</dl></div>
        {provider && <div className="enrollment-payment"><Clock3 size={25} /><div><h3>Payment: 32 days after verified completion</h3><p>Plan for this waiting period. Funding needs approximately 30 days to process. Your dashboard shows the scheduled payment date; payment remains subject to authorized funding and program terms.</p></div></div>}
        {provider && <label className="checkbox-field"><input type="checkbox" checked={data.terms === 'accepted'} onChange={e => update('terms', e.target.checked ? 'accepted' : '')} required />I accept the 32-calendar-day payment schedule after verified completion, subject to funding authorization and program terms.</label>}
        <label className="checkbox-field"><input type="checkbox" checked={data.review === 'accepted'} onChange={e => update('review', e.target.checked ? 'accepted' : '')} required />I understand my application must be approved before I can {provider ? 'claim repair jobs' : 'submit repair tickets'}.</label>
        <div className="enrollment-next"><ShieldCheck size={18} /><p><strong>What happens next?</strong> Our team reviews your application. You’ll see the decision in your dashboard and notifications. {provider ? 'Once approved: find a ticket → claim it → manage it in My jobs.' : 'Once approved, you can create your first repair request.'}</p></div>
      </>}
      {error && <p role="alert" className="error-message">{error}</p>}
      <div className="enrollment-actions">{step > 0 && <button className="button secondary" type="button" disabled={busy} onClick={() => setStep(step - 1)}><ArrowLeft size={16} /> Back</button>}<button className="button" type="submit" disabled={busy}>{busy ? 'Submitting…' : step === 2 ? 'Submit application' : 'Continue'}{!busy && <ArrowRight size={16} />}</button></div>
      <p className="form-hint centered">Step {step + 1} of 3 · You can go back to change your details.</p>
    </form>
  </div>;
}
