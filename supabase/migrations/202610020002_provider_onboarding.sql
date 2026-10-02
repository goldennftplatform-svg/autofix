-- Upgrade existing projects: simpler provider intake and immediate feed refresh.
create or replace function public.onboard(p_data jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_role text := p_data->>'role'; v_field text; v_email text;
begin
  if v_uid is null then raise exception 'Sign in to continue.'; end if;
  if v_role is null or v_role not in ('customer','provider') then raise exception 'Choose customer or service provider.'; end if;
  if exists(select 1 from profiles where id = v_uid) then raise exception 'Your profile already exists.'; end if;
  foreach v_field in array array['name','phone','city','zip'] loop
    if coalesce(length(trim(p_data->>v_field)),0) = 0 or length(p_data->>v_field) > 150 then raise exception 'Please complete %.', v_field; end if;
  end loop;
  if p_data->>'zip' !~ '^[0-9]{5}$' then raise exception 'Enter a five-digit ZIP code.'; end if;
  if v_role = 'provider' then
    if p_data->>'terms' is distinct from 'accepted' then raise exception 'Accept the 32-day payment terms to participate.'; end if;
    if coalesce(p_data->>'service','') not in ('shop','mobile','either') then raise exception 'Select a valid service type.'; end if;
    if coalesce(p_data->>'specialty','') not in ('General repair','Brakes','Engine','Electrical','Tires & suspension','Maintenance') then raise exception 'Select a repair specialty.'; end if;
    if p_data->>'service' <> 'mobile' and coalesce(length(trim(p_data->>'address')),0) < 3 then raise exception 'Enter your shop street address.'; end if;
  end if;
  select email into v_email from auth.users where id = v_uid;
  insert into profiles(id,role,data) values(v_uid,v_role,jsonb_build_object(
    'name',trim(p_data->>'name'),'email',v_email,'phone',p_data->>'phone','city',trim(p_data->>'city'),'zip',p_data->>'zip',
    'business',left(coalesce(nullif(trim(p_data->>'business'),''),trim(p_data->>'name')),150),
    'fundingReference',left(coalesce(p_data->>'reference',''),200),
    'service',coalesce(p_data->>'service','either'),'specialty',coalesce(p_data->>'specialty','General repair'),
    'address',left(coalesce(p_data->>'address',''),300),'credential',left(coalesce(p_data->>'credential',''),300),
    'termsAt',case when v_role = 'provider' then to_jsonb(now()) else 'null'::jsonb end,
    'termsVersion',case when v_role = 'provider' then '2026-10-v1' else null end
  ));
  insert into notifications(user_id,message) values(v_uid,'Application received. We’ll notify you after review.');
  insert into notifications(user_id,message) select id,'New application: ' || (p_data->>'name') from profiles where role = 'admin';
  insert into audit_events(actor_id,action) values(v_uid,'application_submitted');
end $$;

-- Updating a claimed ticket wakes up matching providers' private realtime
-- subscriptions. The ticket is no longer returned by get_workspace, while the
-- assigned provider retains it in My jobs. The ticket record is never deleted.
create function public.notify_claimed_ticket() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.provider_id is null and new.provider_id is not null and old.data->>'status' = 'open' then
    insert into notifications(user_id,message)
      select p.id,'Request taken: ' || (new.data->>'title') || '. Removed from available jobs.'
      from profiles p where p.role = 'provider' and p.approval = 'approved'
      and p.id <> new.provider_id and public.provider_matches(p.data,new.data);
  end if;
  return new;
end $$;
create trigger ticket_claim_notification after update on public.tickets for each row execute function public.notify_claimed_ticket();
revoke execute on function public.notify_claimed_ticket() from public,anon,authenticated;
