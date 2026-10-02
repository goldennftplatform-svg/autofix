-- Auto Fix MVP. Run once in a fresh Supabase project's SQL editor.
-- Every write goes through authenticated, permission-checked RPCs.
create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  role text not null check (role in ('customer','provider','admin')),
  approval text not null default 'pending' check (approval in ('pending','approved','needs_info','rejected')),
  funding bigint not null default 0 check (funding between 0 and 10000000),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table public.tickets (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.profiles(id),
  provider_id uuid references public.profiles(id),
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tickets_customer_idx on public.tickets(customer_id);
create index tickets_provider_idx on public.tickets(provider_id);
create index tickets_status_idx on public.tickets((data->>'status'));
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id),
  ticket_id uuid references public.tickets(id),
  message text not null,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on public.notifications(user_id, created_at desc);
create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references public.profiles(id),
  ticket_id uuid references public.tickets(id),
  action text not null,
  created_at timestamptz not null default now()
);
create index audit_ticket_idx on public.audit_events(ticket_id);

alter table public.profiles enable row level security;
alter table public.tickets enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_events enable row level security;
revoke all on public.profiles, public.tickets, public.notifications, public.audit_events from anon, authenticated;
grant select on public.notifications to authenticated;
create policy "Own notifications only" on public.notifications for select to authenticated using (user_id = (select auth.uid()));
alter publication supabase_realtime add table public.notifications;

create function public.line_total(p_lines jsonb) returns bigint
language plpgsql immutable set search_path = public as $$
declare v_line jsonb; v_sum bigint := 0; v_amount numeric;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 1 or jsonb_array_length(p_lines) > 30 then
    raise exception 'Add between 1 and 30 estimate or invoice lines.';
  end if;
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if coalesce(length(trim(v_line->>'description')), 0) < 1 or length(v_line->>'description') > 500 or jsonb_typeof(v_line->'amount') <> 'number' then
      raise exception 'Each line needs a description and a positive amount.';
    end if;
    v_amount := (v_line->>'amount')::numeric;
    if v_amount is null or v_amount <> trunc(v_amount) or v_amount < 1 or v_amount > 10000000 then raise exception 'Invalid amount. Use integer cents.'; end if;
    v_sum := v_sum + v_amount::bigint;
  end loop;
  return v_sum;
end $$;

create function public.provider_matches(p_profile jsonb, p_ticket jsonb) returns boolean
language sql immutable set search_path = public as $$
  select lower(p_profile->>'city') = lower(p_ticket->>'city')
    and (p_profile->>'service' = 'either' or p_ticket->>'service' = 'either' or p_profile->>'service' = p_ticket->>'service')
    and (p_profile->>'specialty' = 'General repair' or p_profile->>'specialty' = p_ticket->>'category');
$$;

create function public.onboard(p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_role text := p_data->>'role'; v_field text; v_email text;
begin
  if v_uid is null then raise exception 'Sign in to continue.'; end if;
  if v_role is null or v_role not in ('customer','provider') then raise exception 'Choose customer or service provider.'; end if;
  if exists(select 1 from profiles where id = v_uid) then raise exception 'Your profile already exists.'; end if;
  foreach v_field in array array['name','phone','city','zip'] loop
    if coalesce(length(trim(p_data->>v_field)), 0) = 0 or length(p_data->>v_field) > 150 then raise exception 'Please complete %.', v_field; end if;
  end loop;
  if p_data->>'zip' !~ '^[0-9]{5}$' then raise exception 'Enter a five-digit ZIP code.'; end if;
  if v_role = 'provider' then
    if p_data->>'terms' is distinct from 'accepted' then raise exception 'Accept the 32-day payment terms to participate.'; end if;
    if coalesce(p_data->>'service','') not in ('shop','mobile','either') then raise exception 'Select a valid service type.'; end if;
    foreach v_field in array array['business','address','credential','specialty'] loop
      if coalesce(length(trim(p_data->>v_field)), 0) = 0 or length(p_data->>v_field) > 300 then raise exception 'Please complete %.', v_field; end if;
    end loop;
  end if;
  select email into v_email from auth.users where id = v_uid;
  insert into profiles(id, role, data) values (v_uid, v_role, jsonb_build_object(
    'name', trim(p_data->>'name'), 'email', v_email, 'phone', p_data->>'phone', 'city', trim(p_data->>'city'), 'zip', p_data->>'zip',
    'fundingReference', left(coalesce(p_data->>'reference',''), 200), 'business', left(coalesce(p_data->>'business',''), 150),
    'service', coalesce(p_data->>'service','either'), 'specialty', coalesce(p_data->>'specialty','General repair'),
    'address', left(coalesce(p_data->>'address',''),300), 'credential', left(coalesce(p_data->>'credential',''),300),
    'termsAt', case when v_role = 'provider' then to_jsonb(now()) else 'null'::jsonb end,
    'termsVersion', case when v_role = 'provider' then '2026-10-v1' else null end
  ));
  insert into notifications(user_id, message) values(v_uid, 'Your application has been submitted for review.');
  insert into notifications(user_id, message) select id, 'New application: ' || (p_data->>'name') from profiles where role = 'admin';
  insert into audit_events(actor_id, action) values(v_uid, 'application_submitted');
end $$;

create function public.get_workspace() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_actor profiles; v_profiles jsonb; v_tickets jsonb; v_notices jsonb; v_audit jsonb;
begin
  if v_uid is null then raise exception 'Sign in to continue.'; end if;
  select * into v_actor from profiles where id = v_uid;
  if not found then return jsonb_build_object('profiles','[]'::jsonb,'tickets','[]'::jsonb,'notices','[]'::jsonb,'audit','[]'::jsonb); end if;
  select coalesce(jsonb_agg(
    (case when p.id = v_uid or v_actor.role = 'admin' then p.data else jsonb_build_object('name',p.data->>'name','business',p.data->>'business','email',p.data->>'email','phone',p.data->>'phone','city',p.data->>'city','zip',p.data->>'zip') end)
    || jsonb_build_object('id',p.id,'role',p.role,'approval',p.approval,'funding',case when p.id = v_uid or v_actor.role = 'admin' then p.funding else 0 end)
  ),'[]'::jsonb) into v_profiles from profiles p where p.id = v_uid or v_actor.role = 'admin'
    or exists(select 1 from tickets t where (t.customer_id = v_uid and t.provider_id = p.id) or (t.provider_id = v_uid and t.customer_id = p.id));

  select coalesce(jsonb_agg(
    (case when v_actor.role = 'admin' or t.customer_id = v_uid or t.provider_id = v_uid then t.data else
      (t.data - 'availability' - 'photos' - 'completionSummary' - 'invoiceReference' - 'paymentReference') || jsonb_build_object('availability','Shared after assignment','photos','[]'::jsonb,'completionSummary','','invoiceReference','','paymentReference','') end)
    || jsonb_build_object('id',t.id,'customerId',case when v_actor.role = 'admin' or t.customer_id = v_uid or t.provider_id = v_uid then t.customer_id::text else '' end,'providerId',t.provider_id,'createdAt',t.created_at)
    order by t.created_at desc
  ),'[]'::jsonb) into v_tickets from tickets t where v_actor.role = 'admin' or t.customer_id = v_uid or t.provider_id = v_uid
    or (v_actor.role = 'provider' and v_actor.approval = 'approved' and t.data->>'status' = 'open' and provider_matches(v_actor.data, t.data));

  select coalesce(jsonb_agg(jsonb_build_object('id',id,'userId',user_id,'ticketId',ticket_id,'message',message,'createdAt',created_at,'read',is_read) order by created_at desc),'[]'::jsonb)
    into v_notices from (select * from notifications where user_id = v_uid order by created_at desc limit 200) n;
  select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'ticketId',a.ticket_id,'actorId',a.actor_id,'action',a.action,'at',a.created_at) order by a.created_at desc),'[]'::jsonb)
    into v_audit from (select a.* from audit_events a where v_actor.role = 'admin' or a.actor_id = v_uid
      or exists(select 1 from tickets t where t.id = a.ticket_id and (t.customer_id = v_uid or t.provider_id = v_uid)) order by a.created_at desc limit 500) a;
  return jsonb_build_object('profiles',v_profiles,'tickets',v_tickets,'notices',v_notices,'audit',v_audit);
end $$;

create function public.perform_action(p_action text, p_ticket_id uuid default null, p_profile_id uuid default null, p_payload jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_actor profiles; v_owner profiles; v_target profiles; v_ticket tickets;
  v_data jsonb; v_status text; v_now timestamptz := now(); v_due timestamptz;
  v_admin boolean; v_customer boolean; v_provider boolean; v_sum bigint; v_committed bigint;
  v_funding bigint; v_approval text; v_field text; v_photo text; v_customer_id uuid;
begin
  if v_uid is null then raise exception 'Sign in to continue.'; end if;
  select * into v_actor from profiles where id = v_uid;
  if not found then raise exception 'Complete your profile first.'; end if;
  v_admin := v_actor.role = 'admin';
  if p_action = 'read_notices' then update notifications set is_read = true where user_id = v_uid; return;
  elsif p_action = 'accept_terms' then
    if v_actor.role <> 'provider' then raise exception 'Provider access required.'; end if;
    update profiles set data = data || jsonb_build_object('termsAt',v_now,'termsVersion','2026-10-v1') where id = v_uid;
  elsif p_action = 'review_profile' then
    if not v_admin then raise exception 'Administrator access required.'; end if;
    select * into v_target from profiles where id = p_profile_id for update;
    if not found or v_target.role = 'admin' then raise exception 'Application not found.'; end if;
    v_approval := p_payload->>'approval';
    if v_approval is null or v_approval not in ('pending','approved','needs_info','rejected') then raise exception 'Invalid application status.'; end if;
    if (p_payload->>'funding')::numeric <> trunc((p_payload->>'funding')::numeric) then raise exception 'Funding must be integer cents.'; end if;
    v_funding := coalesce((p_payload->>'funding')::bigint,v_target.funding);
    select coalesce(sum(line_total(data->'estimate')),0) into v_committed from tickets where customer_id = p_profile_id and data->>'fundingAuthorized' = 'true' and data->>'status' <> 'cancelled';
    if v_funding < v_committed or v_funding < 0 or v_funding > 10000000 then raise exception 'Funding must cover existing commitments and be within the supported limit.'; end if;
    update profiles set approval = v_approval, funding = v_funding, data = data || jsonb_build_object('fundingReference',left(coalesce(p_payload->>'reference',data->>'fundingReference',''),200)) where id = p_profile_id;
    insert into notifications(user_id,message) values(p_profile_id,'Your application status: ' || replace(v_approval,'_',' ') || '.');
  elsif p_action = 'create_ticket' then
    if v_actor.role <> 'customer' or v_actor.approval <> 'approved' then raise exception 'Your application must be approved before submitting tickets.'; end if;
    foreach v_field in array array['title','description','vehicle','availability','category'] loop
      if coalesce(length(trim(p_payload->>v_field)),0) = 0 or length(p_payload->>v_field) > 3000 then raise exception 'Please complete % (maximum 3000 characters).', v_field; end if;
    end loop;
    if coalesce(p_payload->>'service','') not in ('shop','mobile','either') then raise exception 'Select a service type.'; end if;
    if coalesce(p_payload->>'category','') not in ('General repair','Brakes','Engine','Electrical','Tires & suspension','Maintenance') then raise exception 'Select a repair category.'; end if;
    if coalesce((p_payload->>'mileage')::numeric,-1) < 0 or (p_payload->>'mileage')::numeric > 2000000 then raise exception 'Invalid mileage.'; end if;
    if p_payload->'photos' is not null then
      if jsonb_typeof(p_payload->'photos') <> 'array' or jsonb_array_length(p_payload->'photos') > 3 then raise exception 'Attach no more than three photos.'; end if;
      for v_photo in select jsonb_array_elements_text(p_payload->'photos') loop
        if split_part(v_photo,'/',1) <> v_uid::text or not exists(select 1 from storage.objects where bucket_id = 'repair-photos' and name = v_photo) then raise exception 'Invalid photo attachment.'; end if;
      end loop;
    end if;
    v_data := jsonb_build_object('title',left(p_payload->>'title',140),'description',p_payload->>'description','vehicle',left(p_payload->>'vehicle',100),
      'mileage',(p_payload->>'mileage')::integer,'city',v_actor.data->>'city','zip',v_actor.data->>'zip','service',p_payload->>'service','category',p_payload->>'category',
      'drivable',coalesce((p_payload->>'drivable')::boolean,false),'availability',left(p_payload->>'availability',300),'status','open',
      'estimate','[]'::jsonb,'customerConsent',false,'fundingAuthorized',false,'completionSummary','','invoice','[]'::jsonb,
      'completedAt',null,'dueAt',null,'paymentStatus','not_scheduled','paidAt',null,'paymentReference','','invoiceReference','','photos',coalesce(p_payload->'photos','[]'::jsonb));
    insert into tickets(customer_id,data) values(v_uid,v_data) returning id into p_ticket_id;
    insert into notifications(user_id,ticket_id,message) select id,p_ticket_id,'New nearby request: ' || (v_data->>'title') from profiles
      where role = 'provider' and approval = 'approved' and provider_matches(data,v_data);
    insert into notifications(user_id,ticket_id,message) select id,p_ticket_id,'New repair request: ' || (v_data->>'title') from profiles where role = 'admin';
  else
    -- Consistent lock order: lock the customer's funding row, then the ticket.
    -- This serializes authorizations across ALL tickets sharing a funding balance.
    select customer_id into v_customer_id from tickets where id = p_ticket_id;
    if not found then raise exception 'Ticket not found.'; end if;
    select * into v_owner from profiles where id = v_customer_id for update;
    select * into v_ticket from tickets where id = p_ticket_id for update;
    v_data := v_ticket.data; v_status := v_data->>'status';
    v_customer := v_actor.role = 'customer' and v_ticket.customer_id = v_uid;
    v_provider := coalesce(v_actor.role = 'provider' and v_ticket.provider_id = v_uid and v_actor.approval = 'approved' and v_actor.data->>'termsVersion' = '2026-10-v1',false);
    case p_action
      when 'claim' then
        if v_actor.role <> 'provider' or v_actor.approval <> 'approved' or v_actor.data->>'termsVersion' is distinct from '2026-10-v1' or v_actor.data->>'termsAt' is null then raise exception 'Provider approval and payment-terms acceptance are required.'; end if;
        if v_status <> 'open' or v_ticket.provider_id is not null or not provider_matches(v_actor.data,v_data) then raise exception 'This request is no longer available or outside your service area.'; end if;
        v_ticket.provider_id := v_uid; v_data := v_data || jsonb_build_object('status','claimed');
      when 'estimate' then
        if not v_provider or v_status not in ('claimed','estimated') then raise exception 'Only the assigned provider can submit an estimate before authorization.'; end if;
        perform line_total(p_payload->'lines');
        v_data := v_data || jsonb_build_object('estimate',p_payload->'lines','customerConsent',false,'fundingAuthorized',false,'status','estimated');
      when 'consent' then
        if not v_customer or v_status <> 'estimated' then raise exception 'Only the customer can approve an estimate.'; end if;
        v_data := v_data || jsonb_build_object('customerConsent',true);
      when 'authorize' then
        if not v_admin or v_status <> 'estimated' then raise exception 'Only an administrator can authorize this estimate.'; end if;
        v_sum := line_total(v_data->'estimate');
        select coalesce(sum(line_total(data->'estimate')),0) into v_committed from tickets where customer_id = v_ticket.customer_id and id <> p_ticket_id and data->>'fundingAuthorized' = 'true' and data->>'status' <> 'cancelled';
        if v_owner.approval <> 'approved' or v_sum + v_committed > v_owner.funding then raise exception 'Estimate exceeds available funding or customer approval is missing.'; end if;
        v_data := v_data || jsonb_build_object('fundingAuthorized',true);
      when 'start' then
        if not v_provider or v_status <> 'authorized' or v_data->>'customerConsent' <> 'true' or v_data->>'fundingAuthorized' <> 'true' then raise exception 'Customer consent and funding authorization are required before repairs begin.'; end if;
        v_data := v_data || jsonb_build_object('status','in_progress');
      when 'complete' then
        if not v_provider or v_status <> 'in_progress' then raise exception 'Only an in-progress assigned job can be completed.'; end if;
        if coalesce(length(trim(p_payload->>'summary')),0) < 6 or length(p_payload->>'summary') > 5000 then raise exception 'Describe the completed work (6–5000 characters).'; end if;
        if line_total(p_payload->'lines') > line_total(v_data->'estimate') then raise exception 'The final invoice cannot exceed the approved estimate.'; end if;
        v_data := v_data || jsonb_build_object('invoice',p_payload->'lines','completionSummary',p_payload->>'summary','invoiceReference',left(coalesce(p_payload->>'reference',''),150),'status','completion_submitted');
      when 'verify' then
        if not (v_customer or v_admin) or v_status not in ('completion_submitted','disputed') or (v_status = 'disputed' and not v_admin) then raise exception 'Completion is not ready for verification.'; end if;
        if v_admin and coalesce(length(trim(p_payload->>'reason')),0) < 6 then raise exception 'Document a reason for the administrator override.'; end if;
        perform line_total(v_data->'invoice');
        if v_data->>'completedAt' is not null then raise exception 'Completion has already been verified.'; end if;
        v_due := ((v_now at time zone 'America/Los_Angeles') + interval '32 days') at time zone 'America/Los_Angeles';
        v_data := v_data || jsonb_build_object('status','completed','completedAt',v_now,'dueAt',v_due,'paymentStatus','scheduled');
      when 'cancel' then
        if not (v_customer or v_admin) or v_status not in ('open','claimed','estimated','authorized') then raise exception 'This request cannot be cancelled.'; end if;
        if coalesce(length(trim(p_payload->>'reason')),0) < 6 then raise exception 'Document a cancellation reason.'; end if;
        v_data := v_data || jsonb_build_object('status','cancelled','fundingAuthorized',false);
      when 'dispute' then
        if not (v_customer or v_admin) or v_status not in ('in_progress','completion_submitted') then raise exception 'This request cannot be disputed at this stage.'; end if;
        if coalesce(length(trim(p_payload->>'reason')),0) < 6 then raise exception 'Document the issue for review.'; end if;
        v_data := v_data || jsonb_build_object('status','disputed');
      when 'resolve_dispute' then
        if not v_admin or v_status <> 'disputed' then raise exception 'Only an administrator can resolve a dispute.'; end if;
        if coalesce(length(trim(p_payload->>'reason')),0) < 6 then raise exception 'Document the dispute resolution.'; end if;
        v_data := v_data || jsonb_build_object('status',case when jsonb_array_length(v_data->'invoice') > 0 then 'completion_submitted' else 'in_progress' end);
      when 'pay' then
        if not v_admin or v_status <> 'completed' or v_data->>'paymentStatus' <> 'scheduled' then raise exception 'Only scheduled payments can be marked paid by an administrator.'; end if;
        if coalesce(length(trim(p_payload->>'reference')),0) < 3 then raise exception 'Enter a payment reference.'; end if;
        v_data := v_data || jsonb_build_object('paymentStatus','paid','paidAt',v_now,'paymentReference',left(p_payload->>'reference',200));
      when 'hold' then
        if not v_admin or v_data->>'paymentStatus' not in ('scheduled','on_hold') then raise exception 'Only unpaid scheduled payments can be held or released.'; end if;
        if coalesce(length(trim(p_payload->>'reason')),0) < 6 then raise exception 'Document a reason for the payment change.'; end if;
        v_data := v_data || jsonb_build_object('paymentStatus',case when v_data->>'paymentStatus' = 'on_hold' then 'scheduled' else 'on_hold' end);
      else raise exception 'Unknown operation.';
    end case;
    if v_data->>'status' = 'estimated' and v_data->>'customerConsent' = 'true' and v_data->>'fundingAuthorized' = 'true' then
      v_data := v_data || jsonb_build_object('status','authorized');
    end if;
    update tickets set data = v_data, provider_id = v_ticket.provider_id, updated_at = v_now where id = p_ticket_id;
    insert into notifications(user_id,ticket_id,message) select p.id,p_ticket_id,(v_data->>'title') || ': ' || replace(p_action,'_',' ') || '.' from profiles p
      where p.id <> v_uid and (p.id = v_ticket.customer_id or p.id = v_ticket.provider_id or p.role = 'admin');
  end if;
  insert into audit_events(actor_id,ticket_id,action) values(v_uid,p_ticket_id,p_action || case when p_profile_id is not null then ' · ' || p_profile_id::text else '' end || case when p_payload->>'reason' is not null then ': ' || left(p_payload->>'reason',1000) else '' end);
end $$;

-- Private photos: owner uploads; only owner, assigned provider, or admin can read.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('repair-photos','repair-photos',false,5242880,array['image/jpeg','image/png','image/webp']);
create function public.can_read_photo(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and (
    split_part(p_name,'/',1) = auth.uid()::text
    or exists(select 1 from profiles where id = auth.uid() and role = 'admin')
    or exists(select 1 from tickets where provider_id = auth.uid() and data->'photos' ? p_name)
  );
$$;
create policy "Upload own repair photos" on storage.objects for insert to authenticated with check(bucket_id = 'repair-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Read authorized repair photos" on storage.objects for select to authenticated using(bucket_id = 'repair-photos' and public.can_read_photo(name));

-- Default PostgreSQL function execution is PUBLIC; explicitly narrow the boundary.
revoke execute on function public.line_total(jsonb), public.provider_matches(jsonb,jsonb), public.onboard(jsonb), public.get_workspace(), public.perform_action(text,uuid,uuid,jsonb), public.can_read_photo(text) from public, anon, authenticated;
grant execute on function public.onboard(jsonb), public.get_workspace(), public.perform_action(text,uuid,uuid,jsonb), public.can_read_photo(text) to authenticated;

comment on table public.audit_events is 'Append-only through the application API. Direct client writes are forbidden.';
comment on column public.tickets.data is 'Versioned MVP aggregate: vehicle snapshot, estimate and approvals, final invoice, immutable verified-completion timestamp, payment schedule. Modified only through perform_action.';
